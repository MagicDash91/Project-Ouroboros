"""
features/db_connect.py – accept a database connection string from any provider.

Users paste whatever their console gives them: provider URIs (postgres://, mysql://),
JDBC strings, Azure/ODBC "Server=…;Database=…" strings, or plain SQLAlchemy URIs.
`normalize_db_uri` turns all of these into one working SQLAlchemy URI:

  * maps driverless schemes to installed drivers (mysql → mysql+pymysql, mssql →
    mssql+pymssql, oracle → oracle+oracledb, redshift → redshift+psycopg2, …);
  * adds SSL for managed cloud Postgres hosts that require it (Supabase, Neon, RDS,
    Azure, Aiven, Render, …) unless the URI already says otherwise;
  * applies an optional schema the way each engine expects (Postgres/Redshift
    search_path, MySQL database, Snowflake/BigQuery path).

`test_connection` connects with a timeout, lists schemas/tables, and explains failures
in plain language (credentials, firewall/allow-list per provider, missing driver, …).
"""

import importlib
import re
from typing import Optional
from urllib.parse import parse_qsl, quote, unquote

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

# scheme (as typed) → (SQLAlchemy driver, engine label, pip package, import name)
_SCHEMES = {
    "postgres":   ("postgresql+psycopg2", "PostgreSQL", "psycopg2-binary", "psycopg2"),
    "postgresql": ("postgresql+psycopg2", "PostgreSQL", "psycopg2-binary", "psycopg2"),
    "pgsql":      ("postgresql+psycopg2", "PostgreSQL", "psycopg2-binary", "psycopg2"),
    "redshift":   ("redshift+psycopg2", "Amazon Redshift", "sqlalchemy-redshift", "sqlalchemy_redshift"),
    "mysql":      ("mysql+pymysql", "MySQL", "pymysql", "pymysql"),
    "mariadb":    ("mysql+pymysql", "MariaDB", "pymysql", "pymysql"),
    "mssql":      ("mssql+pymssql", "SQL Server", "pymssql", "pymssql"),
    "sqlserver":  ("mssql+pymssql", "SQL Server", "pymssql", "pymssql"),
    "oracle":     ("oracle+oracledb", "Oracle", "oracledb", "oracledb"),
    "snowflake":  ("snowflake", "Snowflake", "snowflake-sqlalchemy", "snowflake.sqlalchemy"),
    "bigquery":   ("bigquery", "BigQuery", "sqlalchemy-bigquery", "sqlalchemy_bigquery"),
    "sqlite":     ("sqlite", "SQLite", "", ""),
    "duckdb":     ("duckdb", "DuckDB", "duckdb-engine", "duckdb_engine"),
}

# host pattern → (provider label, network-access hint shown when the server is unreachable)
_PROVIDERS = [
    (r"supabase\.(co|com)$", "Supabase", "Use the Session pooler URI from Supabase → Connect (the direct host is IPv6-only)."),
    (r"neon\.tech$", "Neon", "Check the project isn't suspended and the URI is from Neon → Connection Details."),
    (r"redshift(-serverless)?\.amazonaws\.com$", "Amazon Redshift", "Allow your IP in the cluster's VPC security group and enable public access."),
    (r"rds\.amazonaws\.com$", "AWS RDS / Aurora", "Allow your IP in the DB instance's VPC security group (inbound rule) and enable public access."),
    (r"postgres\.database\.azure\.com$", "Azure Database for PostgreSQL", "Add your client IP under Networking → Firewall rules."),
    (r"mysql\.database\.azure\.com$", "Azure Database for MySQL", "Add your client IP under Networking → Firewall rules."),
    (r"database\.windows\.net$", "Azure SQL Database", "Add your client IP under the server's Networking → Firewall rules."),
    (r"snowflakecomputing\.com$", "Snowflake", "Check the account identifier and any network policy on your user."),
    (r"aivencloud\.com$", "Aiven", "Check allowed IP addresses on the Aiven service."),
    (r"render\.com$", "Render", "Use the External Database URL and add your IP to the access control list."),
    (r"ondigitalocean\.com$", "DigitalOcean", "Add your IP as a Trusted Source on the cluster."),
    (r"(psdb\.cloud|planetscale)", "PlanetScale", "Generate a new password; PlanetScale requires SSL."),
    (r"tsdb\.cloud\.timescale\.com$", "Timescale", "Check the service is running and your IP is allowed."),
    (r"cockroachlabs\.cloud$", "CockroachDB Cloud", "Add your IP to the cluster's IP allowlist."),
    (r"^(localhost|127\.0\.0\.1|::1|host\.docker\.internal)$", "Local", "Check the database server is running and listening on that port."),
]
# Managed Postgres hosts that need SSL by default.
_SSL_HOSTS = re.compile(r"(supabase\.(co|com)|neon\.tech|rds\.amazonaws\.com|redshift\.amazonaws\.com|database\.azure\.com|"
                        r"aivencloud\.com|render\.com|ondigitalocean\.com|tsdb\.cloud\.timescale\.com|cockroachlabs\.cloud)$")


class ConnectionStringError(ValueError):
    pass


# ── Parsing alternative formats ───────────────────────────────────────────────

def _from_kv(raw: str) -> str:
    """Azure / ADO.NET / ODBC style: Server=tcp:host,1433;Database=db;User ID=u;Password=p;…"""
    kv = {}
    for part in raw.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            kv[k.strip().lower().replace(" ", "")] = v.strip().strip("{}")
    host = kv.get("server") or kv.get("datasource") or kv.get("host") or kv.get("address") or ""
    host = re.sub(r"^tcp:", "", host, flags=re.I)
    port = ""
    if "," in host:
        host, port = host.split(",", 1)
    elif kv.get("port"):
        port = kv["port"]
    db = kv.get("database") or kv.get("initialcatalog") or kv.get("databasename") or ""
    user = kv.get("userid") or kv.get("uid") or kv.get("user") or kv.get("username") or ""
    pw = kv.get("password") or kv.get("pwd") or ""
    if not host:
        raise ConnectionStringError("Couldn't find Server=… in that connection string.")
    low = raw.lower()
    scheme = "postgresql" if ("postgres" in low or port == "5432") else "mysql" if ("mysql" in low or port == "3306") else "mssql"
    auth = f"{quote(user, safe='')}:{quote(pw, safe='')}@" if user else ""
    return f"{scheme}://{auth}{host}{':' + port if port else ''}/{quote(db, safe='')}"


def _from_jdbc(raw: str) -> str:
    """jdbc:postgresql://h:5432/db?user=u&password=p  |  jdbc:sqlserver://h:1433;databaseName=db;user=u;password=p"""
    s = raw[5:]
    if s.lower().startswith("sqlserver://"):
        head, _, rest = s[len("sqlserver://"):].partition(";")
        return _from_kv(f"Server={head.replace(':', ',')};{rest}")
    m = re.match(r"^([a-z0-9+]+)://([^/?]+)(/[^?]*)?(\?.*)?$", s, re.I)
    if not m:
        return s
    scheme, hostport, path, query = m.group(1), m.group(2), m.group(3) or "", (m.group(4) or "")[1:]
    params = dict(parse_qsl(query, keep_blank_values=True))
    user, pw = params.pop("user", ""), params.pop("password", "")
    auth = f"{quote(user, safe='')}:{quote(pw, safe='')}@" if user and "@" not in hostport else ""
    rest = "&".join(f"{k}={quote(v, safe='')}" for k, v in params.items())
    return f"{scheme}://{auth}{hostport}{path}{'?' + rest if rest else ''}"


def _fix_password(s: str) -> str:
    """Percent-encode an un-encoded password containing @ / # ? (a common copy-paste mistake)."""
    m = re.match(r"^([a-z0-9+]+://)([^:/@]+):(.+)@([^@/]+(?::\d+)?(?:[/?].*)?)$", s, re.I)
    if not m or not re.search(r"[@/#?]", m.group(3)):
        return s
    return f"{m.group(1)}{m.group(2)}:{quote(unquote(m.group(3)), safe='')}@{m.group(4)}"


# ── Public API ────────────────────────────────────────────────────────────────

def normalize_db_uri(raw: str, schema: str = "") -> str:
    """Return a SQLAlchemy URI for any common connection-string format. Raises ConnectionStringError."""
    s = (raw or "").strip().strip("'\"")
    if not s:
        raise ConnectionStringError("Empty connection string.")
    if s.lower().startswith("jdbc:"):
        s = _from_jdbc(s)
    elif "://" not in s and ";" in s and "=" in s:
        s = _from_kv(s)
    if "://" not in s:
        raise ConnectionStringError("That doesn't look like a connection string (expected something like "
                                    "postgresql://user:password@host:5432/database).")
    s = _fix_password(s)

    scheme = s.split("://", 1)[0].lower()
    base = scheme.split("+", 1)[0]
    if base not in _SCHEMES:
        raise ConnectionStringError(f"Unsupported database type '{base}'. Supported: "
                                    + ", ".join(sorted({v[1] for v in _SCHEMES.values()})) + ".")
    if scheme.startswith("postgresql+asyncpg") or "+" not in scheme or base in ("postgres", "pgsql", "sqlserver", "mariadb"):
        s = _SCHEMES[base][0] + s[len(scheme):]

    try:
        u = make_url(s)
    except Exception as e:
        raise ConnectionStringError(f"Couldn't parse that connection string: {e}")

    query = dict(u.query)
    host = (u.host or "").lower()
    family = u.get_backend_name()
    if family in ("postgresql", "redshift") and "sslmode" not in query and _SSL_HOSTS.search(host):
        query["sslmode"] = "require"

    schema = (schema or "").strip()
    if schema:
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_$]*$", schema):
            raise ConnectionStringError("Schema names may only contain letters, digits, _ and $.")
        if family in ("postgresql", "redshift"):
            query["options"] = f"-csearch_path={schema},public"
        elif family == "mysql":
            u = u.set(database=schema)
        elif family == "snowflake":
            db = (u.database or "").split("/")[0]
            u = u.set(database=f"{db}/{schema}" if db else schema)
        elif family == "bigquery":
            u = u.set(database=schema)
    return u.set(query=query).render_as_string(hide_password=False)


def describe(uri: str) -> dict:
    u = make_url(uri)
    host = (u.host or "").lower()
    base = u.get_backend_name()
    engine = next((v[1] for v in _SCHEMES.values() if v[0].split("+")[0] == base), base)
    provider, hint = "Self-hosted", "Check the host and port, and that the server accepts remote connections."
    if base in ("sqlite", "duckdb"):
        provider, hint = "Local file", "Check the file path exists."
    elif base == "bigquery":
        provider, hint = "Google BigQuery", "Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key with BigQuery access."
    elif base == "snowflake":
        provider, hint = "Snowflake", "Check the account identifier, warehouse, and any network policy on your user."
    else:
        for pat, name, h in _PROVIDERS:
            if re.search(pat, host):
                provider, hint = name, h
                break
        else:
            if re.match(r"^\d+\.\d+\.\d+\.\d+$", host):
                hint = ("If this is GCP Cloud SQL, add your IP under Connections → Authorized networks "
                        "(or run the Cloud SQL Auth Proxy and connect to 127.0.0.1).")
    return {"engine": engine, "provider": provider, "network_hint": hint,
            "masked": u.render_as_string(hide_password=True), "dialect": base}


def driver_status(uri: str) -> Optional[str]:
    """None if the driver is installed, else the pip package to install."""
    base = make_url(uri).get_backend_name()
    for drv, _, pkg, mod in _SCHEMES.values():
        if drv.split("+")[0] == base and mod:
            try:
                importlib.import_module(mod)
                return None
            except Exception:
                return pkg
    return None


def _explain(err: str, info: dict) -> str:
    e = err.lower()
    if any(k in e for k in ("password authentication failed", "access denied", "login failed", "invalid username",
                            "authentication failed", "incorrect username or password", "28p01")):
        return "Wrong username or password."
    if ("database" in e and "does not exist" in e) or "unknown database" in e or "cannot open database" in e:
        return "That database name doesn't exist on the server — check the part after the last '/'."
    if "ssl" in e and ("required" in e or "encryption" in e):
        return "The server requires SSL — add ?sslmode=require (Postgres) to the connection string."
    if "no pg_hba.conf entry" in e:
        return "The server rejected this connection (pg_hba.conf). " + info["network_hint"]
    if any(k in e for k in ("timeout", "timed out", "could not connect", "connection refused", "unreachable",
                            "name or service not known", "could not translate host", "getaddrinfo",
                            "adaptive server is unavailable", "network is unreachable")):
        return "Can't reach the server. " + info["network_hint"]
    return err.splitlines()[0][:300]


def _connect_args(base: str) -> dict:
    return {"postgresql": {"connect_timeout": 15}, "redshift": {"connect_timeout": 15},
            "mysql": {"connect_timeout": 15}, "mssql": {"login_timeout": 15, "timeout": 30}}.get(base, {})


_ENGINES: dict = {}
_ENGINES_LOCK = __import__("threading").Lock()


def cached_engine(uri, **kwargs):
    """One shared, small connection pool per database URI.

    Creating a new engine per call leaks idle pooled connections; managed poolers cap
    clients (Supabase session mode: 15), so the app must reuse a single pool per database.
    """
    key = uri.render_as_string(hide_password=False) if hasattr(uri, "render_as_string") else str(uri)
    with _ENGINES_LOCK:
        eng = _ENGINES.get(key)
        if eng is None:
            backend = make_url(key).get_backend_name()
            opts = {"pool_pre_ping": True, "pool_recycle": 300}
            if backend not in ("sqlite", "duckdb"):
                opts.update(pool_size=2, max_overflow=3, pool_timeout=60)
            ca = {**_connect_args(backend), **kwargs.pop("connect_args", {})}
            if ca:
                opts["connect_args"] = ca
            eng = create_engine(key, **{**opts, **kwargs})
            _ENGINES[key] = eng
        return eng


def test_connection(raw: str, schema: str = "", max_tables: int = 60) -> dict:
    """Normalize, connect, and summarise the database. Never raises — returns ok/error."""
    try:
        uri = normalize_db_uri(raw, schema)
    except ConnectionStringError as e:
        return {"ok": False, "error": str(e)}
    info = describe(uri)
    out = {"ok": False, **{k: info[k] for k in ("engine", "provider", "masked", "dialect")}}
    missing = driver_status(uri)
    if missing:
        return {**out, "error": f"The {info['engine']} driver isn't installed. Install it with: pip install {missing}"}
    try:
        eng = create_engine(uri, connect_args=_connect_args(info["dialect"]), pool_pre_ping=True)
        with eng.connect() as c:
            version_sql = {"mssql": "SELECT @@VERSION", "oracle": "SELECT banner FROM v$version WHERE ROWNUM = 1",
                           "snowflake": "SELECT CURRENT_VERSION()", "bigquery": "SELECT 'BigQuery'",
                           "sqlite": "SELECT 'SQLite ' || sqlite_version()"}.get(info["dialect"], "SELECT version()")
            try:
                version = str(c.execute(text(version_sql)).scalar())[:80]
            except Exception:
                version = ""
                c.rollback()
            if info["dialect"] in ("postgresql", "redshift"):
                path = [r[0] for r in c.execute(text("SELECT unnest(current_schemas(false))")).fetchall()]
                rows = c.execute(text(
                    "SELECT n.nspname, c.relname, GREATEST(c.reltuples, 0)::bigint, c.relkind FROM pg_class c "
                    "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','v','m','p') "
                    "AND n.nspname NOT IN ('pg_catalog','information_schema','auth','storage','realtime','extensions',"
                    "'graphql','graphql_public','vault','pgsodium','pgsodium_masks','net','supabase_functions',"
                    "'supabase_migrations','cron','pgbouncer') AND n.nspname NOT LIKE 'pg\\_%' "
                    "ORDER BY n.nspname, c.relname LIMIT :n"), {"n": max_tables}).fetchall()
                schemas: dict = {}
                for s, t, est, kind in rows:
                    schemas.setdefault(s, []).append({"name": t, "rows": int(est) if kind != "v" else None,
                                                      "view": kind == "v"})
            else:
                insp = inspect(eng)
                default = insp.default_schema_name
                path = [default] if default else []
                schemas = {(default or "default"): [{"name": t, "rows": None, "view": False}
                                                    for t in insp.get_table_names()[:max_tables]]}
        eng.dispose()
        visible = [s for s in path if s in schemas]
        hint = None
        if info["dialect"] in ("postgresql", "redshift") and schemas and not visible:
            hint = f"Your tables are in schema '{next(iter(schemas))}' — enter it in the Schema field."
        return {**out, "ok": True, "version": version, "search_path": path, "hint": hint,
                "schemas": [{"name": s, "tables": t, "visible": s in visible} for s, t in schemas.items()]}
    except Exception as e:
        return {**out, "error": _explain(str(e), info)}
