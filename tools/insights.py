"""
tools/insights.py – "Why did this change?" and forecasts / what-if for Data chat.

Trusted helpers preloaded into the sandboxed analysis kernel (tools/py_kernel.py) as
explain_change(...) and forecast(...). The AI calls them like any function. They do the
statistics deterministically (no LLM arithmetic), print a short plain-language summary for the
AI to narrate, and return (plotly figure, table); the kernel shows the figure and the table.

explain_change  splits the change in a total between two periods across every category column,
                ranks the segments that moved differently from the overall trend, and drills
                into the biggest one ("-18%: 70% of the drop is Bandung, mostly iced drinks").
forecast        Holt-Winters (damped trend, seasonality when there is enough history) with an
                80% range from simulation, a backtest error, and optional what-if scenarios.
"""

import re

import numpy as np
import pandas as pd

_FREQS = {"day": "D", "d": "D", "daily": "D", "week": "W", "w": "W", "weekly": "W",
          "month": "M", "m": "M", "monthly": "M", "quarter": "Q", "q": "Q", "quarterly": "Q",
          "year": "Y", "y": "Y", "yearly": "Y", "annual": "Y"}
_FREQ_WORD = {"D": "day", "W": "week", "M": "month", "Q": "quarter", "Y": "year"}
_SEASON = {"D": 7, "W": 52, "M": 12, "Q": 4}
_HORIZON = {"D": 30, "W": 12, "M": 3, "Q": 2, "Y": 1}
_TOKEN = re.compile(r"^[A-Z]+_[0-9a-f]{8,}$")                  # pseudonymised personal data
_TEXT_NAME = re.compile(r"review|comment|feedback|description|note|remark|message|text|ulasan|catatan", re.I)
_DATE_NAME = re.compile(r"date|time|day|month|period|week|created|_at$|^at_|tanggal|bulan", re.I)


# ── Small helpers ─────────────────────────────────────────────────────────────

def _theme():
    try:
        from tools.chart_style import THEME
        return THEME
    except Exception:
        return {"accent": "#C2410C", "base": "#94A3B8", "ink": "#111827", "muted": "#6B7280"}


def fmt(x) -> str:
    """1234567 → '1.23 mn' (unambiguous: mn = million, bn = billion / miliar, tn = trillion)."""
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "n/a"
    a = abs(float(x))
    for div, suf in ((1e12, " tn"), (1e9, " bn"), (1e6, " mn")):
        if a >= div:
            return f"{x / div:,.2f}{suf}"
    if a >= 1000:
        return f"{x:,.0f}"
    return f"{x:,.2f}".rstrip("0").rstrip(".") if a % 1 else f"{x:,.0f}"


def _pct(x) -> str:
    return "n/a" if x is None or not np.isfinite(x) else f"{x:+.1%}"


def _freq(freq) -> str:
    f = _FREQS.get(str(freq or "month").strip().lower())
    if not f:
        raise ValueError(f"freq must be one of day, week, month, quarter, year (got {freq!r})")
    return f


def _col(df, name, what):
    if name in df.columns:
        return name
    low = {str(c).lower(): c for c in df.columns}
    if str(name).lower() in low:
        return low[str(name).lower()]
    raise ValueError(f"{what} column {name!r} not found. Columns: {', '.join(map(str, df.columns[:40]))}")


def _to_dt(s: pd.Series) -> pd.Series:
    if pd.api.types.is_datetime64_any_dtype(s):
        out = s
    else:
        out = pd.to_datetime(s, errors="coerce", format="mixed") if s.dtype == object else pd.to_datetime(s, errors="coerce")
    try:
        if getattr(out.dt, "tz", None) is not None:
            out = out.dt.tz_localize(None)
    except Exception:
        pass
    return out


def _date_col(df, date):
    if date:
        return _col(df, date, "Date")
    for c in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            return c
    for c in df.columns:
        if df[c].dtype == object and _DATE_NAME.search(str(c)):
            sample = df[c].dropna().head(200)
            if len(sample) and _to_dt(sample).notna().mean() > 0.8:
                return c
    raise ValueError("No date column found; pass date='<column>'.")


def _values(df, metric, agg) -> tuple:
    """(per-row numbers to add up, label). metric=None → count rows."""
    agg = (agg or "sum").lower()
    if metric is None or agg == "count":
        if metric is not None:
            m = _col(df, metric, "Metric")
            return df[m].notna().astype(float), f"count of {m}"
        return pd.Series(1.0, index=df.index), "number of rows"
    if agg != "sum":
        raise ValueError("Only totals can be split into parts (agg='sum' or 'count'). For an average or a ratio, "
                         "explain the top and bottom of the fraction separately (e.g. revenue and orders).")
    m = _col(df, metric, "Metric")
    v = pd.to_numeric(df[m], errors="coerce")
    if v.notna().sum() == 0:
        raise ValueError(f"Column {m!r} is not numeric.")
    return v.fillna(0.0), m


def _period(spec, freq):
    """'2025-09' | '2025Q3' | '2025-Q3' | 'Q3 2025' | '2025' | '2025-09-15' | pd.Period | (start, end)
    → (start, end_exclusive, label)."""
    if isinstance(spec, (list, tuple)):
        if len(spec) != 2:
            raise ValueError("A date range must be (start, end).")
        a, b = pd.Timestamp(spec[0]), pd.Timestamp(spec[1])
        end = b + pd.Timedelta(days=1) if b == b.normalize() else b
        return a, end, f"{a:%Y-%m-%d} to {b:%Y-%m-%d}"
    if isinstance(spec, pd.Period):
        p = spec
    else:
        s = str(spec).strip()
        m = re.match(r"^(\d{4})\s*[-/ ]?\s*Q([1-4])$", s, re.I)
        m2 = re.match(r"^Q([1-4])\s*[-/ ]?\s*(\d{4})$", s, re.I)
        if m:
            s = f"{m.group(1)}Q{m.group(2)}"
        elif m2:
            s = f"{m2.group(2)}Q{m2.group(1)}"
        try:
            p = pd.Period(s)
        except Exception as e:
            raise ValueError(f"Could not read the period {spec!r}; use e.g. '2025-09', '2025Q3', '2025' or "
                             "('2025-09-01', '2025-09-14').") from e
    return p.start_time, (p + 1).start_time, str(p)


def _shift(start, end, compare):
    if compare in ("last_year", "yoy", "year", "previous_year"):
        off = pd.DateOffset(years=1)
        return start - off, end - off
    if compare not in ("previous", "prev", "prior"):
        raise ValueError("compare must be 'previous' or 'last_year'.")
    # same calendar length immediately before (months/quarters/years keep calendar boundaries)
    for unit, off in (("Y", pd.DateOffset(years=1)), ("Q", pd.DateOffset(months=3)), ("M", pd.DateOffset(months=1))):
        if start == start.to_period(unit).start_time and end == (start.to_period(unit) + 1).start_time:
            return start - off, start
    return start - (end - start), start


def _label(start, end) -> str:
    last = end - pd.Timedelta(days=1)
    for unit in ("Y", "Q", "M"):
        p = start.to_period(unit)
        if start == p.start_time and end == (p + 1).start_time:
            return str(p)
    if start == last.normalize():
        return f"{start:%Y-%m-%d}"
    return f"{start:%Y-%m-%d} to {last:%Y-%m-%d}"


def _aligned(dt: pd.Series, f: str) -> bool:
    """True when every date sits on the start of its period (e.g. monthly data dated the 1st)."""
    d = dt.dropna()
    return f != "D" and len(d) > 0 and bool((d.dt.normalize() == d.dt.to_period(f).dt.start_time).all())


def _dimensions(df, by, skip) -> list:
    if by:
        cols = [by] if isinstance(by, str) else list(by)
        return [_col(df, c, "Dimension") for c in cols]
    out = []
    n = max(len(df), 1)
    for c in df.columns:
        if c in skip or _TEXT_NAME.search(str(c)):
            continue
        s = df[c]
        blank = s.isna() | (s.astype(str).str.strip() == "")
        if blank.mean() > 0.5:
            continue                                                  # mostly empty
        if pd.api.types.is_bool_dtype(s):
            out.append(c)
            continue
        if not (s.dtype == object or isinstance(s.dtype, pd.CategoricalDtype) or pd.api.types.is_string_dtype(s)):
            continue
        u = s.nunique(dropna=True)
        if u < 2 or u > 60 or u > 0.5 * n:
            continue
        sample = s.dropna().astype(str).head(300)
        if len(sample) and (sample.str.len().mean() > 40 or sample.str.count(" ").mean() >= 3
                            or sample.str.match(_TOKEN).mean() > 0.5):
            continue                                                  # free text or masked personal data
        if len(sample) and _to_dt(sample).notna().mean() > 0.8:
            continue                                                  # a date stored as text
        out.append(c)
    unique = []
    out.sort(key=lambda c: bool(re.search(r"(^|_)(id|code|kode)$", str(c), re.I)))   # readable names win
    for c in out:
        codes = df[c].astype("string").fillna("")
        if not any(codes.nunique() == df[u].astype("string").fillna("").nunique() ==
                   (codes + "" + df[u].astype("string").fillna("")).nunique() for u in unique):
            unique.append(c)                                         # skip exact aliases (store vs store_id)
    return [c for c in df.columns if c in unique][:10]


def _segments(vals, key, ma, mb, ratio) -> pd.DataFrame:
    a = vals[ma].groupby(key[ma]).sum()
    b = vals[mb].groupby(key[mb]).sum()
    t = pd.concat([a, b], axis=1, keys=["previous", "current"]).fillna(0.0)
    t["change"] = t["current"] - t["previous"]
    t["excess"] = t["change"] - t["previous"] * (ratio - 1)          # vs moving in line with the total
    return t


def _share(x, delta) -> str:
    if not delta or x is None or not np.isfinite(x):
        return ""
    if abs(x) > 1.5:
        return "larger than the whole net change"
    if x < 0:
        return "moved against the total"
    return f"{x:.0%} of the total change"


def _plabel(p) -> str:
    return f"week of {p.start_time:%Y-%m-%d}" if p.freqstr.startswith("W") else str(p)


def _keyed(df, c) -> pd.Series:
    return df[c].astype("string").fillna("(blank)").replace("", "(blank)")


# ── explain_change ────────────────────────────────────────────────────────────

def explain_change(df, metric=None, date=None, current=None, previous=None, by=None, agg="sum",
                   compare="previous", freq="month", top=8):
    """Why did a total change between two periods? Returns (waterfall fig, driver table) and prints a summary.

    metric   numeric column to total (None = count rows); agg 'sum' or 'count'
    date     date column (auto-detected when omitted)
    current  '2025-09', '2025Q3', '2025', '2025-09-15' or (start, end); default = latest full `freq`
    previous same formats; default = the period before (compare='previous') or a year earlier ('last_year')
    by       category column(s) to split by; default = every suitable category column
    """
    dcol = _date_col(df, date)
    f = _freq(freq)
    dt = _to_dt(df[dcol])
    if dt.notna().sum() == 0:
        raise ValueError(f"Column {dcol!r} has no readable dates.")
    vals, mlabel = _values(df, metric, agg)
    notes = []

    if current is None:
        last = dt.max()
        p = last.to_period(f)
        if (not _aligned(dt, f) and last.normalize() < ((p + 1).start_time - pd.Timedelta(days=1))
                and (dt < p.start_time).any()):
            notes.append(f"The latest {_FREQ_WORD[f]} ({p}) is incomplete (data ends {last:%Y-%m-%d}), so the "
                         f"last full {_FREQ_WORD[f]} was used.")
            p = p - 1
        cs, ce = p.start_time, (p + 1).start_time
    else:
        cs, ce, _ = _period(current, f)
    if previous is None:
        ps, pe = _shift(cs, ce, compare)
    else:
        ps, pe, _ = _period(previous, f)
    clab, plab = _label(cs, ce), _label(ps, pe)

    mb, ma = (dt >= cs) & (dt < ce), (dt >= ps) & (dt < pe)
    span = f"data covers {dt.min():%Y-%m-%d} to {dt.max():%Y-%m-%d}"
    if not mb.any():
        raise ValueError(f"No rows in {clab} ({span}).")
    if not ma.any():
        raise ValueError(f"No rows in {plab} to compare with ({span}). Pass previous=... or compare='previous'.")

    tp, tc = float(vals[ma].sum()), float(vals[mb].sum())
    delta = tc - tp
    ratio = tc / tp if tp else 1.0
    dims = _dimensions(df, by, {dcol, metric})
    if not dims:
        raise ValueError("No category columns to split by; pass by=['column', ...].")

    rows, per_dim = [], {}
    for c in dims:
        t = _segments(vals, _keyed(df, c), ma, mb, ratio)
        per_dim[c] = t
        for v, r in t.iterrows():
            rows.append({"dimension": str(c), "segment": str(v), "previous": r["previous"], "current": r["current"],
                         "change": r["change"], "excess": r["excess"]})
    seg = pd.DataFrame(rows)
    prev = seg["previous"].where(seg["previous"] != 0)
    seg["change_pct"] = seg["change"] / prev
    seg["share_of_change"] = seg["change"] / delta if delta else np.nan
    seg = seg.reindex(seg["excess"].abs().sort_values(ascending=False).index)

    # The dimension where the movement is most uneven gets the waterfall.
    focus = max(per_dim, key=lambda c: per_dim[c]["excess"].abs().sum())
    lead = seg.iloc[0]
    broad = abs(lead["excess"]) < 0.1 * abs(delta) if delta else abs(lead["excess"]) < 1e-9

    # Drill one level into the leading segment.
    drill = None
    inside = _keyed(df, lead["dimension"]) == lead["segment"]
    others = [c for c in dims if str(c) != lead["dimension"]]
    if others and not broad and lead["change"]:
        best = None
        for c in others:
            t = _segments(vals, _keyed(df, c), ma & inside, mb & inside, 1.0)
            for v, r in t.iterrows():
                if np.sign(r["change"]) == np.sign(lead["change"]) and (best is None or abs(r["change"]) > abs(best[2])):
                    best = (c, v, r["change"])
        if best:
            drill = (*best, best[2] / lead["change"])

    # ── Summary for the AI to narrate ──
    word = "rose" if delta > 0 else "fell" if delta < 0 else "was unchanged"
    lines = [f"{mlabel} {word}: {plab} = {fmt(tp)} → {clab} = {fmt(tc)} "
             f"(change {'+' if delta >= 0 else ''}{fmt(delta)}, {_pct(delta / tp) if tp else 'n/a'})."]
    if broad:
        lines.append(f"No single segment stands out: across {', '.join(map(str, dims[:6]))} every group moved roughly in "
                     "line with the total, so the change is broad-based.")
    else:
        overall = _pct(delta / tp) if tp else "n/a"
        lines.append(f"Segments that moved most differently from the overall {overall} (the real drivers):")
        for _, r in seg.head(min(top, 5)).iterrows():
            lines.append(f"- {r['dimension']} = {r['segment']}: {fmt(r['previous'])} → {fmt(r['current'])} "
                         f"({'+' if r['change'] >= 0 else ''}{fmt(r['change'])}, {_pct(r['change_pct'])} vs {overall} "
                         f"overall{'; ' + _share(r['share_of_change'], delta) if _share(r['share_of_change'], delta) else ''})")
        ft = per_dim[focus]
        ft = ft.reindex(ft["change"].abs().sort_values(ascending=False).index).head(3)
        lines.append(f"Largest contributors by {focus}: " + "; ".join(
            f"{i} {'+' if r['change'] >= 0 else ''}{fmt(r['change'])}"
            + (f" ({_share(r['change'] / delta, delta)})" if delta else "")
            for i, r in ft.iterrows()))
        if delta and (seg["share_of_change"].abs() > 1.5).any():
            lines.append("Gains and losses partly cancel out: some segments moved by more than the net change.")
        if drill:
            c, v, ch, share = drill
            lines.append(f"Inside {lead['dimension']} = {lead['segment']}, the largest part is {c} = {v}: "
                         f"{'+' if ch >= 0 else ''}{fmt(ch)} ({share:.0%} of that segment's change).")
    blanks = [str(c) for c in dims if (_keyed(df, c)[ma | mb] == "(blank)").any()]
    if blanks:
        notes.append(f"Some rows have a blank {', '.join(blanks)} (shown as '(blank)').")
    days_c, days_p = (ce - cs).days, (pe - ps).days
    if days_c != days_p and min(days_c, days_p) > 0:
        notes.append(f"The periods have different lengths ({days_p} vs {days_c} days); compare per-day values too.")
    for n in notes:
        lines.append("Note: " + n)
    print("\n".join(lines))

    # ── Waterfall over the focus dimension ──
    import plotly.graph_objects as go
    th = _theme()
    t = per_dim[focus]
    t = t.reindex(t["change"].abs().sort_values(ascending=False).index)
    shown = t.head(7)
    extra = len(t) > 7
    rest = float(t["change"].iloc[7:].sum()) if extra else 0.0
    xs = [plab] + [str(i) for i in shown.index] + (["Other"] if extra else []) + [clab]
    ys = [tp] + list(shown["change"]) + ([rest] if extra else []) + [tc]
    measure = ["absolute"] + ["relative"] * (len(xs) - 2) + ["total"]
    fig = go.Figure(go.Waterfall(
        x=xs, y=ys, measure=measure, text=[fmt(v) for v in ys], textposition="outside",
        increasing={"marker": {"color": "#15803D"}}, decreasing={"marker": {"color": th.get("accent", "#C2410C")}},
        totals={"marker": {"color": th.get("base", "#94A3B8")}}, connector={"line": {"color": "#CBD5E1"}}))
    fig.update_layout(title=f"Why {mlabel} changed, {plab} → {clab}: by {focus}", showlegend=False,
                      yaxis_title=mlabel, xaxis_title=str(focus))

    out = seg.head(max(int(top), 1))[["dimension", "segment", "previous", "current", "change", "change_pct",
                                      "share_of_change"]].copy()
    out["change_pct"] = (out["change_pct"] * 100).round(1)
    out["share_of_change"] = (out["share_of_change"] * 100).round(1)
    for c in ("previous", "current", "change"):
        out[c] = out[c].round(2)
    out = out.rename(columns={"change_pct": "change_%", "share_of_change": "share_of_total_change_%"})
    return fig, out.reset_index(drop=True)


# ── forecast ──────────────────────────────────────────────────────────────────

def _series(df, value, date, agg, f):
    dcol = _date_col(df, date)
    dt = _to_dt(df[dcol])
    vals, label = _values(df, value, agg)
    ok = dt.notna()
    if not ok.any():
        raise ValueError(f"Column {dcol!r} has no readable dates.")
    per = dt[ok].dt.to_period(f)
    s = vals[ok].groupby(per).sum().sort_index()
    s = s.reindex(pd.period_range(s.index.min(), s.index.max(), freq=f), fill_value=0.0)
    notes = []
    first, last = dt[ok].min(), dt[ok].max()
    if f != "D" and len(s) > 2 and not _aligned(dt[ok], f):
        if last.normalize() < (s.index[-1] + 1).start_time - pd.Timedelta(days=1):
            notes.append(f"The last {_FREQ_WORD[f]} ({_plabel(s.index[-1])}) is incomplete and was left out of the model.")
            s = s.iloc[:-1]
        if first.normalize() > s.index[0].start_time:
            notes.append(f"The first {_FREQ_WORD[f]} ({_plabel(s.index[0])}) is incomplete and was left out.")
            s = s.iloc[1:]
    return s, label, dcol, notes


def _auto_freq(df, date) -> str:
    dt = _to_dt(df[_date_col(df, date)]).dropna()
    days = (dt.max() - dt.min()).days if len(dt) else 0
    return "D" if days <= 120 else "W" if days <= 400 else "M"


def _fit(y: np.ndarray, f: str):
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
    sp = _SEASON.get(f, 0)
    seasonal = sp > 1 and len(y) >= 2 * sp
    model = ExponentialSmoothing(y, trend="add", damped_trend=True, seasonal="add" if seasonal else None,
                                 seasonal_periods=sp if seasonal else None, initialization_method="estimated")
    return model.fit(optimized=True), seasonal


def forecast(df, value=None, date=None, horizon=None, freq=None, agg="sum", scenarios=None, level=0.8):
    """Forecast a total over time. Returns (chart, table) and prints a summary with a range and backtest error.

    value      numeric column to total per period (None = count rows)
    freq       'day' | 'week' | 'month' | 'quarter' (default: from the data's span)
    horizon    periods ahead (default: 30 days / 12 weeks / 3 months / 2 quarters)
    scenarios  what-if: {'label': percent change vs the baseline forecast}, e.g. {'Price +5%, volume -4%': 0.8}
    level      width of the range (0.8 = 80% of outcomes)
    """
    import warnings
    warnings.filterwarnings("ignore")
    f = _freq(freq) if freq else _auto_freq(df, date)
    s, label, dcol, notes = _series(df, value, date, agg, f)
    if len(s) < 6:
        raise ValueError(f"Only {len(s)} full {_FREQ_WORD[f]}s of history; need at least 6. Try a shorter freq.")
    h = int(horizon or _HORIZON[f])
    if h < 1 or h > 120:
        raise ValueError("horizon must be between 1 and 120 periods.")
    level = min(max(float(level), 0.5), 0.99)
    y = s.to_numpy(dtype=float)
    nonneg = bool((y >= 0).all())

    method = "Holt-Winters (damped trend)"
    totals = None                                     # simulated totals over the horizon, for the total's range
    try:
        res, seasonal = _fit(y, f)
        point = np.asarray(res.forecast(h), dtype=float)
        if seasonal:
            method += f" with {_FREQ_WORD[f]}ly seasonality ({_SEASON[f]} periods)"
        try:
            sims = np.asarray(res.simulate(nsimulations=h, repetitions=1000, error="add", anchor="end"), dtype=float)
            sims = sims.reshape(h, -1)
            lo = np.quantile(sims, (1 - level) / 2, axis=1)
            hi = np.quantile(sims, 1 - (1 - level) / 2, axis=1)
            totals = sims.sum(axis=0)
        except Exception:
            from statistics import NormalDist
            z = NormalDist().inv_cdf(0.5 + level / 2)
            sd = float(np.std(np.asarray(res.resid, dtype=float)))
            lo = point - z * sd * np.sqrt(np.arange(1, h + 1))
            hi = point + z * sd * np.sqrt(np.arange(1, h + 1))
    except Exception:
        from statistics import NormalDist
        z = NormalDist().inv_cdf(0.5 + level / 2)
        method = "linear trend (the series is too irregular for Holt-Winters)"
        x = np.arange(len(y))
        a, b = np.polyfit(x, y, 1)
        point = a * np.arange(len(y), len(y) + h) + b
        sd = float(np.std(y - (a * x + b)))
        lo, hi = point - z * sd, point + z * sd
    if nonneg:
        point, lo, hi = np.clip(point, 0, None), np.clip(lo, 0, None), np.clip(hi, 0, None)
    lo, hi = np.minimum(lo, point), np.maximum(hi, point)

    # Backtest: hold back the last k periods, fit on the rest, measure the error.
    k = min(h, max(1, len(y) // 5))
    mape = None
    if len(y) - k >= 6:
        try:
            r2, _ = _fit(y[:-k], f)
            pred = np.asarray(r2.forecast(k), dtype=float)
            actual = y[-k:]
            mask = actual != 0
            if mask.any():
                mape = float(np.mean(np.abs(pred[mask] - actual[mask]) / np.abs(actual[mask])))
        except Exception:
            mape = None

    pct_level = int(round(level * 100))
    fut = pd.period_range(s.index[-1] + 1, periods=h, freq=f)
    table = pd.DataFrame({"period": [_plabel(p) for p in fut], "forecast": point.round(2),
                          f"low_{pct_level}": lo.round(2), f"high_{pct_level}": hi.round(2)})
    sc = {}
    for name, pct in (scenarios or {}).items():
        try:
            pct = float(pct)
        except (TypeError, ValueError):
            raise ValueError(f"Scenario {name!r} needs a number: the % change vs the baseline, e.g. 5 or -3.") from None
        sc[str(name)[:60]] = pct
        table[str(name)[:60]] = (point * (1 + pct / 100)).round(2)

    # ── Summary ──
    total = float(point.sum())
    if totals is not None:
        tlo, thi = (float(np.quantile(totals, q)) for q in ((1 - level) / 2, 1 - (1 - level) / 2))
        if nonneg:
            tlo = max(tlo, 0.0)
        tlo, thi = min(tlo, total), max(thi, total)
    else:                                             # errors partly cancel; approximate with root-sum-square
        tlo = total - float(np.sqrt(np.sum((point - lo) ** 2)))
        thi = total + float(np.sqrt(np.sum((hi - point) ** 2)))
    recent = float(y[-h:].sum()) if len(y) >= h else float("nan")
    unit = _FREQ_WORD[f] + ("s" if h > 1 else "")
    lines = [f"Forecast of {label} for the next {h} {unit} ({_plabel(fut[0])} to {_plabel(fut[-1])}): total {fmt(total)} "
             f"(likely range {fmt(tlo)} to {fmt(thi)}, {pct_level}% of outcomes)."]
    if np.isfinite(recent) and recent:
        lines.append(f"The last {h} {unit} totalled {fmt(recent)}, so that is {_pct(total / recent - 1)}.")
    if h > 1:
        lines.append("Per period: " + "; ".join(f"{_plabel(p)} {fmt(v)}" for p, v in zip(fut[:6], point[:6]))
                     + (" …" if h > 6 else ""))
    lines.append(f"Model: {method}, fitted on {len(y)} {_FREQ_WORD[f]}s ({_plabel(s.index[0])} to {_plabel(s.index[-1])}).")
    if mape is not None:
        lines.append(f"Backtest: on the last {k} {_FREQ_WORD[f]}{'s' if k > 1 else ''} held back, it was off by "
                     f"{mape:.0%} on average.")
    for name, pct in sc.items():
        lines.append(f"Scenario '{name}' ({pct:+g}% vs baseline): {fmt(total * (1 + pct / 100))} "
                     f"({'+' if pct >= 0 else ''}{fmt(total * pct / 100)} vs the baseline forecast).")
    lines.append("Assumes the past pattern continues; one-off events (promotions, holidays that move dates) are "
                 "not modelled separately.")
    for n in notes:
        lines.append("Note: " + n)
    print("\n".join(lines))

    # ── Chart ──
    import plotly.graph_objects as go
    th = _theme()
    hx = [p.start_time for p in s.index]
    fx = [p.start_time for p in fut]
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=fx + fx[::-1], y=list(hi) + list(lo[::-1]), fill="toself", line={"width": 0},
                             fillcolor="rgba(194,65,12,0.14)", hoverinfo="skip", name=f"{pct_level}% range"))
    fig.add_trace(go.Scatter(x=hx, y=y, mode="lines", name="Actual", line={"color": th.get("base", "#64748B"), "width": 2}))
    fig.add_trace(go.Scatter(x=[hx[-1]] + fx, y=[y[-1]] + list(point), mode="lines+markers", name="Forecast",
                             line={"color": th.get("accent", "#C2410C"), "width": 2.5, "dash": "dash"}))
    palette = ["#1D4ED8", "#15803D", "#7C3AED", "#B45309"]
    for i, (name, pct) in enumerate(sc.items()):
        fig.add_trace(go.Scatter(x=[hx[-1]] + fx, y=[y[-1]] + list(point * (1 + pct / 100)), mode="lines",
                                 name=name, line={"color": palette[i % len(palette)], "width": 2, "dash": "dot"}))
    fig.update_layout(title=f"{label}: forecast for the next {h} {unit}", xaxis_title=str(dcol), yaxis_title=label,
                      legend={"orientation": "h", "y": -0.18})
    return fig, table
