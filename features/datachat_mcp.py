"""
features/datachat_mcp.py – read-only FastMCP server for "chat with your data".

The data-chat agent (features/data_chat.py) gets its tools ONLY from this server, over the
MCP protocol (in-memory transport inside the API; `python -m features.datachat_mcp` serves the
same tools over stdio for other MCP clients). Every tool is annotated read-only, and the
server enforces it rather than trusting the model:

  describe_data  – datasets, columns, types, which columns are masked
  run_sql        – database sessions: ONE SELECT, validated by a SQL parser (sqlglot): no
                   writes, DDL, SELECT INTO, row locks, multi-statements, dangerous functions
                   (pg_sleep, dblink, pg_read_file…) or credential/system tables (Supabase
                   auth/vault, pg_authid…); then run in a READ ONLY transaction with a timeout
  run_python     – analysis code in the session's sandboxed kernel (tools/py_kernel.py):
                   no file, network or OS access; source data cannot be modified

Results pass through tools/llm_guard.py before the model sees them: personal-data columns are
pseudonymised (SQL aliases are traced, so `SELECT email AS x` stays masked), free text is
redacted, and output is fenced as untrusted data with planted instructions flagged.
"""

import json
import os
from typing import Annotated

from fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from tools.llm_guard import pii_kind, pseudonymize_frame, redact_text, wrap_untrusted

mcp = FastMCP(
    "uaa-datachat-readonly",
    instructions="Read-only access to one Universal AI Analytics data-chat session. Personal data is masked.",
)

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
# run_python keeps notebook variables between calls, so it is not idempotent, but it can't
# write to any data source, file or network.
SANDBOXED = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=False, openWorldHint=False)

SQL_TIMEOUT_MS = 30_000
_DIALECTS = {"postgresql": "postgres", "mysql": "mysql", "mariadb": "mysql", "mssql": "tsql", "oracle": "oracle",
             "sqlite": "sqlite", "duckdb": "duckdb", "bigquery": "bigquery", "redshift": "redshift",
             "snowflake": "snowflake"}
_BLOCKED_FUNCS = {
    "pg_sleep", "pg_sleep_for", "pg_sleep_until", "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file",
    "pg_ls_logdir", "pg_ls_waldir", "lo_import", "lo_export", "lo_get", "lo_put", "lo_from_bytea", "dblink",
    "dblink_exec", "dblink_connect", "set_config", "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf",
    "pg_rotate_logfile", "pg_advisory_lock", "pg_advisory_xact_lock", "query_to_xml", "query_to_json",
    "sleep", "benchmark", "load_file", "sys_exec", "sys_eval", "xp_cmdshell", "openrowset", "opendatasource",
    "openquery", "waitfor", "nextval", "setval",
}
_BLOCKED_FUNC_PREFIX = ("dbms_", "utl_", "pg_read", "pg_ls", "lo_", "xp_", "sp_")
_BLOCKED_SCHEMAS = {"auth", "vault", "pgsodium", "pgsodium_masks", "supabase_functions", "supabase_migrations",
                    "storage", "net", "cron", "mysql", "pg_toast"}
_BLOCKED_TABLES = {"pg_authid", "pg_shadow", "pg_user_mappings", "pg_user_mapping", "pg_hba_file_rules",
                   "pg_file_settings", "pg_stat_activity", "pg_stat_statements", "pg_settings", "sql_logins",
                   "syslogins", "dba_users", "user$", "credentials", "password_history"}


class SqlRejected(ValueError):
    pass


def _session(session_id: str):
    from features.data_chat import get_session
    return get_session(session_id)


def _key(s) -> bytes:
    return bytes.fromhex(s.r["pii_key"]) if s.r.get("pii_key") else b""


def _redact_cells(preview: dict) -> dict:
    rows = [[redact_text(v)[0] if isinstance(v, str) else v for v in r] for r in preview.get("rows", [])]
    return {**preview, "rows": rows}


def _respond(text: str, flags: set, **ui) -> dict:
    text, kinds = redact_text(text)
    if kinds:
        flags.add("pii_redacted_tool_output")
    wrapped, injected = wrap_untrusted(text)
    if injected:
        flags.add("instructions_in_data_flagged")
    return {"text": wrapped, "flags": sorted(flags), **ui}


# ── SQL validation ────────────────────────────────────────────────────────────

def check_select(query: str, dialect: str):
    """Parse and validate one read-only SELECT. Returns the sqlglot tree; raises SqlRejected."""
    import sqlglot
    from sqlglot import exp

    q = (query or "").strip().rstrip(";").strip()
    if not q:
        raise SqlRejected("empty query")
    try:
        stmts = [t for t in sqlglot.parse(q, read=_DIALECTS.get(dialect)) if t is not None]
    except Exception as e:
        raise SqlRejected(f"the query could not be parsed ({str(e).splitlines()[0][:160]}); "
                          "use a simpler, standard SELECT")
    if len(stmts) != 1:
        raise SqlRejected("exactly one statement is allowed")
    tree = stmts[0]
    allowed_roots = tuple(c for c in (exp.Select, getattr(exp, "SetOperation", None), exp.Union, exp.Subquery) if c)
    if not isinstance(tree, allowed_roots):
        raise SqlRejected(f"only SELECT queries are allowed (got {type(tree).__name__.upper()})")

    forbidden = tuple(c for c in (getattr(exp, n, None) for n in (
        "Into", "Lock", "Insert", "Update", "Delete", "Create", "Drop", "Alter", "AlterTable", "Merge", "Command",
        "Set", "Transaction", "Commit", "Rollback", "Copy", "Grant", "TruncateTable", "LoadData", "Use", "Pragma",
    )) if c)
    for node in tree.walk():
        node = node[0] if isinstance(node, tuple) else node
        if forbidden and isinstance(node, forbidden):
            raise SqlRejected(f"{type(node).__name__.upper()} is not allowed - read-only access")
        if isinstance(node, exp.Func):
            name = (node.name if isinstance(node, exp.Anonymous) else node.sql_name()).lower()
            if name in _BLOCKED_FUNCS or name.startswith(_BLOCKED_FUNC_PREFIX):
                raise SqlRejected(f"function {name}() is not allowed")
        if isinstance(node, exp.Table):
            schema, table = (node.db or "").lower(), (node.name or "").lower()
            if schema in _BLOCKED_SCHEMAS or table in _BLOCKED_TABLES:
                raise SqlRejected(f"{(schema + '.') if schema else ''}{table} is a system/credential table "
                                  "and is off limits")
    return tree


def pii_lineage(tree) -> dict:
    """{output column (lower): kind} for projections derived from PII columns, through aliases and CTEs.

    COUNT(...) of a PII column is safe (a number, not the value), so it is not tainted.
    """
    from sqlglot import exp
    tainted: dict = {}
    for _ in range(10):
        changed = False
        for sel in tree.find_all(exp.Select):
            for proj in sel.expressions:
                alias = (proj.alias_or_name or "").lower()
                if not alias or alias in tainted:
                    continue
                for col in proj.find_all(exp.Column):
                    name = (col.name or "").lower()
                    kind = tainted.get(name) or pii_kind(name)
                    if kind and not col.find_ancestor(exp.Count):
                        tainted[alias] = kind
                        changed = True
                        break
        if not changed:
            break
    return tainted


def run_select(s, query: str):
    """Validated, read-only execution. Returns (masked DataFrame, {column: kind})."""
    import pandas as pd
    from features.data_chat import SQL_ROW_LIMIT, _db_uri
    from features.db_connect import cached_engine

    eng = cached_engine(_db_uri(s))
    dialect = eng.dialect.name
    tree = check_select(query, dialect)
    lineage = pii_lineage(tree)
    q = query.strip().rstrip(";").strip()
    with eng.connect() as conn:
        raw = conn.connection
        cur = raw.cursor()
        try:
            if dialect == "postgresql":
                cur.execute("SET TRANSACTION READ ONLY")
                cur.execute(f"SET LOCAL statement_timeout = {SQL_TIMEOUT_MS}")
            elif dialect in ("mysql", "mariadb"):
                cur.execute("SET TRANSACTION READ ONLY")
            cur.execute(q)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = cur.fetchmany(SQL_ROW_LIMIT) if cols else []
        finally:
            cur.close()
            raw.rollback()
    df = pd.DataFrame(rows, columns=cols)
    if not _key(s):
        return df, {}
    extra = {str(c): lineage[str(c).lower()] for c in df.columns if str(c).lower() in lineage}
    return pseudonymize_frame(df, _key(s), extra=extra)


# ── Tools ─────────────────────────────────────────────────────────────────────

@mcp.tool(annotations=READ_ONLY)
def describe_data(session_id: Annotated[str, Field(description="Chat session id")]) -> dict:
    """List the available datasets with their columns and types. Masked columns hold pseudonymous tokens."""
    from features.data_chat import _schema_text
    return _respond(_schema_text(_session(session_id)), set())


@mcp.tool(annotations=READ_ONLY)
def run_sql(
    session_id: Annotated[str, Field(description="Chat session id")],
    query: Annotated[str, Field(description="ONE read-only SELECT (or WITH ... SELECT). Aggregate in SQL when you can.")],
    save_as: Annotated[str, Field(description="Name of the pandas DataFrame the result is saved as")] = "q",
) -> dict:
    """Run ONE read-only SELECT on the database. The result becomes a pandas DataFrame named `save_as` in Python."""
    from features.data_chat import _ident, _table_text
    s = _session(session_id)
    flags: set = set()
    step = {"tool": "sql", "input": query, "ok": False}
    if s.r["source"]["kind"] != "database":
        step["error"] = "this chat has no database - use run_python on the loaded DataFrames"
        return _respond("ERROR: " + step["error"], flags, step=step)
    name = _ident(save_as or "q")
    try:
        df, masked = run_select(s, query)
        if masked:
            flags.add("pii_masked")
        path = s.dir / f"sql_{name}.parquet"
        df.to_parquet(path, index=False)
        s.ensure_kernel()
        s.kernel.call({"op": "add", "name": name, "path": str(path), "format": "parquet"})
        s.r["sql_frames"] = [q for q in s.r.get("sql_frames", []) if q["name"] != name] + \
                            [{"name": name, "path": str(path), "rows": len(df), "masked": masked}]
        head = df.head(20)
        preview = _redact_cells({"columns": [str(c) for c in head.columns], "shape": list(df.shape),
                                 "rows": json.loads(head.to_json(orient="values", date_format="iso",
                                                                 default_handler=str))})
        try:                                                # full result, private, for exports
            import uuid
            ref = f"sql_{uuid.uuid4().hex[:10]}"
            (s.dir / "results").mkdir(parents=True, exist_ok=True)
            df.head(200_000).to_parquet(s.dir / "results" / f"{ref}.parquet", index=False)
            preview["ref"] = ref
        except Exception:
            pass
        step.update(ok=True, table=preview, saved_as=name)
        note = f" Masked personal-data columns: {', '.join(masked)}." if masked else ""
        return _respond(f"Saved as DataFrame `{name}`.{note}\n" + _table_text(preview), flags, step=step,
                        tables=[preview])
    except SqlRejected as e:
        flags.add("sql_blocked")
        step["error"] = f"Blocked: {e}"
    except Exception as e:                                                       # noqa: BLE001
        step["error"] = str(e).splitlines()[0][:500]
    step["error"] = redact_text(step["error"])[0]
    return _respond("ERROR: " + step["error"], flags, step=step)


@mcp.tool(annotations=SANDBOXED)
def run_python(
    session_id: Annotated[str, Field(description="Chat session id")],
    code: Annotated[str, Field(description="Python to run in the persistent sandboxed session. Assign a chart to `fig`.")],
) -> dict:
    """Run Python in the persistent analysis session (DataFrames preloaded; assign charts to `fig`).
    No file, network or OS access; the source data cannot be modified."""
    import uuid
    from features.data_chat import _table_text
    s = _session(session_id)
    flags: set = set()
    turn = len(s.r["history"]) // 2 + 1
    res = s.exec(code, f"t{turn}_{uuid.uuid4().hex[:6]}")
    step = {"tool": "python", "input": code, "ok": bool(res.get("ok"))}
    parts, charts, tables = [], [], []
    if res.get("stdout"):
        parts.append(res["stdout"][-3000:])
    r = res.get("result")
    if r and r["type"] == "table":
        r = _redact_cells(r)
        if res.get("table_ref"):
            r["ref"] = res["table_ref"]
        tables.append(r)
        step["table"] = r
        parts.append(_table_text(r))
    elif r:
        parts.append(r["text"][:3000])
    for c in res.get("charts", []):
        url = f"/outputs/datachat/{s.id}/{os.path.basename(c['path'])}"
        charts.append({"url": url, "kind": c["kind"]})
        step.setdefault("charts", []).append(url)
        parts.append("[chart created and shown to the user]")
    if not res.get("ok"):
        step["error"] = redact_text(res.get("error", ""))[0]
        if step["error"].startswith("blocked:"):
            flags.add("code_blocked")
        parts.append("ERROR: " + step["error"])
    text = "\n".join(parts) or "(no output - end the cell with an expression to see a value)"
    return _respond(text, flags, step=step, charts=charts, tables=tables)


if __name__ == "__main__":
    mcp.run()                                       # stdio, for external MCP clients
