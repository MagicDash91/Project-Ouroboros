"""
tools/db_safety.py – guard rails for code that talks to the user's database directly
(the Analytics crew tools, data monitors, AutoML), outside Data chat's FastMCP server.

  safe_table(engine, name)      – an AI- or user-supplied table name must be a plain identifier
                                  AND an existing table/view; returns it quoted for SQL text, so
                                  nothing can be smuggled into f"SELECT * FROM {table}".
  safe_columns(engine, t, *cols) – same for column names (checked against the table's columns).
  read_only_query(engine, sql)  – one parser-validated SELECT (tools/sql_guard: no writes, DDL,
                                  file/network/sleep functions, system catalogs) run in a READ
                                  ONLY transaction with a statement timeout (PostgreSQL).
  write_table(df, name, engine) – Ouroboros may create and replace ITS OWN tables. On a database
                                  the user connected (anything but Ouroboros's own POSTGRES_URI)
                                  it never overwrites or appends into a table that was already
                                  there: it writes <name>_uaa instead and returns that name.
                                  Tables it created are remembered per database in
                                  data/db_writes.json (keyed by a hash of driver/host/port/db –
                                  never credentials), so later runs can refresh them.
"""

import hashlib
import json
import re
import threading
import time
from pathlib import Path

import pandas as pd
from sqlalchemy import inspect
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "data" / "db_writes.json"
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,127}$")
QUERY_TIMEOUT_MS = 60_000

_SYSTEM_SCHEMAS = re.compile(
    r"^(pg_.*|information_schema|sys|mysql|performance_schema|auth|storage|vault|realtime|_realtime|"
    r"extensions|graphql|graphql_public|pgsodium.*|supabase_.*|net|cron|pgbouncer|_analytics|"
    r"topology|tiger.*)$", re.I)

_lock = threading.Lock()
_cache: dict = {}          # db key -> (time, {lower name: (schema, name)})
_CACHE_SECONDS = 30


class UnsafeIdentifier(ValueError):
    pass


# ── Which database is this? ──────────────────────────────────────────────────

def _db_key(engine) -> str:
    u = engine.url
    raw = f"{u.drivername}|{(u.host or '').lower()}|{u.port or ''}|{u.database or ''}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def is_internal(engine) -> bool:
    """True for Ouroboros's own database (POSTGRES_URI), where uploads are loaded."""
    try:
        from config import POSTGRES_URI
        own = make_url(POSTGRES_URI)
    except Exception:
        return False
    u = engine.url
    return ((u.host or "").lower(), u.port or own.port, u.database) == \
        ((own.host or "").lower(), own.port, own.database) and u.get_backend_name() == own.get_backend_name()


# ── Known tables ─────────────────────────────────────────────────────────────

def known_tables(engine, refresh: bool = False) -> dict:
    """{lower name or schema.name: (schema, name)} for every user table and view."""
    key = _db_key(engine)
    hit = _cache.get(key)
    if hit and not refresh and time.time() - hit[0] < _CACHE_SECONDS:
        return hit[1]
    insp = inspect(engine)
    default = insp.default_schema_name
    out: dict = {}
    if engine.dialect.name == "postgresql":
        schemas = [default] + [s for s in insp.get_schema_names()
                               if s != default and not _SYSTEM_SCHEMAS.match(s)]
    else:
        schemas = [None]
    for s in schemas:
        try:
            names = list(insp.get_table_names(schema=s)) + list(insp.get_view_names(schema=s))
        except Exception:
            continue
        for n in names:
            if s in (None, default):
                out.setdefault(n.lower(), (s, n))
            if s:
                out[f"{s}.{n}".lower()] = (s, n)
    _cache[key] = (time.time(), out)
    return out


def _resolve(engine, name: str):
    raw = (name or "").strip().strip(";").strip()
    parts = [p.strip().strip('"').strip("`").strip("[]") for p in raw.split(".")]
    if not 1 <= len(parts) <= 2 or not all(IDENT.match(p) for p in parts):
        raise UnsafeIdentifier(f"{name!r} is not a valid table name (letters, digits and _ only)")
    look = ".".join(parts).lower()
    hit = known_tables(engine).get(look) or known_tables(engine, refresh=True).get(look)
    if not hit:
        raise UnsafeIdentifier(f"table {name!r} doesn't exist; list the database tables and use one of those")
    return hit


def safe_table(engine, name: str) -> str:
    """Quoted, existing table/view name for SQL text, or UnsafeIdentifier."""
    schema, table = _resolve(engine, name)
    q = engine.dialect.identifier_preparer.quote
    return f"{q(schema)}.{q(table)}" if schema else q(table)


def safe_columns(engine, table_name: str, *cols: str) -> list:
    """Quoted column names that really exist on that table, or UnsafeIdentifier."""
    schema, table = _resolve(engine, table_name)
    actual = {c["name"].lower(): c["name"] for c in inspect(engine).get_columns(table, schema=schema)}
    q = engine.dialect.identifier_preparer.quote
    out = []
    for c in cols:
        real = actual.get((c or "").strip().strip('"').lower())
        if not real:
            raise UnsafeIdentifier(f"column {c!r} doesn't exist on {table}")
        out.append(q(real))
    return out


# ── Reads ────────────────────────────────────────────────────────────────────

_SQLGLOT = {"postgresql": "postgres", "mysql": "mysql", "mariadb": "mysql", "sqlite": "sqlite",
            "mssql": "tsql", "snowflake": "snowflake", "bigquery": "bigquery", "oracle": "oracle",
            "redshift": "redshift"}


def read_only_query(engine, sql: str, max_rows: int = 10_000) -> pd.DataFrame:
    """One validated SELECT, read-only at the database, at most max_rows rows."""
    from tools.sql_guard import check_select
    dialect = _SQLGLOT.get(engine.dialect.name, "postgres")
    sql = check_select(sql, dialect, allowed_tables=known_tables(engine).keys())
    with engine.connect() as conn:
        raw = conn.connection
        cur = raw.cursor()
        try:
            if engine.dialect.name == "postgresql":
                cur.execute("SET TRANSACTION READ ONLY")
                cur.execute(f"SET LOCAL statement_timeout = {int(QUERY_TIMEOUT_MS)}")
            cur.execute(sql)       # raw DB-API, no parameters: '%' in ILIKE stays literal
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = cur.fetchmany(max_rows) if cols else []
        finally:
            cur.close()
            raw.rollback()
    return pd.DataFrame(rows, columns=cols)


# ── Writes ───────────────────────────────────────────────────────────────────

def _registry() -> dict:
    try:
        return json.loads(REGISTRY.read_text(encoding="utf-8"))
    except Exception:
        return {}


def owned_tables(engine) -> set:
    return {t.lower() for t in _registry().get(_db_key(engine), [])}


def _remember(engine, name: str):
    with _lock:
        reg = _registry()
        items = reg.setdefault(_db_key(engine), [])
        if name.lower() not in {t.lower() for t in items}:
            items.append(name)
        REGISTRY.parent.mkdir(parents=True, exist_ok=True)
        REGISTRY.write_text(json.dumps(reg, indent=1), encoding="utf-8")


def write_table(df: pd.DataFrame, name: str, engine, if_exists: str = "replace") -> str:
    """Write df as a table and return the name actually used (see module docstring)."""
    name = (name or "").strip()
    if not IDENT.match(name):
        raise UnsafeIdentifier(f"{name!r} is not a valid table name (letters, digits and _ only)")
    if is_internal(engine):
        df.to_sql(name, engine, if_exists=if_exists, index=False)
        return name
    existing = known_tables(engine, refresh=True)
    owned = owned_tables(engine)
    final = name
    if final.lower() in existing and final.lower() not in owned:      # the user's own table: never touch it
        base, i = f"{name[:55]}_uaa", 2
        final = base
        while final.lower() in existing and final.lower() not in owned:
            final, i = f"{base}{i}", i + 1
    df.to_sql(final, engine, if_exists=if_exists, index=False)
    _remember(engine, final)
    _cache.pop(_db_key(engine), None)
    return final


def write_note(requested: str, actual: str) -> str:
    """Sentence for tool output when write_table had to use another name."""
    if requested == actual:
        return ""
    return (f" NOTE: '{requested}' already exists in the user's database and belongs to them, so it was NOT "
            f"changed; the result was saved as '{actual}' instead. Use '{actual}' from now on.")
