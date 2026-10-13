"""
Automatic dashboards.

Claude Haiku 5.5 designs a dashboard once from a cheap profile of one table
(KPIs, charts, filter columns, each backed by a read-only SQL query). The spec is
saved, and every later view or filter change just re-runs that SQL — no LLM call.

Queries are written against a ``src`` placeholder. At run time ``src`` becomes a
CTE over the chosen table with the active filters applied through bound
parameters, so filters reach every tile and user values never touch the SQL text.

Specs live in ``data/dashboards/`` (deliberately not under the publicly served
``outputs/``) because a custom database URI may carry credentials.
"""

import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import pandas as pd
from sqlalchemy import inspect as sa_inspect, text

from features.deeper import _engine, _resolve_db_uri

DASH_DIR = Path(__file__).resolve().parent.parent / "data" / "dashboards"
DASH_DIR.mkdir(parents=True, exist_ok=True)

MAX_KPIS, MAX_CHARTS, MAX_FILTERS = 6, 8, 4
MAX_ROWS = 500                 # rows returned per chart
PROFILE_SAMPLE = 20000         # rows sampled to profile columns
CATEGORY_MAX = 30              # a column with <= this many distinct values is a category

_BANNED = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|attach|"
    r"detach|pragma|vacuum|copy|call|execute|do)\b|--|/\*|;", re.IGNORECASE)
_SAFE_ID = re.compile(r"^[A-Za-z0-9_]{1,40}$")


class DashboardError(ValueError):
    pass


# ── Source resolution & profiling ─────────────────────────────────────────────

def _q(name: str) -> str:
    """Double-quote an identifier (valid in PostgreSQL and SQLite); "schema.table" → "schema"."table"."""
    return ".".join('"' + part.replace('"', '""') + '"' for part in name.split("."))


def _pick_table(engine, table: Optional[str]) -> str:
    tables = sa_inspect(engine).get_table_names()
    if not tables:
        raise DashboardError("No tables found in the target database.")
    if not table and engine.dialect.name == "postgresql":
        # After a dbt build the connection's search_path starts with the tested marts
        # (uaa_marts, uaa_staging, public); prefer the first schema on it that has tables.
        with engine.connect() as c:
            rows = c.execute(text(
                "SELECT t.table_schema, t.table_name FROM information_schema.tables t "
                "JOIN unnest(current_schemas(false)) WITH ORDINALITY AS s(name, pos) ON s.name = t.table_schema "
                "ORDER BY s.pos")).fetchall()
        if rows:
            first = rows[0][0]
            tables = [r[1] for r in rows if r[0] == first]
    if not table:
        # The label-encoder agent writes an all-numeric "<table>_encoded" copy with the same
        # row count; it would tie for "largest" but makes a poor dashboard.
        tables = [t for t in tables if not t.endswith("_encoded")] or tables
    if table:
        if "." in table:                     # schema-qualified, e.g. uaa_marts.fct_orders
            schema, name = table.split(".", 1)
            insp = sa_inspect(engine)
            if name not in insp.get_table_names(schema=schema) + insp.get_view_names(schema=schema):
                raise DashboardError(f"Table '{table}' not found.")
            return table
        if table not in tables:
            raise DashboardError(f"Table '{table}' not found. Available: {tables[:20]}")
        return table
    if len(tables) == 1:
        return tables[0]
    # Default to the largest table — usually the fact table worth a dashboard. Ties are common
    # between a bare fact table and a joined reporting view of it (same row count); the one
    # with more columns is far richer to chart, so it wins.
    with engine.connect() as c:
        sizes = {}
        for t in tables[:20]:
            try:
                rows = c.execute(text(f"SELECT COUNT(*) FROM {_q(t)}")).scalar() or 0
                cols = len(sa_inspect(engine).get_columns(t)) if engine.dialect.name != "postgresql" else \
                    c.execute(text("SELECT COUNT(*) FROM information_schema.columns WHERE table_name = :t "
                                   "AND table_schema = ANY(current_schemas(false))"), {"t": t}).scalar() or 0
                sizes[t] = (rows, cols)
            except Exception:
                c.rollback()
                sizes[t] = (-1, 0)
    return max(sizes, key=sizes.get)


def profile_table(engine, table: str) -> dict:
    """Column-level profile used as Claude's context."""
    with engine.connect() as c:
        row_count = c.execute(text(f"SELECT COUNT(*) FROM {_q(table)}")).scalar() or 0
    df = pd.read_sql(text(f"SELECT * FROM {_q(table)} LIMIT {PROFILE_SAMPLE}"), engine)

    columns = []
    for col in df.columns:
        s = df[col]
        nunique = int(s.nunique(dropna=True))
        info = {"name": col, "dtype": str(s.dtype), "nulls": int(s.isna().sum()), "distinct": nunique}
        if pd.api.types.is_numeric_dtype(s) and nunique > CATEGORY_MAX:
            info.update(kind="numeric", min=_num(s.min()), max=_num(s.max()), mean=_num(s.mean()))
        elif nunique <= CATEGORY_MAX:
            info.update(kind="category", values=[_num(v) for v in s.dropna().value_counts().index.tolist()])
        elif _looks_like_date(s):
            d = pd.to_datetime(s, errors="coerce")
            info.update(kind="date", min=str(d.min())[:10], max=str(d.max())[:10])
        else:
            info["kind"] = "text"   # ids, free text — not useful to chart
        columns.append(info)
    return {"table": table, "row_count": int(row_count), "columns": columns}


def _num(v):
    try:
        f = float(v)
        return int(f) if f.is_integer() else round(f, 4)
    except (TypeError, ValueError):
        return str(v)


def _looks_like_date(s: pd.Series) -> bool:
    if pd.api.types.is_datetime64_any_dtype(s):
        return True
    if s.dtype != object:
        return False
    sample = s.dropna().astype(str).head(50)
    return len(sample) > 0 and pd.to_datetime(sample, errors="coerce").notna().mean() > 0.9


def _profile_text(p: dict) -> str:
    lines = [f'Table "{p["table"]}" — {p["row_count"]:,} rows. Columns:']
    for c in p["columns"]:
        if c["kind"] == "numeric":
            d = f'numeric, range {c["min"]}–{c["max"]}, mean {c["mean"]}'
        elif c["kind"] == "category":
            d = f'category ({c["distinct"]} values): ' + ", ".join(map(str, c["values"][:12]))
        elif c["kind"] == "date":
            d = f'date, {c["min"]} to {c["max"]}'
        else:
            d = f'text/id ({c["distinct"]} distinct)'
        lines.append(f'- "{c["name"]}": {d}')
    return "\n".join(lines)


# ── Claude design call ─────────────────────────────────────────────────────────

_FORMATS = ["number", "percent", "currency", "decimal"]
_TOOL = {
    "name": "build_dashboard",
    "description": "Return the dashboard specification.",
    "input_schema": {
        "type": "object",
        "properties": {
            "title":   {"type": "string", "description": "Short dashboard title (max 6 words)."},
            "currency": {"type": "string", "description": "ISO code of the money columns' currency, inferred "
                         "from column names/values (e.g. *_idr → IDR). Empty if unknown — never assume USD."},
            "summary": {"type": "string", "description": "One sentence on what the dashboard monitors."},
            "kpis": {
                "type": "array", "maxItems": MAX_KPIS,
                "items": {
                    "type": "object",
                    "properties": {
                        "label":  {"type": "string"},
                        "sql":    {"type": "string", "description": "Returns exactly one row with one column named value."},
                        "format": {"type": "string", "enum": _FORMATS},
                        "note":   {"type": "string", "description": "Under 12 words: what the number means."},
                    },
                    "required": ["label", "sql", "format"],
                },
            },
            "charts": {
                "type": "array", "maxItems": MAX_CHARTS,
                "items": {
                    "type": "object",
                    "properties": {
                        "title":    {"type": "string"},
                        "type":     {"type": "string", "enum": ["bar", "hbar", "line", "pie", "table"]},
                        "sql":      {"type": "string"},
                        "x":        {"type": "string", "description": "Result column for the category/time axis (label for pie)."},
                        "y":        {"type": "array", "items": {"type": "string"}, "description": "Result column(s) with the plotted values."},
                        "y_format": {"type": "string", "enum": _FORMATS},
                        "note":     {"type": "string", "description": "Under 15 words: the question this chart answers."},
                    },
                    "required": ["title", "type", "sql", "x", "y"],
                },
            },
            "filters": {
                "type": "array", "maxItems": MAX_FILTERS, "items": {"type": "string"},
                "description": "Names of category columns users can filter by.",
            },
        },
        "required": ["title", "summary", "kpis", "charts", "filters"],
    },
}

_RULES = """Rules for every SQL query:
- Query ONLY the relation named src (e.g. FROM src). Never name the real table.
- Read-only SELECT (or WITH … SELECT). One statement, no semicolon, no comments.
- Wrap every column name in double quotes exactly as in the profile.
- Must run on both PostgreSQL and SQLite: use CASE WHEN, COUNT, SUM, AVG, MIN, MAX and
  multiply by 1.0 for decimal division. Never use ROUND (the dashboard formats numbers),
  CAST, ILIKE, FILTER (WHERE …), ::casts or date functions.
- Percent values must be on a 0–100 scale (e.g. 100.0 * SUM(CASE…) / COUNT(*)).
- KPI queries return one row with one column aliased value.
- Chart queries alias columns to simple snake_case names and use those in x / y.
- Order bar charts by value descending; keep at most 20 categories (LIMIT 20)."""


def _ask_claude(system: str, user: str) -> dict:
    from config import ANTHROPIC_MODEL, CLAUDE_THINKING, LLMUnavailableError, anthropic_client
    if anthropic_client is None:
        raise LLMUnavailableError("ANTHROPIC_API_KEY is not set")
    resp = anthropic_client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=4096,
        thinking=CLAUDE_THINKING,
        system=system,
        tools=[_TOOL],
        tool_choice={"type": "tool", "name": "build_dashboard"},
        messages=[{"role": "user", "content": user}],
    )
    for block in resp.content:
        if getattr(block, "type", "") == "tool_use":
            spec = dict(block.input)
            spec["_usage"] = {"input_tokens": resp.usage.input_tokens,
                              "output_tokens": resp.usage.output_tokens}
            return spec
    raise LLMUnavailableError("Claude did not return a dashboard specification")


def _design(profile: dict, brief: str) -> dict:
    system = (
        "You are a senior BI analyst designing an at-a-glance dashboard for business "
        "leaders. Pick the metrics that matter for this data — usually the outcome rate, "
        "volume and value at risk — then charts that explain what drives them. Prefer a "
        "few strong tiles over many weak ones. Ignore id/free-text columns.\n\n" + _RULES
    )
    user = _profile_text(profile)
    if brief.strip():
        user += f"\n\nThe user wants the dashboard to focus on: {brief.strip()}"
    user += (f"\n\nDesign 3–{MAX_KPIS} KPIs, 4–{MAX_CHARTS} charts and up to {MAX_FILTERS} "
             "filters (category columns only).")
    return _ask_claude(system, user)


def _repair(profile: dict, spec: dict, failures: list) -> dict:
    """One extra call that rewrites only the tiles whose SQL failed."""
    system = "You fix SQL in a dashboard specification.\n\n" + _RULES
    user = (
        _profile_text(profile)
        + "\n\nThese tiles failed when executed:\n"
        + "\n".join(f'- [{f["kind"]}] "{f["title"]}": {f["sql"]}\n  error: {f["error"]}' for f in failures)
        + "\n\nReturn the full specification again with those tiles fixed (drop any that "
          "cannot be expressed). Keep every working tile unchanged.\n\nCurrent spec:\n"
        + json.dumps(spec, ensure_ascii=False)
    )
    return _ask_claude(system, user)


# ── Execution ─────────────────────────────────────────────────────────────────

def _check_sql(sql: str) -> str:
    s = sql.strip().rstrip(";").strip()
    if not re.match(r"(?is)^(select|with)\b", s):
        raise DashboardError("only SELECT queries are allowed")
    if _BANNED.search(s):
        raise DashboardError("query contains a forbidden keyword or token")
    if not re.search(r"(?i)\bsrc\b", s):
        raise DashboardError("query must read from src")
    return s


def _wrap(sql: str, table: str, where: str) -> str:
    """Prefix the tile query with the src CTE (merging with its own WITH clause)."""
    cte = f"src AS (SELECT * FROM {_q(table)}{where})"
    m = re.match(r"(?is)^with\s+(recursive\s+)?", sql)
    if m:
        return f"WITH {m.group(1) or ''}{cte}, {sql[m.end():]}"
    return f"WITH {cte} {sql}"


def _where(filters: dict, allowed: dict) -> tuple:
    """Build a parameterised WHERE from {column: [values]}; only known columns/values pass."""
    clauses, params = [], {}
    for i, (col, values) in enumerate((filters or {}).items()):
        if col not in allowed:
            continue
        values = values if isinstance(values, list) else [values]
        values = [str(v) for v in values if str(v) in allowed[col]][:50]
        if not values:
            continue
        names = []
        for j, v in enumerate(values):
            params[f"f{i}_{j}"] = allowed[col][v]   # original typed value
            names.append(f":f{i}_{j}")
        clauses.append(f"{_q(col)} IN ({', '.join(names)})")
    return (" WHERE " + " AND ".join(clauses)) if clauses else "", params


def _run_tile(engine, sql: str, table: str, where: str, params: dict) -> pd.DataFrame:
    full = _wrap(_check_sql(sql), table, where)
    if not re.search(r"(?i)\blimit\s+\d+\s*$", full):
        full = f"{full} LIMIT {MAX_ROWS}"
    return pd.read_sql(text(full), engine, params=params)


def _records(df: pd.DataFrame) -> list:
    return json.loads(df.head(MAX_ROWS).to_json(orient="records", date_format="iso", default_handler=str))


def _validate(engine, spec: dict, table: str) -> list:
    """Test-run every tile unfiltered; return the failures."""
    failures = []
    for kind in ("kpis", "charts"):
        for tile in spec.get(kind, []):
            try:
                df = _run_tile(engine, tile["sql"], table, "", {})
                if kind == "kpis" and df.empty:
                    raise DashboardError("KPI query returned no rows")
                if kind == "charts":
                    missing = [c for c in [tile.get("x"), *tile.get("y", [])] if c and c not in df.columns]
                    if missing:
                        raise DashboardError(f"result has no column(s) {missing}; got {list(df.columns)}")
            except Exception as e:
                failures.append({"kind": kind[:-1], "title": tile.get("label") or tile.get("title", "?"),
                                 "sql": tile.get("sql", ""), "error": str(e).split("\n")[0][:300]})
    return failures


def _clean_spec(spec: dict, profile: dict) -> dict:
    cats = {c["name"] for c in profile["columns"] if c["kind"] == "category"}
    out = {
        "title":   str(spec.get("title") or "Dashboard")[:80],
        "summary": str(spec.get("summary") or "")[:300],
        "currency": re.sub(r"[^A-Z]", "", str(spec.get("currency") or "").upper())[:3],
        "kpis":    [k for k in spec.get("kpis", []) if isinstance(k, dict) and k.get("sql")][:MAX_KPIS],
        "charts":  [c for c in spec.get("charts", []) if isinstance(c, dict) and c.get("sql")][:MAX_CHARTS],
        "filters": [f for f in spec.get("filters", []) if f in cats][:MAX_FILTERS],
    }
    for i, k in enumerate(out["kpis"]):
        k["id"] = f"k{i}"
    for i, c in enumerate(out["charts"]):
        c["id"] = f"c{i}"
        if isinstance(c.get("y"), str):
            c["y"] = [c["y"]]
    return out


# ── Public API ────────────────────────────────────────────────────────────────

def _path(dash_id: str) -> Path:
    if not _SAFE_ID.match(dash_id or ""):
        raise DashboardError("invalid dashboard id")
    return DASH_DIR / f"{dash_id}.json"


def public(record: dict) -> dict:
    """Drop the database URI (may hold credentials) before returning to clients."""
    r = {k: v for k, v in record.items() if k != "source"}
    r["source"] = {"table": record["source"]["table"], "label": record["source"].get("label")}
    return r


def create_dashboard(db_uri: str = "", table: Optional[str] = None, brief: str = "",
                     source_label: str = "") -> dict:
    """Profile → one Claude design call (+ at most one repair call) → validated, saved spec."""
    engine = _engine(_resolve_db_uri(db_uri))
    table = _pick_table(engine, table)
    profile = profile_table(engine, table)

    raw = _design(profile, brief)
    usage = [raw.pop("_usage", {})]
    spec = _clean_spec(raw, profile)

    failures = _validate(engine, spec, table)
    first_failures = failures
    if failures:
        fixed = _repair(profile, spec, failures)
        usage.append(fixed.pop("_usage", {}))
        spec = _clean_spec(fixed, profile)
        failures = _validate(engine, spec, table)
        bad = {f["title"] for f in failures}
        spec["kpis"] = [k for k in spec["kpis"] if k["label"] not in bad]
        spec["charts"] = [c for c in spec["charts"] if c["title"] not in bad]
    if not spec["kpis"] and not spec["charts"]:
        raise DashboardError("Claude could not produce any working dashboard tiles for this table.")

    dash_id = uuid.uuid4().hex[:12]
    record = {
        "id": dash_id,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "brief": brief,
        "source": {"db_uri": db_uri, "table": table, "label": source_label or table},
        "spec": spec,
        "repaired": [{"title": f["title"], "error": f["error"]} for f in first_failures],
        "dropped": [{"title": f["title"], "error": f["error"]} for f in failures],
        "llm_usage": {
            "calls": len(usage),
            "input_tokens": sum(u.get("input_tokens", 0) for u in usage),
            "output_tokens": sum(u.get("output_tokens", 0) for u in usage),
        },
    }
    _path(dash_id).write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return public(record)


def load_dashboard(dash_id: str) -> dict:
    p = _path(dash_id)
    if not p.exists():
        raise FileNotFoundError(f"Dashboard {dash_id} not found")
    return json.loads(p.read_text(encoding="utf-8"))


def list_dashboards() -> list:
    out = []
    for p in sorted(DASH_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            r = json.loads(p.read_text(encoding="utf-8"))
            out.append({"id": r["id"], "title": r["spec"]["title"], "created_at": r["created_at"],
                        "table": r["source"]["table"], "label": r["source"].get("label"),
                        "tiles": len(r["spec"]["kpis"]) + len(r["spec"]["charts"])})
        except Exception:
            continue
    return out


def delete_dashboard(dash_id: str) -> None:
    p = _path(dash_id)
    if p.exists():
        p.unlink()


def dashboard_data(dash_id: str, filters: Optional[dict] = None) -> dict:
    """Run every tile with the given filters. No LLM involved."""
    record = load_dashboard(dash_id)
    spec, table = record["spec"], record["source"]["table"]
    engine = _engine(_resolve_db_uri(record["source"]["db_uri"]))

    # Filter options come from the live data. Incoming values are matched as strings
    # and mapped back to their typed originals so the bound params compare correctly.
    options, allowed = {}, {}
    with engine.connect() as c:
        for col in spec["filters"]:
            try:
                rows = c.execute(text(
                    f"SELECT {_q(col)} AS v, COUNT(*) AS n FROM {_q(table)} "
                    f"WHERE {_q(col)} IS NOT NULL GROUP BY {_q(col)} ORDER BY n DESC LIMIT 50"
                )).fetchall()
            except Exception:
                continue
            options[col] = [{"value": str(r[0]), "count": int(r[1])} for r in rows]
            allowed[col] = {str(r[0]): r[0] for r in rows}

    where, params = _where(filters or {}, allowed)

    kpis = []
    for k in spec["kpis"]:
        try:
            df = _run_tile(engine, k["sql"], table, where, params)
            v = df.iloc[0, 0] if not df.empty else None
            kpis.append({"id": k["id"], "value": None if v is None or pd.isna(v) else _num(v)})
        except Exception as e:
            kpis.append({"id": k["id"], "value": None, "error": str(e).split("\n")[0][:200]})

    charts = []
    for ch in spec["charts"]:
        try:
            charts.append({"id": ch["id"], "rows": _records(_run_tile(engine, ch["sql"], table, where, params))})
        except Exception as e:
            charts.append({"id": ch["id"], "rows": [], "error": str(e).split("\n")[0][:200]})

    with engine.connect() as c:
        matched = c.execute(text(f"WITH src AS (SELECT * FROM {_q(table)}{where}) SELECT COUNT(*) FROM src"),
                            params).scalar()

    applied = {}
    for col, vals in (filters or {}).items():
        if col in allowed:
            vals = vals if isinstance(vals, list) else [vals]
            kept = [str(v) for v in vals if str(v) in allowed[col]]
            if kept:
                applied[col] = kept

    return {"id": dash_id, "filters": options, "applied": applied, "row_count": int(matched or 0),
            "kpis": kpis, "charts": charts, "refreshed_at": datetime.now().isoformat(timespec="seconds")}
