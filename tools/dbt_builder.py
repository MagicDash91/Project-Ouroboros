"""
tools/dbt_builder.py – the Data Engineer agent's real data-engineering layer (dbt).

Claude profiles the raw tables and designs a proper dbt project — sources, staging
models (rename / cast / clean), marts, column docs and dbt tests. The project is
written to dbt/uaa/ and built with `dbt build` (a subprocess with a timeout) into the
`uaa_staging` / `uaa_marts` schemas; raw tables are never modified. Failed models or
tests get one repair call using dbt's own error messages.

Guard rails on the SQL Claude writes (it runs against the real database):
  * each model is a single SELECT — no semicolons, comments, DDL/DML or admin functions;
  * the only Jinja allowed is {{ source() }}, {{ ref() }} and {{ config(materialized=...) }},
    which blocks dbt hooks, run_query and macros (they can execute arbitrary SQL);
  * the database password reaches dbt only through an environment variable —
    profiles.yml on disk references it with env_var(), never the value.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import yaml
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.engine import make_url

from features.dashboard import _profile_text, profile_table
from features.deeper import _engine, _resolve_db_uri
from tools.chart_pack import _tool_call

BASE_DIR      = Path(__file__).resolve().parent.parent
PROJECT_DIR   = BASE_DIR / "dbt" / "uaa"
PROFILES_DIR  = BASE_DIR / "data" / "dbt"           # not publicly served
RUNS_DIR      = PROFILES_DIR / "runs"
TARGET_SCHEMA = "uaa"                               # → uaa_staging, uaa_marts
DBT_TIMEOUT   = 600
MAX_TABLES    = 6
DERIVED       = re.compile(r"(_encoded|_segmented|_scored|_clean(ed)?)$|^(uaa_|my_first_dbt_model|web_research)")

_NAME  = re.compile(r"^[a-z][a-z0-9_]{1,62}$")
_JINJA = re.compile(r"\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\}", re.S)
_ALLOWED_JINJA = re.compile(
    r"^\{\{\s*(source\(\s*'[A-Za-z0-9_]+'\s*,\s*'[A-Za-z0-9_]+'\s*\)"
    r"|ref\(\s*'[a-z0-9_]+'\s*\)"
    r"|config\(\s*materialized\s*=\s*'(view|table)'\s*\))\s*\}\}$", re.S)
_BANNED_SQL = re.compile(
    r";|--|/\*|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|call|"
    r"execute|prepare|listen|notify|lock|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|"
    r"lo_import|lo_export|dblink\w*|pg_sleep\w*|pg_terminate_backend|pg_cancel_backend|set_config|"
    r"current_setting|pg_reload_conf|query_to_xml)\b", re.I)
_TESTS = {"not_null", "unique", "accepted_values", "relationships"}


class DbtBuildError(RuntimeError):
    pass


# ── Claude design / repair ────────────────────────────────────────────────────

_COLUMN = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "description": {"type": "string"},
        "tests": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": sorted(_TESTS)},
                "values": {"type": "array", "items": {"type": "string"}, "description": "accepted_values only"},
                "to": {"type": "string", "description": "relationships only: model name"},
                "field": {"type": "string", "description": "relationships only: column in that model"},
            },
            "required": ["type"]}},
    },
    "required": ["name", "description", "tests"],
}

_MODEL = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "snake_case: stg_<entity> for staging, fct_/dim_<entity> for marts"},
        "layer": {"type": "string", "enum": ["staging", "intermediate", "marts"]},
        "materialized": {"type": "string", "enum": ["view", "table"]},
        "description": {"type": "string"},
        "sql": {"type": "string", "description": "One SELECT using {{ source('raw','<table>') }} or {{ ref('<model>') }}."},
        "columns": {"type": "array", "items": _COLUMN},
    },
    "required": ["name", "layer", "materialized", "description", "sql", "columns"],
}

_DESIGN_TOOL = {
    "name": "design_dbt_project",
    "description": "Return the dbt sources and models.",
    "input_schema": {
        "type": "object",
        "properties": {
            "source_tables": {"type": "array", "items": {"type": "string"},
                              "description": "Raw tables (exact names) to declare as sources."},
            "models": {"type": "array", "items": _MODEL, "maxItems": 12},
        },
        "required": ["source_tables", "models"],
    },
}

_REPAIR_TOOL = {
    "name": "fix_dbt_models",
    "description": "Return corrected versions of the failing models (same names).",
    "input_schema": {"type": "object", "properties": {"models": {"type": "array", "items": _MODEL}},
                     "required": ["models"]},
}

_RULES = """dbt rules (PostgreSQL 16; the SQL runs against the real database):
- Each model is ONE SELECT (CTEs allowed). No semicolons, SQL comments, DDL/DML, or session/admin functions.
- The ONLY Jinja allowed: {{ source('raw', '<table>') }}, {{ ref('<model>') }}, and an optional first line
  {{ config(materialized='view') }} / {{ config(materialized='table') }}. No other macros, hooks, if/for blocks.
- Staging (stg_<entity>, one per source table, view): select every useful column from the source, rename to
  snake_case, cast to proper types (numeric text → NULLIF(TRIM(x), '')::numeric, 'Yes'/'No' → boolean),
  trim strings. Quote raw column names with double quotes exactly as in the profile.
- Marts (fct_ / dim_, table): business-ready tables built only from staging refs — e.g. one row per customer
  with the outcome flag and derived segments (tenure band, value band), or aggregated facts.
- Tests: every primary key gets not_null + unique; low-cardinality text columns get accepted_values with the
  values as they are AFTER your cleaning; foreign keys between models get relationships.
- Column descriptions in plain business language. Keep 2–8 models total; quality over quantity."""


def _design(profiles: list, goal: str) -> tuple:
    system = ("You are a senior analytics engineer designing a clean, tested dbt project from raw tables. "
              "Model what the business needs for analysis and reporting.\n\n" + _RULES)
    user = "\n\n".join(_profile_text(p) for p in profiles)
    user += f"\n\nBusiness goal: {goal.strip() or 'Clean, analysis-ready data for reporting and modelling.'}"
    return _tool_call(system, user, _DESIGN_TOOL, max_tokens=12000)


def _repair(profiles: list, failing: list, models: dict) -> tuple:
    system = "You fix failing dbt models and tests. Keep each model's name and purpose.\n\n" + _RULES
    user = "\n\n".join(_profile_text(p) for p in profiles) + "\n\nFailures:\n"
    seen = set()
    for f in failing:
        user += f"\n- {f['node']} ({f['status']}): {f['message']}"
        m = models.get(f.get("model"))
        if m and m["name"] not in seen:
            seen.add(m["name"])
            user += f"\n  Current model:\n{json.dumps(m, indent=1)}"
    return _tool_call(system, user, _REPAIR_TOOL, max_tokens=10000)


# ── Validation ────────────────────────────────────────────────────────────────

def check_model(m: dict, sources: set, model_names: set) -> list:
    problems = []
    name, sql = m.get("name", ""), m.get("sql", "")
    if not _NAME.match(name):
        problems.append(f"invalid model name {name!r}")
    if m.get("layer") not in ("staging", "intermediate", "marts"):
        problems.append(f"invalid layer {m.get('layer')!r}")
    for tag in _JINJA.findall(sql):
        if not _ALLOWED_JINJA.match(tag):
            problems.append(f"Jinja not allowed: {tag[:60]}")
        for src in re.findall(r"source\(\s*'[^']+'\s*,\s*'([^']+)'", tag):
            if src not in sources:
                problems.append(f"unknown source table {src!r}")
        for ref in re.findall(r"ref\(\s*'([^']+)'", tag):
            if ref not in model_names:
                problems.append(f"unknown model ref {ref!r}")
    # Drop config() lines entirely; stand in a placeholder relation for source()/ref().
    plain = _JINJA.sub(lambda t: "" if "config(" in t.group(0) else " x ", sql).strip()
    if not re.match(r"(?is)^(select|with)\b", plain):
        problems.append("model must be a single SELECT")
    bad = _BANNED_SQL.search(plain)
    if bad:
        problems.append(f"forbidden SQL token {bad.group(0)!r}")
    return problems


# ── Project files ─────────────────────────────────────────────────────────────

def _write_profiles(uri) -> dict:
    """profiles.yml with the password as env_var(); returns the env for the dbt subprocess."""
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    profile = {"uaa": {"target": "dev", "outputs": {"dev": {
        "type": "postgres", "host": uri.host or "localhost", "port": int(uri.port or 5432),
        "user": uri.username or "postgres", "password": "{{ env_var('UAA_DBT_PASSWORD') }}",
        "dbname": uri.database, "schema": TARGET_SCHEMA, "threads": 4, "connect_timeout": 15}}}}
    if uri.query.get("sslmode"):                     # e.g. Supabase requires SSL
        profile["uaa"]["outputs"]["dev"]["sslmode"] = uri.query["sslmode"]
    (PROFILES_DIR / "profiles.yml").write_text(yaml.safe_dump(profile, sort_keys=False), encoding="utf-8")
    keep = ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
            "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update(UAA_DBT_PASSWORD=uri.password or "", DBT_SEND_ANONYMOUS_USAGE_STATS="false",
               PYTHONIOENCODING="utf-8", DO_NOT_TRACK="1")
    return env


def _test_yaml(t: dict):
    kind = t.get("type")
    if kind in ("not_null", "unique"):
        return kind
    if kind == "accepted_values" and t.get("values"):
        return {"accepted_values": {"arguments": {"values": [str(v) for v in t["values"]]}}}
    if kind == "relationships" and t.get("to") and t.get("field"):
        return {"relationships": {"arguments": {"to": f"ref('{t['to']}')", "field": t["field"]}}}
    return None


def _raw_schema(engine) -> str:
    """First schema on the connection's search_path that holds raw tables (not our uaa_* output).
    `public` by default; e.g. `retail` when the URI sets options=-csearch_path=retail,public."""
    from sqlalchemy import text as _text
    with engine.connect() as c:
        rows = c.execute(_text(
            "SELECT s.name FROM unnest(current_schemas(false)) WITH ORDINALITY AS s(name, pos) "
            "WHERE s.name NOT LIKE 'uaa\\_%' AND EXISTS (SELECT 1 FROM information_schema.tables t "
            "WHERE t.table_schema = s.name AND t.table_type = 'BASE TABLE') ORDER BY s.pos")).fetchall()
    return rows[0][0] if rows else "public"


def _write_project(sources: list, models: dict, raw_schema: str = "public") -> None:
    shutil.rmtree(PROJECT_DIR / "models", ignore_errors=True)
    for sub in ("staging", "intermediate", "marts"):
        (PROJECT_DIR / "models" / sub).mkdir(parents=True, exist_ok=True)
    (PROJECT_DIR / "dbt_project.yml").write_text(yaml.safe_dump({
        "name": "uaa", "version": "1.0.0", "config-version": 2, "profile": "uaa",
        "model-paths": ["models"], "target-path": "target", "clean-targets": ["target", "dbt_packages"],
        "models": {"uaa": {"staging": {"+schema": "staging", "+materialized": "view"},
                           "intermediate": {"+schema": "intermediate", "+materialized": "view"},
                           "marts": {"+schema": "marts", "+materialized": "table"}}},
    }, sort_keys=False), encoding="utf-8")

    (PROJECT_DIR / "models" / "staging" / "_sources.yml").write_text(yaml.safe_dump({
        "version": 2,
        "sources": [{"name": "raw", "schema": raw_schema, "tables": [{"name": t} for t in sources]}],
    }, sort_keys=False), encoding="utf-8")

    by_layer: dict = {}
    for m in models.values():
        sql = m["sql"].strip()
        if not sql.startswith("{{ config("):
            sql = f"{{{{ config(materialized='{m.get('materialized', 'view')}') }}}}\n" + sql
        (PROJECT_DIR / "models" / m["layer"] / f"{m['name']}.sql").write_text(sql + "\n", encoding="utf-8")
        cols = []
        for c in m.get("columns", []):
            tests = [y for y in (_test_yaml(t) for t in c.get("tests", [])) if y]
            col = {"name": c["name"], "description": c.get("description", "")}
            if tests:
                col["data_tests"] = tests
            cols.append(col)
        by_layer.setdefault(m["layer"], []).append({"name": m["name"], "description": m.get("description", ""),
                                                    "columns": cols})
    for layer, entries in by_layer.items():
        (PROJECT_DIR / "models" / layer / "_models.yml").write_text(
            yaml.safe_dump({"version": 2, "models": entries}, sort_keys=False, allow_unicode=True), encoding="utf-8")


# ── Running dbt ───────────────────────────────────────────────────────────────

def _dbt_exe() -> str:
    exe = Path(sys.executable).parent / ("dbt.exe" if os.name == "nt" else "dbt")
    return str(exe) if exe.exists() else "dbt"


def _dbt(args: list, env: dict) -> subprocess.CompletedProcess:
    cmd = [_dbt_exe(), *args, "--project-dir", str(PROJECT_DIR), "--profiles-dir", str(PROFILES_DIR),
           "--no-use-colors"]
    return subprocess.run(cmd, cwd=PROJECT_DIR, env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=DBT_TIMEOUT)


def _manifest() -> dict:
    p = PROJECT_DIR / "target" / "manifest.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def _results(manifest: dict) -> list:
    p = PROJECT_DIR / "target" / "run_results.json"
    if not p.exists():
        return []
    out = []
    for r in json.loads(p.read_text(encoding="utf-8")).get("results", []):
        uid = r.get("unique_id", "")
        node = manifest.get("nodes", {}).get(uid, {})
        kind = uid.split(".")[0]
        model = node.get("name", "") if kind == "model" else next(
            (d.split(".")[-1] for d in node.get("depends_on", {}).get("nodes", []) if d.startswith("model.")), "")
        out.append({"node": uid, "kind": kind, "name": node.get("name") or uid.split(".")[-1], "model": model,
                    "status": r.get("status"), "message": (r.get("message") or "")[:400],
                    "seconds": round(r.get("execution_time") or 0, 2)})
    return out


def _lineage(manifest: dict) -> list:
    edges = []
    for n in manifest.get("nodes", {}).values():
        if n.get("resource_type") != "model":
            continue
        for dep in n.get("depends_on", {}).get("nodes", []):
            src = dep.split(".")[-1] if dep.startswith("model.") else f"raw.{dep.split('.')[-1]}"
            edges.append([src, n["name"]])
    return edges


# ── Public API ────────────────────────────────────────────────────────────────

def build_dbt_project(goal: str = "", db_uri: str = "", tables: Optional[list] = None) -> dict:
    """Design → validate → write → dbt build → (repair once) → summary saved to data/dbt/runs/."""
    uri_str = _resolve_db_uri(db_uri)
    uri = make_url(uri_str)
    if not uri.drivername.startswith("postgres"):
        raise DbtBuildError("dbt modelling currently supports PostgreSQL sources only "
                            f"(got {uri.drivername}). Load uploads into Postgres first.")
    engine = _engine(uri_str)
    raw_schema = _raw_schema(engine)
    raw = [t for t in sa_inspect(engine).get_table_names(schema=raw_schema) if not DERIVED.search(t)]
    chosen = [t for t in (tables or raw) if t in raw][:MAX_TABLES]
    if not chosen:
        raise DbtBuildError("No raw tables found to model.")
    profiles = [profile_table(engine, t) for t in chosen]

    design, u = _design(profiles, goal)
    usage = [u]
    sources = [t for t in design.get("source_tables", []) if t in chosen] or chosen
    models = {m["name"]: m for m in design.get("models", []) if m.get("name")}

    rejected = {}
    for name in list(models):
        problems = check_model(models[name], set(sources), set(models))
        if problems:
            rejected[name] = problems
            models.pop(name)
    if not models:
        raise DbtBuildError(f"Every generated model was rejected: {rejected}")

    env = _write_profiles(uri)
    _write_project(sources, models, raw_schema)
    proc = _dbt(["build"], env)
    manifest = _manifest()
    results = _results(manifest)
    failing = [r for r in results if r["status"] in ("error", "fail")]

    repaired = []
    if failing:
        try:
            fixes, u = _repair(profiles, failing, models)
            usage.append(u)
            for m in fixes.get("models", []):
                if m.get("name") in models and not check_model(m, set(sources), set(models)):
                    models[m["name"]] = m
                    repaired.append(m["name"])
            if repaired:
                _write_project(sources, models, raw_schema)
                proc = _dbt(["build"], env)
                manifest = _manifest()
                results = _results(manifest)
        except Exception as e:
            print(f"[dbt] repair skipped: {e}", flush=True)

    if not results:
        raise DbtBuildError("dbt produced no results:\n" + ((proc.stdout or "") + (proc.stderr or ""))[-1500:])

    status = {r["name"]: r["status"] for r in results if r["kind"] == "model"}
    run = {
        "id": uuid.uuid4().hex[:12],
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "trigger": "AI design", "goal": goal, "sources": sources,
        "models": [{"name": m["name"], "layer": m["layer"], "description": m.get("description", ""),
                    "relation": f"{TARGET_SCHEMA}_{m['layer']}.{m['name']}", "status": status.get(m["name"], "skipped")}
                   for m in models.values()],
        "tests": [r for r in results if r["kind"] == "test"],
        "lineage": _lineage(manifest),
        "rejected": rejected, "repaired": repaired,
        "ok": all(r["status"] in ("success", "pass", "warn") for r in results),
        "llm_usage": {"calls": len(usage), "input_tokens": sum(x["input_tokens"] for x in usage),
                      "output_tokens": sum(x["output_tokens"] for x in usage)},
    }
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    (RUNS_DIR / f"{run['id']}.json").write_text(json.dumps(run, indent=2), encoding="utf-8")
    _mark_ingested()
    return run


_RUN_ID = re.compile(r"^[a-f0-9]{12}$")


def load_run(run_id: str) -> dict:
    if not _RUN_ID.match(run_id or ""):
        raise DbtBuildError("invalid run id")
    p = RUNS_DIR / f"{run_id}.json"
    if not p.exists():
        raise FileNotFoundError(f"dbt run {run_id} not found")
    return json.loads(p.read_text(encoding="utf-8"))


def list_runs() -> list:
    out = []
    for p in sorted(RUNS_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True) if RUNS_DIR.exists() else []:
        try:
            r = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        passed = sum(1 for t in r.get("tests", []) if t.get("status") in ("pass", "success"))
        out.append({"id": r["id"], "created_at": r["created_at"], "ok": r.get("ok"), "goal": r.get("goal", ""),
                    "trigger": r.get("trigger", "build"), "models": len(r.get("models", [])),
                    "tests_passed": passed, "tests_total": len(r.get("tests", []))})
    return out


def latest_run(since: Optional[str] = None) -> Optional[dict]:
    """Most recent run, optionally only if created at/after `since` (ISO timestamp)."""
    runs = list_runs()
    if not runs or (since and runs[0]["created_at"] < since[:19]):
        return None
    return load_run(runs[0]["id"])


def model_source(name: str) -> dict:
    """The model's SQL and its docs/tests YAML entry, for the UI."""
    if not _NAME.match(name or ""):
        raise DbtBuildError("invalid model name")
    for layer in ("staging", "intermediate", "marts"):
        sql = PROJECT_DIR / "models" / layer / f"{name}.sql"
        if sql.exists():
            doc = {}
            yml = PROJECT_DIR / "models" / layer / "_models.yml"
            if yml.exists():
                doc = next((m for m in (yaml.safe_load(yml.read_text(encoding="utf-8")) or {}).get("models", [])
                            if m.get("name") == name), {})
            return {"name": name, "layer": layer, "sql": sql.read_text(encoding="utf-8"), "doc": doc}
    raise FileNotFoundError(f"model {name} not found")


def with_mart_search_path(uri: str) -> str:
    """Same database URI, but plain table names resolve to the tested marts first.

    Lets every existing tool keep using unqualified names (e.g. "dim_customer_churn")
    after a successful dbt build. Schemas already on the URI's search_path (e.g. `retail`)
    are kept after the marts, so raw tables stay reachable by plain name too.
    """
    u = make_url(uri)
    existing = re.search(r"search_path=([^\s]+)", str(u.query.get("options", "")))
    rest = [s for s in (existing.group(1).split(",") if existing else ["public"])
            if s and not s.startswith(f"{TARGET_SCHEMA}_")]
    path = ",".join([f"{TARGET_SCHEMA}_marts", f"{TARGET_SCHEMA}_staging", *rest])
    return u.update_query_dict({"options": f"-csearch_path={path}"}).render_as_string(hide_password=False)


def rebuild(db_uri: str = "", trigger: str = "manual rebuild") -> dict:
    """Re-run the existing project with no LLM call (manual rebuilds; Airflow does the same)."""
    if not (PROJECT_DIR / "dbt_project.yml").exists():
        raise DbtBuildError("No dbt project yet — build one first.")
    env = _write_profiles(make_url(_resolve_db_uri(db_uri)))
    proc = _dbt(["build"], env)
    return record_results(trigger, log_tail=(proc.stdout or "")[-1500:])


_MARKER = PROFILES_DIR / "last_ingested.txt"


def _artifacts_stamp() -> str:
    """dbt's own `generated_at` for the current target/run_results.json ('' if none)."""
    p = PROJECT_DIR / "target" / "run_results.json"
    if not p.exists():
        return ""
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("metadata", {}).get("generated_at", "")
    except Exception:
        return ""


def _mark_ingested() -> None:
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    _MARKER.write_text(_artifacts_stamp(), encoding="utf-8")


def sync_external_results(trigger: str = "airflow") -> Optional[dict]:
    """Record dbt results produced outside this process (the Airflow container writes to the
    shared dbt/uaa/target folder). Lets Airflow stay off the network: no callback needed."""
    stamp = _artifacts_stamp()
    seen = _MARKER.read_text(encoding="utf-8").strip() if _MARKER.exists() else ""
    if not stamp or stamp == seen:
        return None
    return record_results(trigger)


def record_results(trigger: str, log_tail: str = "") -> dict:
    """Turn the latest target/ artifacts into a saved run record (used by rebuild and Airflow)."""
    manifest = _manifest()
    results = _results(manifest)
    if not results:
        raise DbtBuildError("dbt produced no results:\n" + log_tail)
    status = {r["name"]: r["status"] for r in results if r["kind"] == "model"}
    models = []
    for n in manifest.get("nodes", {}).values():
        if n.get("resource_type") == "model":
            layer = (n.get("fqn") or ["", "staging"])[1]
            models.append({"name": n["name"], "layer": layer, "description": n.get("description", ""),
                           "relation": f"{n.get('schema', '')}.{n['name']}", "status": status.get(n["name"], "skipped")})
    prev = latest_run()
    run = {
        "id": uuid.uuid4().hex[:12], "created_at": datetime.now().isoformat(timespec="seconds"),
        "trigger": trigger, "goal": (prev or {}).get("goal", ""), "sources": (prev or {}).get("sources", []),
        "models": models, "tests": [r for r in results if r["kind"] == "test"], "lineage": _lineage(manifest),
        "rejected": {}, "repaired": [],
        "ok": all(r["status"] in ("success", "pass", "warn") for r in results),
        "llm_usage": {"calls": 0, "input_tokens": 0, "output_tokens": 0}, "log_tail": log_tail,
    }
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    (RUNS_DIR / f"{run['id']}.json").write_text(json.dumps(run, indent=2), encoding="utf-8")
    _mark_ingested()
    return run
