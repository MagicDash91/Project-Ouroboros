"""
tools/sql_guard.py – AST validation for SQL written by an LLM.

Substring blocklists are easy to dodge (comments, odd spacing, quoting), so every
query is parsed with sqlglot and the syntax tree is checked instead:

  - exactly one statement, and it must be a SELECT (plain, WITH … SELECT, or UNION)
  - no write/DDL/session nodes anywhere in the tree (INSERT, UPDATE, DELETE, MERGE,
    CREATE, DROP, ALTER, SET, COPY, PRAGMA, ATTACH, SELECT … INTO, FOR UPDATE locks,
    or anything sqlglot could only parse as a raw "command")
  - no dangerous functions (file/network/process access, sleeps, config changes,
    large-object and admin functions in PostgreSQL / MySQL / SQLite / SQL Server)
  - tables must come from an allowlist (CTE names are always allowed), so system
    catalogs (information_schema, pg_catalog, sqlite_master, …) can't be read
  - optional: columns that hold secrets can never be selected

`check_select(sql, dialect, allowed_tables, blocked_columns)` returns the normalised SQL
or raises SQLGuardError with a short, model-readable reason (used for the repair call).
"""

import re
from typing import Iterable, Optional

import sqlglot
from sqlglot import exp


class SQLGuardError(ValueError):
    pass


MAX_SQL_CHARS = 8000

# Node types that must never appear anywhere in a dashboard / chat query.
_FORBIDDEN_NODES = tuple(t for t in (
    getattr(exp, n, None) for n in (
        "Insert", "Update", "Delete", "Merge", "Create", "Drop", "Alter", "AlterTable", "TruncateTable",
        "Command", "Set", "SetItem", "Pragma", "Attach", "Detach", "Copy", "Grant", "Revoke", "Use",
        "Transaction", "Commit", "Rollback", "LoadData", "Into", "Lock", "Cache", "Uncache", "Refresh",
        "Kill", "Summarize", "Execute", "ExecuteSql", "Call",
    )
) if isinstance(t, type))

# Function names (lower-case) that reach outside the data or change the session.
_FORBIDDEN_FUNCS = {
    # PostgreSQL
    "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file", "pg_sleep", "pg_sleep_for",
    "pg_sleep_until", "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile",
    "set_config", "current_setting", "lo_import", "lo_export", "lo_get", "lo_put", "lo_from_bytea",
    "dblink", "dblink_exec", "dblink_connect", "query_to_xml", "query_to_json", "table_to_xml",
    "pg_logical_emit_message", "pg_advisory_lock", "txid_current", "inet_server_addr", "version",
    "pg_backend_pid", "current_user", "session_user", "current_database", "pg_get_userbyid",
    # MySQL
    "load_file", "sleep", "benchmark", "get_lock", "release_lock", "sys_exec", "sys_eval", "user",
    "system_user", "database", "schema", "connection_id",
    # SQLite
    "load_extension", "readfile", "writefile", "edit", "fts3_tokenizer", "sqlite_version",
    "sqlite_compileoption_get", "sqlite_source_id",
    # SQL Server / Oracle / generic
    "xp_cmdshell", "openrowset", "opendatasource", "openquery", "utl_http", "utl_file", "dbms_pipe",
    "dbms_lock", "waitfor", "host_name", "suser_name",
}

# Schemas / tables that describe the database itself.
_SYSTEM_TABLES = re.compile(
    r"^(information_schema|pg_catalog|pg_toast|mysql|performance_schema|sys|sqlite_master|sqlite_schema|"
    r"sqlite_temp_master|sqlite_sequence|pg_\w+|sqlite_\w+)$", re.I)


def _func_name(node: exp.Expression) -> str:
    if isinstance(node, exp.Anonymous):
        return str(node.name or "").lower()
    try:
        return str(node.sql_name() or "").lower()
    except Exception:
        return type(node).__name__.lower()


def check_select(sql: str, dialect: str = "postgres",
                 allowed_tables: Optional[Iterable[str]] = None,
                 blocked_columns: Optional[Iterable[str]] = None) -> str:
    """Validate one read-only SELECT. Returns the SQL (trailing semicolon removed)."""
    text = (sql or "").strip()
    if not text:
        raise SQLGuardError("empty query")
    if len(text) > MAX_SQL_CHARS:
        raise SQLGuardError(f"query longer than {MAX_SQL_CHARS} characters")
    text = text.rstrip().rstrip(";").rstrip()
    try:
        statements = [s for s in sqlglot.parse(text, read=dialect) if s is not None]
    except Exception as e:
        raise SQLGuardError(f"could not parse the SQL: {str(e).splitlines()[0][:200]}")
    if len(statements) != 1:
        raise SQLGuardError("exactly one statement is allowed")
    tree = statements[0]
    if not isinstance(tree, (exp.Select, exp.Union, exp.Intersect, exp.Except, exp.Subquery)):
        raise SQLGuardError("only SELECT queries are allowed")

    for node in tree.walk():
        if isinstance(node, _FORBIDDEN_NODES):
            raise SQLGuardError(f"{type(node).__name__.upper()} is not allowed in a read-only query")
        if isinstance(node, exp.Func):
            name = _func_name(node)
            if name in _FORBIDDEN_FUNCS:
                raise SQLGuardError(f"function {name}() is not allowed")

    ctes = {c.alias_or_name.lower() for c in tree.find_all(exp.CTE)}
    allowed = {t.lower() for t in allowed_tables} if allowed_tables is not None else None
    for table in tree.find_all(exp.Table):
        name = (table.name or "").lower()
        db = (table.db or "").lower()
        if not name or name in ctes:
            continue
        if _SYSTEM_TABLES.match(name) or (db and _SYSTEM_TABLES.match(db)):
            raise SQLGuardError(f"system table {table.sql(dialect=dialect)} is not allowed")
        if allowed is not None:
            qualified = f"{db}.{name}" if db else name
            if name not in allowed and qualified not in allowed:
                raise SQLGuardError(f"unknown table {table.sql(dialect=dialect)}; use only the tables listed")

    if blocked_columns:
        blocked = {c.lower() for c in blocked_columns}
        for col in tree.find_all(exp.Column):
            if (col.name or "").lower() in blocked:
                raise SQLGuardError(f'column "{col.name}" holds secrets and cannot be queried')
    return text
