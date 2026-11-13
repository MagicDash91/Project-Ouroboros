"""
tools/data_quality.py – data-quality checks with one-click fixes, run on every upload.

    check(frames)            {table: DataFrame} -> {"score", "issues": [...], "summary": text for Claude}
    apply_fix(frames, fix)   -> (frames, note)      deterministic pandas, no AI

Each issue: {id, table, column, kind, severity (high|medium|low), title, detail, count, fix: {...} | None}
Checks: duplicate rows, duplicate IDs, missing values, impossible values (negative amounts / quantities / ages,
percent > 100, age > 120, dates in the future or before 1900), extreme outliers (3×IQR), inconsistent spellings
of the same category, gaps in a daily / monthly date series, and broken joins between tables (codes with no
match in the lookup table). Fix kinds: drop_duplicates, dedupe_key, trim_categories, blank_values,
fill_missing (median | mode | zero), drop_missing_rows, cap_outliers.
"""

import re
from datetime import datetime

import pandas as pd

_ID = re.compile(r"(^|[_\s-])(id|uuid|kode|code|key|no|nomor|number)$|[a-z](ID|Id)$"
                 r"|^(id|kode|code|no|nomor)[_\s-]", re.I)
_NONNEG = re.compile(r"(qty|quantity|jumlah|amount|price|harga|revenue|sales|penjualan|omzet|cost|biaya|total|"
                     r"stock|stok|units?|count|age|umur|usia|weight|berat|discount|diskon)", re.I)
_PCT = re.compile(r"(pct|percent|persen|rate|ratio|share|margin)", re.I)
_AGE = re.compile(r"(^|_)(age|umur|usia)($|_)", re.I)
MAX_ISSUES = 60


def _sev(share: float) -> str:
    return "high" if share >= 0.1 else "medium" if share >= 0.01 else "low"


def _dates(s: pd.Series):
    if pd.api.types.is_datetime64_any_dtype(s):
        return s
    if s.dtype == object:
        sample = s.dropna().astype(str).head(200)
        if len(sample) and sample.str.match(r"^\d{4}-\d{2}-\d{2}").mean() > 0.9:
            return pd.to_datetime(s, errors="coerce")
    return None


def summary_text(issues: list, score: int) -> str:
    if not issues:
        return "DATA QUALITY: no problems found (score 100/100)."
    lines = [f"DATA QUALITY (score {score}/100): account for these in every answer and mention them when they affect a result:"]
    lines += [f"- [{i['severity']}] {i['table']}: {i['title']}. {i['detail']}" for i in issues[:20]]
    return "\n".join(lines)


def check(frames: dict) -> dict:
    issues = []

    def add(table, column, kind, title, detail, count, n, fix=None, severity=None):
        issues.append({"id": f"{table}:{column}:{kind}", "table": table, "column": column, "kind": kind,
                       "severity": severity or _sev(count / max(n, 1)), "title": title, "detail": detail,
                       "count": int(count), "fix": fix})

    for t, df in frames.items():
        n = len(df)
        if not n:
            continue
        dup = int(df.duplicated().sum())
        if dup:
            add(t, "", "duplicate_rows", f"{dup:,} duplicate rows", "Rows that are exact copies of another row "
                "inflate counts and sums.", dup, n, {"kind": "drop_duplicates", "table": t, "label": "Remove duplicates"})
        for c in df.columns:
            s, col = df[c], str(c)
            miss = int(s.isna().sum())
            if miss and miss < n:
                share = miss / n
                num = pd.api.types.is_numeric_dtype(s)
                add(t, col, "missing", f"{col}: {share * 100:.0f}% missing ({miss:,} rows)",
                    "Blanks are skipped by averages and can bias totals.", miss, n,
                    {"kind": "fill_missing", "table": t, "column": col, "how": "median" if num else "mode",
                     "label": "Fill with median" if num else "Fill with most common value"},
                    severity="high" if share >= 0.3 else None)
            nn = s.dropna()
            if not len(nn):
                continue
            if _ID.search(col) and 0.8 * len(nn) < nn.nunique() < len(nn):
                d = int(nn.duplicated().sum())
                add(t, col, "duplicate_id", f"{col}: {d:,} repeated IDs", "An ID should be unique; repeats usually "
                    "mean a record was loaded twice.", d, n,
                    {"kind": "dedupe_key", "table": t, "column": col, "label": "Keep the first of each ID"})
            if pd.api.types.is_numeric_dtype(s) and not pd.api.types.is_bool_dtype(s):
                if _NONNEG.search(col):
                    neg = int((nn < 0).sum())
                    if neg:
                        add(t, col, "negative", f"{col}: {neg:,} negative values", "This kind of value can't be "
                            "negative (returns or typing errors?).", neg, n,
                            {"kind": "blank_values", "table": t, "column": col, "rule": "negative", "label": "Blank them"})
                if _PCT.search(col) and nn.max() > 100 and nn.quantile(0.5) <= 100:
                    bad = int((nn > 100).sum())
                    add(t, col, "over_100", f"{col}: {bad:,} values above 100%", "A percentage over 100 is usually "
                        "an error.", bad, n, {"kind": "blank_values", "table": t, "column": col, "rule": "over_100",
                                              "label": "Blank them"})
                if _AGE.search(col):
                    bad = int(((nn > 120) | (nn < 0)).sum())
                    if bad:
                        add(t, col, "impossible_age", f"{col}: {bad:,} impossible ages", "Ages below 0 or above 120.",
                            bad, n, {"kind": "blank_values", "table": t, "column": col, "rule": "age", "label": "Blank them"})
                if nn.nunique() > 10 and not _ID.search(col):
                    q1, q3 = nn.quantile(0.25), nn.quantile(0.75)
                    iqr = q3 - q1
                    if iqr > 0:
                        lo, hi = q1 - 3 * iqr, q3 + 3 * iqr
                        out = int(((nn < lo) | (nn > hi)).sum())
                        if out and out / len(nn) < 0.05:
                            add(t, col, "outliers", f"{col}: {out:,} extreme outliers",
                                f"Far outside the normal range ({lo:,.4g} to {hi:,.4g}); check them before averaging.",
                                out, n, {"kind": "cap_outliers", "table": t, "column": col, "lo": float(lo),
                                         "hi": float(hi), "label": "Cap to the normal range"}, severity="low")
                continue
            d = _dates(s)
            if d is not None:
                dd = d.dropna()
                fut = int((dd > pd.Timestamp(datetime.now()) + pd.Timedelta(days=1)).sum())
                old = int((dd < pd.Timestamp("1900-01-01")).sum())
                if fut or old:
                    add(t, col, "bad_dates", f"{col}: {fut + old:,} impossible dates", f"{fut} in the future, {old} "
                        "before 1900.", fut + old, n,
                        {"kind": "blank_values", "table": t, "column": col, "rule": "bad_date", "label": "Blank them"})
                days = dd.dt.normalize().drop_duplicates().sort_values()
                if len(days) >= 8:
                    step = days.diff().dt.days.dropna().median()
                    if step == 1:
                        full = pd.date_range(days.min(), days.max(), freq="D")
                        gap = len(full) - len(days)
                        if 0 < gap <= 0.5 * len(full):
                            add(t, col, "date_gaps", f"{col}: {gap:,} missing days",
                                f"The series runs {days.min():%Y-%m-%d} to {days.max():%Y-%m-%d} with days missing, "
                                "so daily trends and averages can mislead.", gap, len(full), None, severity="medium")
                    elif 27 <= step <= 32:
                        months = days.dt.to_period("M").drop_duplicates()
                        gap = len(pd.period_range(months.min(), months.max(), freq="M")) - len(months)
                        if gap > 0:
                            add(t, col, "date_gaps", f"{col}: {gap} missing months", "Months with no data in the series.",
                                gap, len(months) + gap, None, severity="medium")
                continue
            if s.dtype == object and 2 <= nn.nunique() <= 200:
                txt = nn.astype(str)
                canon = txt.str.strip().str.lower().str.replace(r"\s+", " ", regex=True)
                variants = txt.groupby(canon).nunique()
                messy = variants[variants > 1]
                if len(messy):
                    rows = int(canon.isin(messy.index).sum())
                    ex = "; ".join(" / ".join(f"'{v}'" for v in txt[canon == k].unique()[:3]) for k in messy.index[:2])
                    add(t, col, "inconsistent", f"{col}: {len(messy)} value(s) spelled several ways",
                        f"e.g. {ex}. They would be counted as different groups.", rows, n,
                        {"kind": "trim_categories", "table": t, "column": col, "label": "Unify spellings"})
    # Broken joins: a key column whose values are missing from a smaller lookup table with the same column.
    for a, fa in frames.items():
        for b, fb in frames.items():
            if a == b or len(fb) >= len(fa) or not len(fb):
                continue
            for ca in fa.columns:
                norm = re.sub(r"[^a-z0-9]", "", str(ca).lower())
                cb = next((c for c in fb.columns if re.sub(r"[^a-z0-9]", "", str(c).lower()) == norm), None)
                if cb is None or not (_ID.search(str(ca)) or _ID.search(str(cb))) or not fb[cb].dropna().is_unique:
                    continue
                keys = set(map(str, fb[cb].dropna()))
                vals = fa[ca].dropna().astype(str)
                miss = ~vals.isin(keys)
                orphan = int(miss.sum())
                if orphan and len(keys) >= 2:
                    ex = ", ".join(vals[miss].unique()[:3])
                    add(a, str(ca), "broken_join", f"{a}.{ca}: {orphan:,} rows with no match in {b}",
                        f"Codes like {ex} aren't in {b}.{cb}, so a join drops or mislabels these rows.", orphan, len(fa))
    order = {"high": 0, "medium": 1, "low": 2}
    issues.sort(key=lambda i: (order[i["severity"]], -i["count"]))
    issues = issues[:MAX_ISSUES]
    score = max(0, 100 - sum({"high": 12, "medium": 5, "low": 1}[i["severity"]] for i in issues))
    return {"score": score, "issues": issues, "checked_at": datetime.now().isoformat(timespec="seconds"),
            "summary": summary_text(issues, score)}


def apply_fix(frames: dict, fix: dict) -> tuple:
    """Apply one fix to a copy of the frames. Returns (frames, note)."""
    t, col, kind = fix.get("table"), fix.get("column"), fix.get("kind")
    if t not in frames:
        raise ValueError(f"no table {t}")
    df = frames[t].copy()
    if col and col not in df.columns:
        raise ValueError(f"no column {col} in {t}")
    before = len(df)
    if kind == "drop_duplicates":
        df = df.drop_duplicates()
        note = f"{t}: removed {before - len(df):,} duplicate rows"
    elif kind == "dedupe_key":
        df = df.drop_duplicates(subset=[col], keep="first")
        note = f"{t}: kept the first row of each {col} ({before - len(df):,} removed)"
    elif kind == "trim_categories":
        mask = df[col].notna()
        canon = df.loc[mask, col].astype(str).str.strip().str.replace(r"\s+", " ", regex=True)
        key = canon.str.lower()
        best = canon.groupby(key).agg(lambda x: x.value_counts().index[0])    # most common spelling wins
        df[col] = df[col].astype("object")
        df.loc[mask, col] = key.map(best).values
        note = f"{t}.{col}: spellings unified"
    elif kind == "blank_values":
        s, rule = df[col], fix.get("rule")
        if rule == "negative":
            m = s < 0
        elif rule == "over_100":
            m = s > 100
        elif rule == "age":
            m = (s < 0) | (s > 120)
        elif rule == "bad_date":
            d = pd.to_datetime(s, errors="coerce")
            m = (d > pd.Timestamp(datetime.now()) + pd.Timedelta(days=1)) | (d < pd.Timestamp("1900-01-01"))
        else:
            raise ValueError("unknown rule")
        m = m.fillna(False)
        df[col] = df[col].astype("object") if rule == "bad_date" else df[col]
        df.loc[m, col] = None
        note = f"{t}.{col}: {int(m.sum()):,} impossible values blanked"
    elif kind == "fill_missing":
        how, s = fix.get("how", "median"), df[col]
        if how == "zero":
            val = 0
        elif how == "median" and pd.api.types.is_numeric_dtype(s):
            val = s.median()
        else:
            val = s.mode().iloc[0] if len(s.mode()) else None
        n = int(s.isna().sum())
        df[col] = s.fillna(val)
        note = f"{t}.{col}: {n:,} blanks filled with {how} ({val})"
    elif kind == "drop_missing_rows":
        df = df[df[col].notna()]
        note = f"{t}: removed {before - len(df):,} rows with no {col}"
    elif kind == "cap_outliers":
        lo, hi = float(fix["lo"]), float(fix["hi"])
        n = int(((df[col] < lo) | (df[col] > hi)).sum())
        df[col] = df[col].clip(lo, hi)
        note = f"{t}.{col}: {n:,} outliers capped to {lo:,.4g}…{hi:,.4g}"
    else:
        raise ValueError(f"unknown fix {kind}")
    out = dict(frames)
    out[t] = df
    return out, note
