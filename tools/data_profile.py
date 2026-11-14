"""
tools/data_profile.py – the Analytics crew works on ALL of a table's rows; Claude reads only a profile.

  load_table(engine, table)      – every row (streamed in chunks), up to ANALYSIS_MAX_ROWS
                                   (default 2,000,000) as a memory guard; says when it had to stop.
  profile_frame(df)              – what Profile Database Table returns: the first 20 rows (personal
                                   data pseudonymised) plus pandas facts computed over every row –
                                   dtypes, nulls, unique counts, value counts, numeric spread,
                                   outliers, date ranges, duplicates and likely ID columns.
  first_look(df)                 – smaller alternative: row count, column names/dtypes, 20 rows.
  explore(engine, table, code)   – Claude's own pandas code (df = the full table) run in the same
                                   sandboxed kernel as Data chat (tools/py_kernel.py: allow-listed
                                   imports, no file/OS/network access, PII masked on load, timeout).
                                   Only the printed output and a 20-row preview come back.
"""

import hashlib
import os
import secrets
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
FRAMES_DIR = ROOT / "data" / "crew_frames"          # private, not under /outputs
SAMPLE_ROWS = 20
MAX_ROWS = int(os.environ.get("ANALYSIS_MAX_ROWS", "2000000"))
CHUNK = 200_000
_PII_KEY = secrets.token_bytes(16)                    # per process; tokens are stable within a run


# ── Load every row ───────────────────────────────────────────────────────────

def load_table(engine, table_name: str, max_rows: int = None) -> tuple:
    """(df, info) with every row of the table. info = {rows, total_rows, capped}."""
    from tools.db_safety import safe_table
    cap = int(max_rows or MAX_ROWS)
    qt = safe_table(engine, table_name)
    parts, n = [], 0
    with engine.connect().execution_options(stream_results=True) as conn:
        for chunk in pd.read_sql(f"SELECT * FROM {qt}", conn, chunksize=CHUNK):
            parts.append(chunk)
            n += len(chunk)
            if n >= cap:
                break
    df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
    total = len(df)
    if len(df) >= cap:
        df = df.iloc[:cap]
        from sqlalchemy import text
        with engine.connect() as conn:
            total = int(conn.execute(text(f"SELECT COUNT(*) FROM {qt}")).scalar() or 0)
    return df, {"rows": len(df), "total_rows": total, "capped": total > len(df)}


def load_note(info: dict) -> str:
    if info.get("capped"):
        return (f"Used the first {info['rows']:,} of {info['total_rows']:,} rows (memory limit "
                f"ANALYSIS_MAX_ROWS); results describe that part of the table.")
    return f"Used all {info['rows']:,} rows."


# ── Profile (what Claude reads) ──────────────────────────────────────────────

def _num(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return round(v, 4) if np.isfinite(v) else None


def _short(v, n=80):
    s = str(v)
    return s if len(s) <= n else s[: n - 1] + "…"


def sample_rows(df: pd.DataFrame, n: int = SAMPLE_ROWS) -> list:
    """First n rows, personal data pseudonymised, long text cut."""
    from tools.llm_guard import pseudonymize_frame
    head, _ = pseudonymize_frame(df.head(n), _PII_KEY)
    out = []
    for row in head.to_dict(orient="records"):
        out.append({str(k): (None if not isinstance(v, (list, dict)) and pd.isna(v) else _short(v))
                    for k, v in row.items()})
    return out


def first_look(df: pd.DataFrame, sample: int = SAMPLE_ROWS) -> dict:
    """Shape, column names + dtypes and the first `sample` rows – nothing else."""
    return {"rows": len(df), "column_count": len(df.columns),
            "columns": {str(c): str(t) for c, t in df.dtypes.items()},
            "sample_rows": sample_rows(df, sample),
            "note": (f"Only the first {min(sample, len(df))} of {len(df):,} rows are shown. For anything else – "
                     "unique values, value_counts, nulls, describe(), groupby, crosstab, correlations – call "
                     "'Explore Data with Pandas' (df = the full table) and compute it.")}


def profile_frame(df: pd.DataFrame, sample: int = SAMPLE_ROWS, max_columns: int = 60) -> dict:
    """Pandas facts over every row, plus the first `sample` rows."""
    from tools.llm_guard import pii_kind
    rows = len(df)
    cols = []
    for c in list(df.columns)[:max_columns]:
        s = df[c]
        nn = s.dropna()
        try:
            uniq = int(s.nunique(dropna=True))
        except TypeError:                                   # unhashable (lists/dicts)
            uniq = None
        info = {"name": str(c), "dtype": str(s.dtype), "nulls": int(s.isna().sum()),
                "null_pct": round(100 * float(s.isna().mean()), 2) if rows else 0.0, "unique": uniq}
        pii = pii_kind(str(c))
        if pii:
            info["personal_data"] = pii
        if uniq is not None and uniq > 20 and uniq == rows - info["nulls"]:
            info["looks_like_id"] = True
        if pd.api.types.is_bool_dtype(s) or (uniq is not None and uniq <= 30 and not pii):
            vc = s.value_counts(dropna=False).head(15)
            info["value_counts"] = {_short(k, 40): int(v) for k, v in vc.items()}
        elif pd.api.types.is_numeric_dtype(s) and len(nn):
            q1, q3 = nn.quantile(0.25), nn.quantile(0.75)
            iqr = q3 - q1
            info["stats"] = {"mean": _num(nn.mean()), "std": _num(nn.std()), "min": _num(nn.min()),
                             "p25": _num(q1), "median": _num(nn.median()), "p75": _num(q3),
                             "max": _num(nn.max()), "sum": _num(nn.sum()),
                             "zeros": int((nn == 0).sum()), "negatives": int((nn < 0).sum()),
                             "outliers_iqr": int(((nn < q1 - 1.5 * iqr) | (nn > q3 + 1.5 * iqr)).sum())}
        elif pd.api.types.is_datetime64_any_dtype(s) and len(nn):
            info["range"] = {"min": str(nn.min()), "max": str(nn.max())}
        elif len(nn) and not pii and uniq is not None:
            txt = nn.astype(str)
            as_num = pd.to_numeric(txt.str.strip().str.replace(",", "", regex=False), errors="coerce")
            if as_num.notna().mean() >= 0.9:
                info["note"] = "text column that is ≥90% numbers – normalise its type before analysis"
            else:
                as_dt = pd.to_datetime(txt.head(500), errors="coerce", format="mixed")
                if as_dt.notna().mean() >= 0.9:
                    info["note"] = "text column holding dates"
            info["top_values"] = {_short(k, 40): int(v) for k, v in txt.value_counts().head(5).items()}
            lens = txt.str.len()
            info["text_length"] = {"min": int(lens.min()), "mean": round(float(lens.mean()), 1),
                                   "max": int(lens.max())}
        cols.append(info)
    try:
        dups = int(df.duplicated().sum())
    except TypeError:
        dups = None
    out = {"rows": rows, "column_count": len(df.columns), "duplicate_rows": dups,
           "columns": cols, "sample_rows": sample_rows(df, sample),
           "note": (f"Every number above was computed with pandas over all {rows:,} rows; only the first "
                    f"{min(sample, rows)} rows are shown. Use 'Explore Data with Pandas' to compute anything "
                    "else (groupby, crosstab, correlations, unique values) over the full table.")}
    if len(df.columns) > max_columns:
        out["columns_not_profiled"] = [str(c) for c in list(df.columns)[max_columns:]]
    num = df.select_dtypes(include=np.number)
    if 2 <= num.shape[1] <= 40 and rows > 2:
        corr = num.corr().abs()
        pairs = [(a, b, corr.loc[a, b]) for i, a in enumerate(corr.columns) for b in corr.columns[i + 1:]]
        pairs = sorted((p for p in pairs if pd.notna(p[2])), key=lambda p: -p[2])[:8]
        out["strongest_correlations"] = [{"a": str(a), "b": str(b), "abs_r": round(float(r), 3)}
                                         for a, b, r in pairs]
    return out


# ── Claude's own pandas code over the full table ─────────────────────────────

_kernel_lock = threading.Lock()
_kernel = {"key": None, "k": None, "meta": {}}
EXPLORE_TIMEOUT = 90


def _frame_file(engine, table_name: str) -> tuple:
    """Parquet copy of the full table for the kernel; reused for 10 minutes."""
    from tools.db_safety import _db_key, safe_table
    qt = safe_table(engine, table_name)
    key = hashlib.sha256(f"{_db_key(engine)}|{qt}".encode()).hexdigest()[:20]
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    path = FRAMES_DIR / f"{key}.parquet"
    fresh = path.exists() and time.time() - path.stat().st_mtime < 600
    if not fresh:
        df, meta = load_table(engine, table_name)
        df.columns = [str(c) for c in df.columns]
        for c in df.columns:                                  # parquet needs one type per column
            if df[c].dtype == object:
                df[c] = df[c].map(lambda v: v if v is None or isinstance(v, str) else str(v))
        df.to_parquet(path, index=False)
        return key, path, meta, True
    return key, path, None, False


def explore(engine, table_name: str, code: str) -> dict:
    """Run pandas code with `df` = the full table in the sandboxed kernel."""
    from features.data_chat import _Kernel, DataChatError
    key, path, meta, rebuilt = _frame_file(engine, table_name)
    with _kernel_lock:
        k = _kernel["k"]
        if rebuilt or _kernel["key"] != key or not (k and k.alive):
            if k:
                k.kill()
            work = FRAMES_DIR / "kernel"
            work.mkdir(parents=True, exist_ok=True)
            k = _Kernel(work)
            res = k.call({"op": "init", "datasets": [{"name": "df", "path": str(path), "format": "parquet"}],
                          "out_dir": str(work), "pii_key": _PII_KEY.hex(), "results_dir": ""}, timeout=180)
            if not res.get("ok"):
                k.kill()
                raise ValueError(f"couldn't load the table: {res.get('error')}")
            _kernel.update(key=key, k=k, meta=meta or {"rows": res["datasets"][0]["rows"]})
        try:
            out = k.call({"op": "exec", "code": code, "cell": "crew"}, timeout=EXPLORE_TIMEOUT)
        except DataChatError as e:
            _kernel.update(key=None, k=None)
            return {"ok": False, "error": str(e)}
    return {**out, "loaded": _kernel.get("meta") or {}}


def stop_kernel():
    with _kernel_lock:
        if _kernel["k"]:
            _kernel["k"].kill()
        _kernel.update(key=None, k=None)
