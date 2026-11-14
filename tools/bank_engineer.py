"""
tools/bank_engineer.py – Banking ETL / data-warehouse tools.
Mirrors Bank_Agent/tools/engineer_tools.py with paths adjusted to this system.
"""

import os
import re
import json
import warnings
from pathlib import Path
import pandas as pd
import numpy as np
from datetime import datetime
from typing import Any

warnings.filterwarnings("ignore")

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crewai.tools import tool
from tools.db_safety import safe_table, safe_columns, write_table, write_note, read_only_query
from sqlalchemy import text
from features.db_connect import cached_engine as create_engine   # one shared pool per database

from config import POSTGRES_URI, TAVILY_API_KEY, query_ollama as query_nvidia


def _get_db_uri() -> str:
    """Return the active database URI (this run's database; see tools/run_context.py)."""
    from tools.run_context import current_db
    return current_db()


_CSV_ROOTS = ("data", "outputs")      # uploads and run outputs; never .env, code or other folders


def _workspace_csv(path: str) -> str:
    """'csv:<path>' may only name a .csv/.tsv file under the project's data/ or outputs/ folders:
    no URLs (SSRF), no absolute paths elsewhere, no ../ escapes, no secrets files."""
    raw = (path or "").strip().strip('"').strip("'")
    if "://" in raw or raw.startswith(("\\\\", "//")):
        raise ValueError("csv: takes a file from the workspace, not a URL")
    base = Path(__file__).resolve().parent.parent
    p = Path(raw)
    p = (p if p.is_absolute() else base / p).resolve()
    if p.suffix.lower() not in (".csv", ".tsv", ".txt") or not p.is_file():
        raise ValueError(f"csv: file not found or not a .csv/.tsv file: {raw}")
    if not any(root in p.parents for root in (base / r for r in _CSV_ROOTS)):
        raise ValueError("csv: files must be inside the workspace's data/ or outputs/ folders")
    return str(p)


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
    Load EVERY row of a table and profile it with pandas: dtypes, nulls, unique counts, value
    counts, numeric spread, outliers, date ranges, duplicates, likely ID columns, the strongest
    correlations and the first 20 rows. You read this profile, never the raw data.

    Args:
        table_name: Name of the database table to profile.

    Returns:
        JSON profile computed over all rows.
    """
    try:
        from tools.data_profile import load_table, load_note, profile_frame
        engine = create_engine(_get_db_uri())
        df, info = load_table(engine, table_name)
        return json.dumps({"status": "success", "table": table_name, "total_rows": info["total_rows"],
                           "rows_loaded": info["rows"], "coverage": load_note(info),
                           **profile_frame(df)}, indent=1, default=str)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Explore Data with Pandas")
def explore_data_with_pandas(table_name: str, code: str) -> str:
    """
    Run your own pandas code over the FULL table to understand it - unique values, value_counts,
    groupby aggregates, crosstabs, correlations, date ranges, segment comparisons. `df` is the
    whole table; `pd` and `np` are ready. print() what you need, or end with an expression
    (a DataFrame/Series is returned as a 20-row preview). No file, network or OS access; personal
    data columns are pseudonymised. Keep each call to one question.

    Args:
        table_name: The database table to load as df.
        code: pandas code, e.g. "df.groupby('region')['revenue'].agg(['count','sum','mean'])".

    Returns:
        JSON with printed output and the result preview.
    """
    try:
        from tools.data_profile import explore, load_note
        engine = create_engine(_get_db_uri())
        r = explore(engine, table_name, code or "")
        if not r.get("ok"):
            return json.dumps({"status": "error", "message": str(r.get("error"))[:1500],
                               "hint": "df is the full table; use only pandas/numpy, no files or imports of os/io."})
        loaded = r.get("loaded") or {}
        return json.dumps({"status": "success", "stdout": (r.get("stdout") or "")[:6000],
                           "result": r.get("result"),
                           "coverage": load_note(loaded) if loaded.get("total_rows") else ""},
                          indent=1, default=str)[:12000]
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)[:800]})


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

        table_name = "market_" + re.sub(r"\W+", "_", symbol).strip("_").lower()
        engine = create_engine(_get_db_uri())
        table_name = write_table(df, table_name, engine)

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

        table_name = "bank_" + re.sub(r"\W+", "_", bank_code).strip("_").lower() + "_historical"
        engine = create_engine(_get_db_uri())
        table_name = write_table(hist, table_name, engine)

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
        saved = write_table(df, "web_research_data", engine, if_exists="append")

        return json.dumps({
            "status":        "success",
            "results_count": len(results),
            "saved_table":   saved,
            "note":          write_note("web_research_data", saved),
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
            df = pd.read_csv(_workspace_csv(source_value))
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
        requested = target_table
        target_table = write_table(df, target_table, engine)

        return json.dumps({
            "status":       "success",
            "source":       data_source,
            "target_table": target_table,
            "note":         write_note(requested, target_table),
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
        from tools.data_profile import load_table, load_note
        df, _load = load_table(engine, table_name)     # every row, not a sample
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
        saved = write_table(df, table_name.split(".")[-1].strip('"'), engine)

        return json.dumps({
            "status":          "success",
            "table":           saved,
            "note":            write_note(table_name, saved),
            "dropped_columns": dropped,
            "kept_columns":    list(df.columns),
            "row_count":       len(df),
            "coverage":        load_note(_load),
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
        from tools.data_profile import load_table, load_note
        df, _load = load_table(engine, table_name)     # every row, not a sample

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

        saved = write_table(df, table_name.split(".")[-1].strip('"'), engine)

        return json.dumps({
            "status":            "success",
            "table":             saved,
            "note":              write_note(table_name, saved),
            "columns_converted": converted,
            "columns_unchanged": unchanged,
            "coverage":          load_note(_load),
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
            from tools.run_context import set_db
            set_db(with_mart_search_path(uri))
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
        JSON with column names, the row count and the first 20 result rows.
    """
    try:
        # Same rules as Data chat's MCP run_sql: one parser-validated SELECT (no writes, DDL,
        # file/network/sleep functions or system catalogs), only real tables, READ ONLY
        # transaction with a timeout, at most 10,000 rows fetched.
        from tools.sql_guard import SQLGuardError
        engine = create_engine(_get_db_uri())
        try:
            df = read_only_query(engine, sql_query, max_rows=10_000)
        except SQLGuardError as e:
            return json.dumps({"status": "error", "message": f"Query refused: {e}. Write one read-only SELECT "
                                                             "over the tables from List Database Tables."})
        return json.dumps({
            "status":  "success",
            "rows":    len(df),
            "columns": list(df.columns),
            "data":    df.head(20).to_dict(orient="records"),
            "note":    ("" if len(df) <= 20 else f"Showing 20 of {len(df):,} rows; aggregate in SQL or use "
                        "'Explore Data with Pandas' instead of reading more rows."),
        }, indent=2, default=str)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})
