"""
features/metrics.py – the semantic layer: business metrics defined once, used by every feature.

A metric: {id, name, aliases[], description, expression (one SQL aggregate, e.g. SUM(net_revenue)),
filter (optional SQL condition, e.g. status = 'paid'), table_hint, format (number|currency|percent),
currency, created_at, updated_at}. Stored in data/metrics/metrics.json.

`prompt_text()` is injected into Data chat, Agent, Auto Dashboard, Analytics runs and the Workflow builder, so
"revenue" / "omzet" / "active customer" mean exactly the same thing everywhere.
Security: expression and filter are parsed inside `SELECT <expr> FROM t WHERE <filter>` and checked by
tools/sql_guard (one SELECT, only table t, no dangerous functions); the expression must aggregate.
Definitions are fenced as data in prompts.
"""

import json
import re
import threading
import uuid
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "data" / "metrics" / "metrics.json"
FORMATS = ("number", "currency", "percent")
MAX_METRICS = 200
_lock = threading.Lock()
_AGG = re.compile(r"\b(sum|count|avg|min|max|median|stddev|variance)\s*\(", re.I)


class MetricError(ValueError):
    pass


def _load() -> list:
    try:
        return json.loads(STORE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save(items: list) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STORE)


def validate(expression: str, flt: str = "") -> None:
    """Raise MetricError unless `expression` is one safe aggregate and `flt` a safe condition."""
    from tools.sql_guard import SQLGuardError, check_select
    expr = (expression or "").strip()
    if not expr:
        raise MetricError("Write the formula, e.g. SUM(net_revenue) or COUNT(DISTINCT customer_id).")
    if not _AGG.search(expr):
        raise MetricError("The formula must aggregate (SUM, COUNT, AVG, MIN, MAX…), e.g. SUM(net_revenue).")
    if re.search(r"\bselect\b|;|--|/\*", f"{expr} {flt or ''}", re.I):
        raise MetricError("Use a formula and a condition only — no SELECT, semicolons or comments.")
    sql = f"SELECT {expr} AS value FROM t" + (f" WHERE {flt}" if (flt or "").strip() else "")
    try:
        check_select(sql, "postgres", allowed_tables=["t"])
    except SQLGuardError as e:
        raise MetricError(f"Formula not allowed: {e}")


def _clean(d: dict, old: dict = None) -> dict:
    name = re.sub(r"\s+", " ", str(d.get("name") or "")).strip()[:80]
    if not name:
        raise MetricError("Give the metric a name.")
    expr = str(d.get("expression") or "").strip()[:600]
    flt = str(d.get("filter") or "").strip()[:600]
    validate(expr, flt)
    aliases = [re.sub(r"\s+", " ", str(a)).strip()[:60] for a in (d.get("aliases") or []) if str(a).strip()][:12]
    now = datetime.now().isoformat(timespec="seconds")
    return {"id": (old or {}).get("id") or uuid.uuid4().hex[:10], "name": name, "aliases": aliases,
            "description": str(d.get("description") or "").strip()[:600], "expression": expr, "filter": flt,
            "table_hint": str(d.get("table_hint") or "").strip()[:120],
            "format": d.get("format") if d.get("format") in FORMATS else "number",
            "currency": re.sub(r"[^A-Z]", "", str(d.get("currency") or "").upper())[:3],
            "created_at": (old or {}).get("created_at") or now, "updated_at": now}


def list_metrics() -> list:
    return _load()


def save_metric(d: dict, mid: str = "") -> dict:
    with _lock:
        items = _load()
        old = next((m for m in items if m["id"] == mid), None) if mid else None
        if mid and not old:
            raise FileNotFoundError("Metric not found.")
        m = _clean(d, old)
        dup = next((x for x in items if x["name"].lower() == m["name"].lower() and x["id"] != m["id"]), None)
        if dup:
            raise MetricError(f"A metric called “{dup['name']}” already exists.")
        if not old and len(items) >= MAX_METRICS:
            raise MetricError(f"At most {MAX_METRICS} metrics.")
        items = [m if x["id"] == m["id"] else x for x in items] if old else items + [m]
        _save(items)
        return m


def delete_metric(mid: str) -> None:
    with _lock:
        items = _load()
        if not any(m["id"] == mid for m in items):
            raise FileNotFoundError("Metric not found.")
        _save([m for m in items if m["id"] != mid])


def prompt_text(limit: int = 60) -> str:
    """The definitions every Claude prompt gets (empty when none are defined)."""
    items = _load()[:limit]
    if not items:
        return ""
    from tools.llm_security import fence
    lines = []
    for m in items:
        also = f" (also called: {', '.join(m['aliases'])})" if m["aliases"] else ""
        where = f" WHERE {m['filter']}" if m["filter"] else ""
        unit = f", {m['currency']}" if m["currency"] else ""
        lines.append(f"- {m['name']}{also}: {m['expression']}{where} [{m['format']}{unit}]"
                     + (f" — {m['description']}" if m["description"] else "")
                     + (f" (usually in table {m['table_hint']})" if m["table_hint"] else ""))
    return ("\n\nBUSINESS METRICS (the organisation's official definitions). When the user mentions one of these or an "
            "alias, compute it EXACTLY this way (same aggregate and filter, mapped to the matching columns of the data) "
            "and say which definition you used. If the data lacks the needed columns, say so instead of improvising:\n"
            + fence("\n".join(lines), "metric_definitions"))


def test_on_frame(m: dict, df, table: str = "t") -> dict:
    """Run a metric on a DataFrame in an in-memory SQLite. Returns {value, sql} or {error}."""
    import sqlite3
    validate(m.get("expression", ""), m.get("filter", ""))
    con = sqlite3.connect(":memory:")
    try:
        df.to_sql("t", con, index=False)
        sql = f"SELECT {m['expression']} AS value FROM t" + (f" WHERE {m['filter']}" if m.get("filter") else "")
        row = con.execute(sql).fetchone()
        return {"value": row[0] if row else None, "sql": sql.replace(" FROM t", f' FROM "{table}"')}
    except Exception as e:
        return {"error": str(e).splitlines()[0][:300]}
    finally:
        con.close()


_SUGGEST_TOOL = {"name": "suggest_metrics", "description": "Propose business metric definitions.",
                 "input_schema": {"type": "object", "properties": {"metrics": {"type": "array", "maxItems": 12, "items": {
                     "type": "object", "properties": {
                         "name": {"type": "string"}, "aliases": {"type": "array", "items": {"type": "string"}},
                         "description": {"type": "string"},
                         "expression": {"type": "string", "description": "One SQL aggregate, e.g. SUM(net_revenue)"},
                         "filter": {"type": "string", "description": "Optional SQL condition, e.g. status = 'paid'"},
                         "table_hint": {"type": "string"}, "format": {"type": "string", "enum": list(FORMATS)},
                         "currency": {"type": "string"}},
                     "required": ["name", "expression", "format"]}}}, "required": ["metrics"]}}


def suggest(profile: str) -> list:
    """Claude proposes up to 12 metrics from a data profile; only valid ones are returned (nothing is saved)."""
    from config import ANTHROPIC_MODEL, CLAUDE_THINKING, LLMUnavailableError, anthropic_client
    from tools.llm_security import FENCE_RULE, fence
    if anthropic_client is None:
        raise LLMUnavailableError("ANTHROPIC_API_KEY is not set")
    existing = ", ".join(m["name"] for m in _load()) or "none"
    resp = anthropic_client.messages.create(
        model=ANTHROPIC_MODEL, max_tokens=3000, thinking=CLAUDE_THINKING,
        system=("You define the key business metrics managers track for this data. Use only columns in the profile; "
                "each metric is ONE SQL aggregate (SUM/COUNT/AVG…, COUNT(DISTINCT x) for customers/orders) with an "
                "optional filter; ratios as 100.0 * SUM(..) / NULLIF(SUM(..), 0) with format percent. Add the English "
                f"and Indonesian names people use as aliases. Skip metrics that already exist: {existing}. " + FENCE_RULE),
        tools=[_SUGGEST_TOOL], tool_choice={"type": "tool", "name": "suggest_metrics"},
        messages=[{"role": "user", "content": fence(profile[:20000], "data_profile")}])
    block = next((b for b in resp.content if getattr(b, "type", "") == "tool_use"), None)
    out = []
    for d in ((block.input or {}).get("metrics") if block else None) or []:
        try:
            m = _clean(d)
            for k in ("id", "created_at", "updated_at"):
                m.pop(k)
            out.append(m)
        except Exception:
            continue
    return out
