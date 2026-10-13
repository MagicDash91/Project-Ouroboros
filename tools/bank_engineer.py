"""
tools/bank_engineer.py – Banking ETL / data-warehouse tools.
Mirrors Bank_Agent/tools/engineer_tools.py with paths adjusted to this system.
"""

import os
import json
import warnings
import pandas as pd
import numpy as np
from datetime import datetime
from typing import Any

warnings.filterwarnings("ignore")

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crewai.tools import tool
from sqlalchemy import text
from features.db_connect import cached_engine as create_engine   # one shared pool per database

from config import POSTGRES_URI, TAVILY_API_KEY, query_ollama as query_nvidia


def _get_db_uri() -> str:
    """Return the active database URI (set per-run via ACTIVE_DB_URI env var)."""
    return os.environ.get("ACTIVE_DB_URI") or POSTGRES_URI


def _db_dialect(uri: str) -> str:
    """Detect database dialect from URI prefix."""
    uri = uri.lower()
    if uri.startswith("snowflake"):
        return "snowflake"
    if uri.startswith("mysql") or uri.startswith("mariadb"):
        return "mysql"
    if uri.startswith("sqlite"):
        return "sqlite"
    if uri.startswith("mssql") or uri.startswith("sqlserver"):
        return "mssql"
    if uri.startswith("bigquery"):
        return "bigquery"
    return "postgresql"  # default


def _get_yfinance():
    try:
        import yfinance as yf
        return yf
    except ImportError:
        return None


def _get_tavily():
    if not TAVILY_API_KEY:
        return None
    try:
        from langchain_community.tools.tavily_search import TavilySearchResults
        return TavilySearchResults(k=5)
    except ImportError:
        return None


@tool("Profile Database Table")
def profile_database_table(table_name: str) -> str:
    """
    Read a table from PostgreSQL, profile its quality, and return a full data summary.

    Args:
        table_name: Name of the PostgreSQL table to profile.

    Returns:
        JSON with the full quality profile.
    """
    try:
        engine = create_engine(_get_db_uri())
        df = pd.read_sql(f"SELECT * FROM {table_name} LIMIT 10000", engine)   # sample for stats
        with engine.connect() as conn:
            total_rows = int(conn.execute(text(f"SELECT COUNT(*) FROM {table_name}")).scalar() or 0)

        # Build a concise profile — deliberately kept short so LLM context isn't overwhelmed
        columns_detail = []
        for col in df.columns:
            sample_vals = df[col].dropna().iloc[:3].astype(str).tolist() if df[col].notna().any() else []
            columns_detail.append({
                "name":   col,
                "dtype":  str(df[col].dtype),
                "nulls":  int(df[col].isna().sum()),
                "unique": int(df[col].nunique()),
                "sample": sample_vals,
            })

        # Only include numeric range stats (no median — keeps output short)
        numeric_stats = {}
        for col in list(df.select_dtypes(include=np.number).columns)[:8]:
            numeric_stats[col] = {
                "mean": round(float(df[col].mean()), 2),
                "std":  round(float(df[col].std()),  2),
                "min":  round(float(df[col].min()),  2),
                "max":  round(float(df[col].max()),  2),
            }

        # Only include top-3 values for a few low-cardinality categorical columns
        cat_distributions = {}
        for col in list(df.select_dtypes(include="object").columns)[:5]:
            if df[col].nunique() <= 20:
                # Keys may be dates/decimals; JSON keys must be strings.
                cat_distributions[col] = {str(k): int(v) for k, v in df[col].value_counts().head(3).items()}

        profile = {
            "status":        "success",
            "table":         table_name,
            "rows":          total_rows,
            "sampled_rows":  len(df),
            "column_count":  len(df.columns),
            "columns":       list(df.columns),
            "columns_detail": columns_detail,
            "numeric_stats":  numeric_stats,
            "categorical_distributions": cat_distributions,
        }

        return json.dumps(profile, indent=2, default=str)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Fetch Financial Market Data")
def fetch_financial_data(symbol: str, period: str = "1y", interval: str = "1d") -> str:
    """
    Fetch historical financial market data for a given ticker and store in PostgreSQL.

    Args:
        symbol:   Stock ticker (e.g. 'BBCA.JK', 'BMRI.JK', 'JPM').
        period:   Date range – '1d','5d','1mo','3mo','6mo','1y','2y','5y','max'.
        interval: Bar size – '1d','1wk','1mo'.

    Returns:
        JSON summary with table name, row count, date range, latest close, price change %.
    """
    yf = _get_yfinance()
    if yf is None:
        return json.dumps({"status": "error", "message": "yfinance not installed."})
    try:
        ticker = yf.Ticker(symbol)
        df = ticker.history(period=period, interval=interval)
        if df.empty:
            return json.dumps({"status": "error", "message": f"No data for symbol '{symbol}'"})
        df.reset_index(inplace=True)
        for col in df.columns:
            if "date" in str(col).lower() or str(df[col].dtype).startswith("datetime"):
                df[col] = df[col].astype(str)
        df.columns = [str(c).split(" ")[0] for c in df.columns]
        df.dropna(axis=1, how="all", inplace=True)

        table_name = f"market_{symbol.replace('.', '_').replace('-', '_').lower()}"
        engine = create_engine(_get_db_uri())
        df.to_sql(table_name, engine, if_exists="replace", index=False)

        latest_close  = float(df["Close"].iloc[-1])
        initial_close = float(df["Close"].iloc[0])
        pct_change    = round((latest_close - initial_close) / initial_close * 100, 2)

        return json.dumps({
            "status":         "success",
            "symbol":         symbol,
            "table":          table_name,
            "rows":           len(df),
            "date_range":     f"{df['Date'].iloc[0]} to {df['Date'].iloc[-1]}",
            "latest_close":   latest_close,
            "price_change_%": pct_change,
        }, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Fetch Indonesian Bank Data")
def fetch_indonesian_bank_data(bank_code: str = "BBCA") -> str:
    """
    Fetch historical prices + company fundamentals for a major Indonesian bank.

    Args:
        bank_code: Bank ticker without '.JK' (BBCA, BMRI, BBRI, BBNI, BRIS).

    Returns:
        JSON with historical data summary and key fundamentals.
    """
    yf = _get_yfinance()
    if yf is None:
        return json.dumps({"status": "error", "message": "yfinance not installed."})
    try:
        symbol = f"{bank_code.upper()}.JK"
        ticker = yf.Ticker(symbol)
        hist   = ticker.history(period="1y")
        hist.reset_index(inplace=True)
        hist["Date"] = hist["Date"].astype(str)
        hist.columns = [str(c).split(" ")[0] for c in hist.columns]

        info = {}
        try:
            info = ticker.info or {}
        except Exception:
            pass

        table_name = f"bank_{bank_code.lower()}_historical"
        engine = create_engine(_get_db_uri())
        hist.to_sql(table_name, engine, if_exists="replace", index=False)

        return json.dumps({
            "status":          "success",
            "bank":            bank_code,
            "symbol":          symbol,
            "table":           table_name,
            "historical_rows": len(hist),
            "company_info": {
                "name":           info.get("longName", bank_code),
                "market_cap":     info.get("marketCap", 0),
                "pe_ratio":       info.get("trailingPE", 0),
                "pb_ratio":       info.get("priceToBook", 0),
            },
        }, indent=2, default=str)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Search and Collect Web Data")
def web_search_collect(query: str) -> str:
    """
    Search the web for banking/financial information and save results to PostgreSQL.

    Args:
        query: Search query string.

    Returns:
        JSON with result titles, URLs, and storage confirmation.
    """
    tavily = _get_tavily()
    if tavily is None:
        return json.dumps({"status": "error", "message": "Tavily not available. Check TAVILY_API_KEY."})
    try:
        results = tavily.invoke(query)
        if not results:
            return json.dumps({"status": "success", "message": "No results found", "results_count": 0})

        records = []
        for r in results:
            records.append({
                "query":        query,
                "url":          r.get("url", ""),
                "title":        r.get("title", ""),
                "content":      r.get("content", "")[:2000],
                "score":        float(r.get("score", 0)),
                "collected_at": datetime.now().isoformat(),
            })

        df = pd.DataFrame(records)
        engine = create_engine(_get_db_uri())
        df.to_sql("web_research_data", engine, if_exists="append", index=False)

        return json.dumps({
            "status":        "success",
            "results_count": len(results),
            "saved_table":   "web_research_data",
            "preview": [{"title": r.get("title", ""), "url": r.get("url", "")} for r in results[:3]],
        }, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Run ETL Pipeline")
def run_etl_pipeline(data_source: str, target_table: str, transformations: str = "{}") -> str:
    """
    Execute a complete ETL pipeline: Extract → Transform → Load into PostgreSQL.

    Args:
        data_source:     Source descriptor ('yfinance:<TICKER>', 'multiple_stocks:<T1>,<T2>', 'csv:<path>').
        target_table:    Destination PostgreSQL table name.
        transformations: JSON string with optional transform rules.

    Returns:
        JSON summary with rows loaded, columns, dtypes.
    """
    yf = _get_yfinance()
    try:
        source_type, source_value = data_source.split(":", 1)
        df = None

        if source_type == "yfinance":
            if yf is None:
                return json.dumps({"status": "error", "message": "yfinance not installed."})
            ticker = yf.Ticker(source_value.strip())
            df = ticker.history(period="1y")
            df.reset_index(inplace=True)
        elif source_type == "multiple_stocks":
            if yf is None:
                return json.dumps({"status": "error", "message": "yfinance not installed."})
            symbols = [s.strip() for s in source_value.split(",")]
            dfs = []
            for sym in symbols:
                t = yf.Ticker(sym)
                temp = t.history(period="1y")
                temp["symbol"] = sym
                temp.reset_index(inplace=True)
                dfs.append(temp)
            df = pd.concat(dfs, ignore_index=True)
        elif source_type == "csv":
            df = pd.read_csv(source_value)
        else:
            return json.dumps({"status": "error", "message": f"Unknown source type: {source_type}"})

        if df is None or df.empty:
            return json.dumps({"status": "error", "message": "Extraction returned empty data."})

        for col in df.columns:
            if str(df[col].dtype).startswith("datetime"):
                df[col] = df[col].astype(str)
        df.columns = [str(c).split(" ")[0] for c in df.columns]
        df.dropna(axis=1, how="all", inplace=True)

        trans = {}
        try:
            trans = json.loads(transformations) if transformations else {}
        except json.JSONDecodeError:
            pass

        if trans.get("rename_columns"):
            df.rename(columns=trans["rename_columns"], inplace=True)
        if trans.get("drop_columns"):
            df.drop(columns=trans["drop_columns"], errors="ignore", inplace=True)
        if trans.get("add_timestamp"):
            df["etl_timestamp"] = datetime.now().isoformat()

        engine = create_engine(_get_db_uri())
        df.to_sql(target_table, engine, if_exists="replace", index=False)

        return json.dumps({
            "status":       "success",
            "source":       data_source,
            "target_table": target_table,
            "rows_loaded":  len(df),
            "columns":      list(df.columns),
        }, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Clean Table Columns")
def clean_table_columns(table_name: str) -> str:
    """
    Remove identifier columns (customerID, id, uuid) and low-value columns
    (all-null, single-value) from the specified database table, in place.

    Args:
        table_name: Name of the database table to clean.

    Returns:
        JSON with dropped columns, kept columns, and row count.
    """
    try:
        engine = create_engine(_get_db_uri())
        df = pd.read_sql(f"SELECT * FROM {table_name} LIMIT 10000", engine)
        original_cols = list(df.columns)
        dropped = []

        id_patterns = {"customerid", "id", "customer_id", "index", "uuid", "row_id", "rowid"}
        for col in original_cols:
            if col.lower() in id_patterns:
                dropped.append(col)
        for col in original_cols:
            if col not in dropped and df[col].isna().all():
                dropped.append(col)
        for col in original_cols:
            if col not in dropped and df[col].nunique(dropna=False) <= 1:
                dropped.append(col)

        df.drop(columns=dropped, errors="ignore", inplace=True)
        df.to_sql(table_name, engine, if_exists="replace", index=False)

        return json.dumps({
            "status":          "success",
            "table":           table_name,
            "dropped_columns": dropped,
            "kept_columns":    list(df.columns),
            "row_count":       len(df),
        }, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Normalize Column Data Types")
def normalize_column_dtypes(table_name: str) -> str:
    """
    Detect object/string columns whose values are actually numeric (≥90% numeric)
    and cast them to float64 or int64. Fixes columns like MonthlyCharges, TotalCharges
    that are stored as strings but contain numbers.

    Args:
        table_name: Name of the database table to normalize (overwritten in place).

    Returns:
        JSON with per-column conversion results and the final dtype map.
    """
    numeric_threshold = 0.90
    try:
        engine = create_engine(_get_db_uri())
        df = pd.read_sql(f"SELECT * FROM {table_name} LIMIT 10000", engine)

        converted = {}
        unchanged = {}

        for col in df.select_dtypes(include=["object"]).columns:
            series = df[col].str.strip() if df[col].dtype == object else df[col]
            numeric_series = pd.to_numeric(series, errors="coerce")
            non_null_count = series.notna().sum()

            if non_null_count == 0:
                unchanged[col] = "all null"
                continue

            ratio = numeric_series.notna().sum() / non_null_count

            if ratio >= numeric_threshold:
                has_decimal = series.dropna().str.contains(r"\.", regex=True).any()
                if has_decimal:
                    df[col] = numeric_series.astype("float64")
                    converted[col] = "float64"
                else:
                    df[col] = pd.to_numeric(numeric_series, errors="coerce").astype("float64")
                    if df[col].isna().sum() == 0:
                        df[col] = df[col].astype("int64")
                        converted[col] = "int64"
                    else:
                        converted[col] = "float64"
            else:
                unchanged[col] = f"only {ratio:.0%} numeric — kept as string"

        df.to_sql(table_name, engine, if_exists="replace", index=False)

        return json.dumps({
            "status":            "success",
            "table":             table_name,
            "columns_converted": converted,
            "columns_unchanged": unchanged,
            "row_count":         len(df),
        }, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("List Database Tables")
def list_database_tables() -> str:
    """
    List all user tables in the connected database.
    Supports PostgreSQL, Snowflake, MySQL, SQLite, MSSQL, and BigQuery.

    Returns:
        JSON array of {table, size} objects.
    """
    try:
        uri     = _get_db_uri()
        dialect = _db_dialect(uri)
        engine  = create_engine(uri)

        # Dialect-specific queries
        if dialect == "snowflake":
            sql = "SELECT TABLE_NAME, TABLE_SCHEMA FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = CURRENT_SCHEMA() ORDER BY TABLE_NAME"
            with engine.connect() as conn:
                result = conn.execute(text(sql))
                tables = [{"table": row[0], "size": f"schema:{row[1]}"} for row in result]

        elif dialect == "mysql":
            sql = "SELECT TABLE_NAME, ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024, 1) AS size_kb FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME"
            with engine.connect() as conn:
                result = conn.execute(text(sql))
                tables = [{"table": row[0], "size": f"{row[1]} KB"} for row in result]

        elif dialect == "sqlite":
            sql = "SELECT name, 'n/a' FROM sqlite_master WHERE type='table' ORDER BY name"
            with engine.connect() as conn:
                result = conn.execute(text(sql))
                tables = [{"table": row[0], "size": row[1]} for row in result]

        elif dialect == "mssql":
            sql = "SELECT TABLE_NAME, TABLE_SCHEMA FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
            with engine.connect() as conn:
                result = conn.execute(text(sql))
                tables = [{"table": row[0], "size": f"schema:{row[1]}"} for row in result]

        else:
            # PostgreSQL (default)
            # The dbt schemas (tested marts first) plus every schema on the search path.
            # Listed explicitly: managed poolers such as Supabase's ignore a per-connection
            # search_path, so the marts can't be relied on to appear via search_path alone.
            sql = """
                WITH s AS (
                    SELECT name, MIN(pos) AS pos FROM (
                        SELECT 'uaa_marts' AS name, -2 AS pos
                        UNION ALL SELECT 'uaa_staging', -1
                        UNION ALL SELECT name, pos FROM unnest(current_schemas(false)) WITH ORDINALITY AS c(name, pos)
                    ) x GROUP BY name
                )
                SELECT t.table_name, t.table_schema,
                       pg_size_pretty(pg_total_relation_size(
                           quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))) AS size
                FROM information_schema.tables t JOIN s ON s.name = t.table_schema
                ORDER BY s.pos, t.table_name
            """
            with engine.connect() as conn:
                result = conn.execute(text(sql))
                tables = [{"table": row[0], "schema": row[1], "qualified": f"{row[1]}.{row[0]}",
                           "size": row[2], **({"note": "dbt mart: cleaned, typed, tested"} if row[1] == "uaa_marts" else {})}
                          for row in result]

        return json.dumps({"status": "success", "dialect": dialect, "count": len(tables), "tables": tables}, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Build dbt Models")
def build_dbt_models(goal: str) -> str:
    """
    Model the raw data properly with dbt (PostgreSQL). Designs staging + mart models with
    dbt tests, then runs `dbt build` into the uaa_staging / uaa_marts schemas. Raw tables are
    never modified. After a successful build, plain table names in this run resolve to the
    tested marts first, so downstream agents should use the returned mart names.

    Args:
        goal: One sentence on what the data must support, e.g. "analyse and reduce customer churn".

    Returns:
        JSON with the mart tables to use, each model's status, and dbt test results.
    """
    try:
        from tools.dbt_builder import build_dbt_project, with_mart_search_path
        uri = _get_db_uri()
        if _db_dialect(uri) != "postgresql":
            return json.dumps({"status": "skipped",
                               "message": "dbt modelling needs PostgreSQL; use clean/normalize tools instead."})
        run = build_dbt_project(goal=goal, db_uri=uri)
        marts = [m for m in run["models"] if m["layer"] == "marts" and m["status"] == "success"]
        if run["ok"] and marts:
            os.environ["ACTIVE_DB_URI"] = with_mart_search_path(uri)
        failed = [t for t in run["tests"] if t["status"] not in ("pass", "success")]
        return json.dumps({
            "status": "success" if run["ok"] else "partial",
            "use_tables": [m["name"] for m in marts],
            "models": [{k: m[k] for k in ("name", "layer", "status", "description")} for m in run["models"]],
            "tests_passed": len(run["tests"]) - len(failed),
            "tests_failed": [{"test": t["name"], "message": t["message"][:200]} for t in failed],
            "lineage": run["lineage"],
            "dbt_run_id": run["id"],
            "note": ("Use the mart tables in use_tables as the primary analysis tables — they are cleaned, "
                     "typed and tested. Do not run clean/normalize tools on raw tables."),
        }, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)[:500]})


@tool("Query Database")
def query_database(sql_query: str) -> str:
    """
    Execute a SQL SELECT query against the connected database.

    Args:
        sql_query: A valid SELECT statement (no DDL/DML).

    Returns:
        JSON with column names and up to 200 rows of results.
    """
    sql_query = sql_query.strip().rstrip(";").strip()
    if not sql_query.upper().startswith(("SELECT", "WITH")):
        return json.dumps({"status": "error", "message": "Only SELECT queries are allowed."})
    if ";" in sql_query:
        return json.dumps({"status": "error", "message": "Only one SELECT statement per call (no ';')."})
    try:
        # Inject LIMIT 10000 if the query has no limit, to avoid full scans on large tables
        if "LIMIT" not in sql_query.upper():
            sql_query = sql_query.rstrip().rstrip(";") + " LIMIT 10000"
        engine = create_engine(_get_db_uri())
        # Raw driver SQL: pandas/SQLAlchemy would treat '%' (e.g. ILIKE '%x%') as a bind
        # placeholder and fail with "immutabledict is not a sequence".
        # Raw DB-API cursor with NO parameters, so the driver never treats '%' as a placeholder.
        with engine.connect() as conn:
            raw = conn.connection
            cur = raw.cursor()
            try:
                if engine.dialect.name == "postgresql":
                    cur.execute("SET TRANSACTION READ ONLY")      # writes fail at the database
                cur.execute(sql_query)
                cols = [d[0] for d in cur.description] if cur.description else []
                df = pd.DataFrame(cur.fetchall() if cols else [], columns=cols)
            finally:
                cur.close()
                raw.rollback()
        return json.dumps({
            "status":  "success",
            "rows":    len(df),
            "columns": list(df.columns),
            "data":    df.head(200).to_dict(orient="records"),
        }, indent=2, default=str)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})
