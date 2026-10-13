"""
tools/chart_pack.py – problem-driven chart generation.

Instead of a fixed recipe (pie + histogram + scatter + … for every dataset), Claude
looks at a profile of the real table plus the analysis goal and *plans* the charts
that answer that problem, choosing from a set of chart kinds. pandas computes each
chart's numbers, one more Claude call writes a finding-style headline and insight
for all charts at once, and everything is drawn with the shared light theme.

Two Claude calls per pack regardless of chart count; no LLM-written code is run.
"""

import json
import os
import re
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
from sqlalchemy import text

from features.dashboard import _profile_text, _q, profile_table
from features.deeper import _engine, _resolve_db_uri
from tools import chart_style as cs

BASE_DIR   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHARTS_DIR = os.path.join(BASE_DIR, "outputs", "charts")
META_PATH  = os.path.join(CHARTS_DIR, "session_charts.json")
os.makedirs(CHARTS_DIR, exist_ok=True)

MAX_CHARTS = 6
MAX_ROWS   = 50000
TOP_N      = 12

KINDS = {
    "rate_by_category":        "Outcome rate (% of records where target = positive value) for each segment of x. Needs target; x categorical or numeric (numeric is banded).",
    "driver_ranking":          "Ranks ALL columns by how much the outcome rate differs across their segments. Needs target. Best single 'what drives it' chart.",
    "distribution_by_outcome": "Distribution of numeric y, overlaid for target-positive vs the rest (or for each value of group if no target).",
    "mean_by_category":        "Average of numeric y for each segment of x.",
    "box_by_category":         "Spread (median, quartiles) of numeric y for each segment of x.",
    "count_by_category":       "Number of records in each segment of x.",
    "composition":             "Share of records per category of x as a donut (top 5 + Other).",
    "trend":                   "Monthly trend over date column x: outcome rate if target is set, else mean of y, else record count.",
    "scatter":                 "Numeric x against numeric y, coloured by target outcome or group (sampled).",
    "correlation_matrix":      "Correlation heatmap of the most relevant numeric columns.",
}

_PLAN_TOOL = {
    "name": "plan_charts",
    "description": "Return the chart plan.",
    "input_schema": {
        "type": "object",
        "properties": {
            "target_column":  {"type": "string", "description": "Outcome column the business cares about (e.g. churn, fraud, default, converted). Empty string if none."},
            "positive_value": {"type": "string", "description": "The value of target_column that means the outcome happened (e.g. 'Yes', '1'). Empty if no target."},
            "charts": {
                "type": "array", "maxItems": MAX_CHARTS + 2,
                "items": {
                    "type": "object",
                    "properties": {
                        "kind":     {"type": "string", "enum": list(KINDS)},
                        "x":        {"type": "string", "description": "Column for categories/axis (exact name) or empty."},
                        "y":        {"type": "string", "description": "Numeric column for values (exact name) or empty."},
                        "group":    {"type": "string", "description": "Optional column to colour/split by, or empty."},
                        "title":    {"type": "string", "description": "Short working title."},
                        "question": {"type": "string", "description": "The business question this chart answers (one line)."},
                    },
                    "required": ["kind", "x", "y", "group", "title", "question"],
                },
            },
        },
        "required": ["target_column", "positive_value", "charts"],
    },
}

_INSIGHT_TOOL = {
    "name": "write_insights",
    "description": "Return one insight per chart.",
    "input_schema": {
        "type": "object",
        "properties": {
            "insights": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id":             {"type": "string"},
                        "headline":       {"type": "string", "description": "The finding, with a number, max 11 words. Sentence case, no trailing period."},
                        "insight":        {"type": "string", "description": "2 sentences explaining the pattern, citing numbers from the data only."},
                        "recommendation": {"type": "string", "description": "1-2 sentences: the concrete action this suggests."},
                    },
                    "required": ["id", "headline", "insight", "recommendation"],
                },
            },
        },
        "required": ["insights"],
    },
}


# ── Claude ─────────────────────────────────────────────────────────────────────

def _tool_call(system: str, user: str, tool: dict, max_tokens: int = 3000) -> tuple:
    from config import ANTHROPIC_MODEL, CLAUDE_THINKING, LLMUnavailableError, anthropic_client
    if anthropic_client is None:
        raise LLMUnavailableError("ANTHROPIC_API_KEY is not set")
    resp = anthropic_client.messages.create(
        model=ANTHROPIC_MODEL, max_tokens=max_tokens, thinking=CLAUDE_THINKING,
        system=system, tools=[tool], tool_choice={"type": "tool", "name": tool["name"]},
        messages=[{"role": "user", "content": user}],
    )
    usage = {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}
    for block in resp.content:
        if getattr(block, "type", "") == "tool_use":
            return dict(block.input), usage
    raise LLMUnavailableError(f"Claude did not call {tool['name']}")


def _plan(profile: dict, goal: str, max_charts: int) -> tuple:
    kinds = "\n".join(f"- {k}: {v}" for k, v in KINDS.items())
    system = (
        "You are a senior data analyst deciding which charts best answer a business problem. "
        "Work from the data profile: identify the outcome the business cares about (if any), "
        "then pick charts that explain it — what drives it, which segments are most affected, "
        "how it differs across key numeric measures, and how it moves over time if there is a date. "
        "If there is no outcome column, chart the most decision-relevant measures instead. "
        "Every chart must answer a different question; skip id and free-text columns; use exact "
        f"column names from the profile.\n\nChart kinds:\n{kinds}"
    )
    user = (f"{_profile_text(profile)}\n\nAnalysis goal: {goal.strip() or 'General analysis of this data.'}\n\n"
            f"Plan {max_charts} charts, most important first.")
    return _tool_call(system, user, _PLAN_TOOL)


def _insights(goal: str, items: list) -> tuple:
    system = (
        "You are a senior analyst writing chart annotations for business leaders. For each chart, "
        "state the single most important finding using ONLY the numbers given. Be specific and plain; "
        "no hype, no hedging filler."
    )
    blocks = [f"[{it['id']}] {it['kind']} — {it['question']}\n{it['data'].head(15).to_csv(index=False)}"
              for it in items]
    user = f"Analysis goal: {goal or 'general analysis'}\n\n" + "\n\n".join(blocks)
    return _tool_call(system, user, _INSIGHT_TOOL, max_tokens=4000)


# ── Data helpers ──────────────────────────────────────────────────────────────

def _target_mask(df: pd.DataFrame, col: str, pos: str) -> tuple:
    """Boolean Series for target == positive value, resolving sensible defaults."""
    if not col or col not in df.columns:
        return None, ""
    s = df[col].astype(str).str.strip()
    values = s.value_counts()
    if values.size < 2:
        return None, ""
    if pos not in values.index:
        lower = {v.lower(): v for v in values.index}
        pos = next((lower[k] for k in ("1", "yes", "true", "y", "1.0") if k in lower), values.index[-1])
    return (s == pos), pos


def _as_category(s: pd.Series) -> tuple:
    """Return (string categories, band order or None). Wide numeric columns are banded."""
    if pd.api.types.is_numeric_dtype(s) and s.nunique() > 12:
        try:
            bands = pd.qcut(s, q=5, duplicates="drop")
            # qcut nudges the lowest edge below the minimum (e.g. -0.001); label with real data bounds.
            labels = [f"{cs.fmt_number(max(iv.left, s.min()))}–{cs.fmt_number(iv.right)}"
                      for iv in bands.cat.categories]
            return bands.cat.rename_categories(labels).astype(str).where(s.notna()), labels
        except (ValueError, TypeError):
            pass
    return s.astype(str).where(s.notna()), None


def _min_size(df: pd.DataFrame) -> int:
    return max(5, int(len(df) * 0.002))


def _need(df, spec, *keys, numeric=()):
    for k in keys:
        col = spec.get(k) or ""
        if col not in df.columns:
            raise ValueError(f"{k}={col!r} is not a column")
    for k in numeric:
        if not pd.api.types.is_numeric_dtype(df[spec[k]]):
            raise ValueError(f"{k}={spec[k]!r} is not numeric")


# ── Drawing helpers ───────────────────────────────────────────────────────────

def _bars(ax, labels, values, kind="number", ref=None, ref_label="", suffix=""):
    labels = [str(l) for l in labels]
    values = np.asarray(values, dtype=float)
    top = int(np.nanargmax(values)) if len(values) else -1
    colors = cs.highlight_colors(len(values), top)
    horizontal = len(labels) > 7 or max((len(l) for l in labels), default=0) > 14
    hi = np.nanmax(values) if len(values) else 1
    if horizontal:
        # Make room for the longest category label instead of clipping it.
        longest = max((len(l) for l in labels), default=0)
        ax.figure.subplots_adjust(left=min(0.42, 0.04 + longest * 0.0105))
        ax.grid(axis="y", visible=False)
        ax.grid(axis="x", visible=True)
        y = np.arange(len(labels))[::-1]
        ax.barh(y, values, color=colors, height=0.62)
        ax.set_yticks(y, labels)
        ax.xaxis.set_major_formatter(cs.axis_formatter(kind))
        for yi, v in zip(y, values):
            ax.text(v + hi * 0.01, yi, cs.fmt_number(v, kind) + suffix, va="center", fontsize=9.5, color=cs.INK)
        if ref is not None:
            ax.axvline(ref, color=cs.INK, lw=1, ls=(0, (4, 3)))
            ax.text(ref, len(labels) - 0.4, f" {ref_label}", fontsize=9, color=cs.MUTED, va="bottom")
        ax.set_xlim(0, hi * 1.15)
    else:
        x = np.arange(len(labels))
        ax.bar(x, values, color=colors, width=0.62)
        ax.set_xticks(x, labels)
        ax.yaxis.set_major_formatter(cs.axis_formatter(kind))
        for xi, v in zip(x, values):
            ax.text(xi, v + hi * 0.01, cs.fmt_number(v, kind) + suffix, ha="center", va="bottom", fontsize=10,
                    color=cs.INK, fontweight="bold" if xi == top else "normal")
        if ref is not None:
            ax.axhline(ref, color=cs.INK, lw=1, ls=(0, (4, 3)))
            ax.text(len(labels) - 0.5, ref, f"{ref_label} ", fontsize=9, color=cs.MUTED, ha="right", va="bottom")
        ax.set_ylim(0, hi * 1.15)


# ── Chart kinds: each returns (data for insights, draw(fig, ax), subtitle) ──

def _k_rate_by_category(df, spec, tgt, ctx):
    if tgt is None:
        raise ValueError("needs a target")
    _need(df, spec, "x")
    cat, ordered = _as_category(df[spec["x"]])
    g = pd.DataFrame({"c": cat, "t": tgt}).dropna().groupby("c", observed=True, sort=False)["t"].agg(["mean", "size"])
    g = g[g["size"] >= _min_size(df)]
    g = g.reindex([c for c in ordered if c in g.index]) if ordered else \
        g.sort_values("mean", ascending=False).head(TOP_N)
    if len(g) < 2:
        raise ValueError("fewer than 2 segments")
    rates = (g["mean"] * 100).round(2)
    overall = tgt.mean() * 100
    data = pd.DataFrame({spec["x"]: g.index, f"{ctx['target']}_rate_pct": rates.values, "records": g["size"].values})
    return data, lambda fig, ax: _bars(ax, g.index, rates.values, "percent", overall, f"Overall {overall:.1f}%"), \
        f"% of records with {ctx['target']} = {ctx['pos']}, by {spec['x']}"


def _k_driver_ranking(df, spec, tgt, ctx):
    if tgt is None:
        raise ValueError("needs a target")
    rows = []
    for col in df.columns:
        if col == ctx["target"]:
            continue
        s = df[col]
        if not pd.api.types.is_numeric_dtype(s) and s.nunique() > 30:
            continue                          # ids / free text
        cat, _ = _as_category(s)
        g = pd.DataFrame({"c": cat, "t": tgt}).dropna().groupby("c", observed=True)["t"].agg(["mean", "size"])
        g = g[g["size"] >= _min_size(df)]
        if len(g) < 2:
            continue
        hi, lo = g["mean"].idxmax(), g["mean"].idxmin()
        rows.append({"column": col, "spread_pts": round((g["mean"].max() - g["mean"].min()) * 100, 1),
                     "highest_segment": hi, "highest_rate_pct": round(g.loc[hi, "mean"] * 100, 1),
                     "lowest_segment": lo, "lowest_rate_pct": round(g.loc[lo, "mean"] * 100, 1)})
    if len(rows) < 2:
        raise ValueError("not enough comparable columns")
    data = pd.DataFrame(rows).sort_values("spread_pts", ascending=False).head(10).reset_index(drop=True)

    def draw(fig, ax):
        _bars(ax, data["column"], data["spread_pts"].values, "number", suffix=" pts")
        ax.set_xlabel(f"Gap between the highest and lowest segment's {ctx['target']} rate (percentage points)")
    return data, draw, f"How much the {ctx['target']} rate varies across each column's segments"


def _k_distribution_by_outcome(df, spec, tgt, ctx):
    _need(df, spec, "y", numeric=("y",))
    y = df[spec["y"]]
    if tgt is not None:
        groups = {f"{ctx['target']} = {ctx['pos']}": y[tgt], "Others": y[~tgt]}
    elif spec.get("group") in df.columns:
        top = df[spec["group"]].astype(str).value_counts().index[:4]
        groups = {g: y[df[spec["group"]].astype(str) == g] for g in top}
    else:
        groups = {"All records": y}
    groups = {k: v.dropna() for k, v in groups.items() if v.notna().sum() >= 5}
    if not groups:
        raise ValueError("no data")
    data = pd.DataFrame([{"group": k, "records": len(v), "mean": round(v.mean(), 2), "median": round(v.median(), 2),
                          "p25": round(v.quantile(.25), 2), "p75": round(v.quantile(.75), 2)} for k, v in groups.items()])
    bins = np.histogram_bin_edges(y.dropna(), bins=30)
    colors = [cs.ACCENT, cs.SERIES[0], cs.SERIES[2], cs.SERIES[3]]
    dens = len(groups) > 1

    def draw(fig, ax):
        for (name, v), c in zip(groups.items(), colors):
            ax.hist(v, bins=bins, density=dens, histtype="stepfilled", alpha=0.16, color=c)
            ax.hist(v, bins=bins, density=dens, histtype="step", lw=1.8, color=c, label=f"{name} (median {cs.fmt_number(v.median())})")
            ax.axvline(v.median(), color=c, lw=1, ls=(0, (4, 3)))
        ax.set_xlabel(spec["y"])
        if dens:
            ax.set_yticks([])
            ax.set_ylabel("Share of records")
        else:
            ax.yaxis.set_major_formatter(cs.axis_formatter())
        ax.xaxis.set_major_formatter(cs.axis_formatter())
        ax.legend(loc="upper right")
    return data, draw, f"Distribution of {spec['y']} (dashed line = median)"


def _k_mean_by_category(df, spec, tgt, ctx):
    _need(df, spec, "x", "y", numeric=("y",))
    cat, ordered = _as_category(df[spec["x"]])
    g = pd.DataFrame({"c": cat, "v": df[spec["y"]]}).dropna().groupby("c", observed=True, sort=False)["v"].agg(["mean", "size"])
    g = g[g["size"] >= _min_size(df)]
    g = g.reindex([c for c in ordered if c in g.index]) if ordered else \
        g.sort_values("mean", ascending=False).head(TOP_N)
    if len(g) < 2:
        raise ValueError("fewer than 2 segments")
    overall = df[spec["y"]].mean()
    data = pd.DataFrame({spec["x"]: g.index, f"avg_{spec['y']}": g["mean"].round(2).values, "records": g["size"].values})
    return data, lambda fig, ax: _bars(ax, g.index, g["mean"].values, "number", overall, f"Overall {cs.fmt_number(overall)}"), \
        f"Average {spec['y']} by {spec['x']}"


def _k_box_by_category(df, spec, tgt, ctx):
    _need(df, spec, "x", "y", numeric=("y",))
    cat, _ = _as_category(df[spec["x"]])
    frame = pd.DataFrame({"c": cat, "v": df[spec["y"]]}).dropna()
    order = frame.groupby("c")["v"].median().sort_values(ascending=False).index[:8]
    series = [frame.loc[frame["c"] == c, "v"] for c in order]
    if len(series) < 2:
        raise ValueError("fewer than 2 segments")
    data = pd.DataFrame([{spec["x"]: c, "median": round(s.median(), 2), "p25": round(s.quantile(.25), 2),
                          "p75": round(s.quantile(.75), 2), "records": len(s)} for c, s in zip(order, series)])

    def draw(fig, ax):
        bp = ax.boxplot(series, patch_artist=True, widths=0.55, showfliers=False,
                        medianprops={"color": cs.INK, "lw": 1.6}, whiskerprops={"color": cs.FAINT},
                        capprops={"color": cs.FAINT})
        for i, box in enumerate(bp["boxes"]):
            box.set(facecolor=cs.ACCENT if i == 0 else cs.BASE, edgecolor="none", alpha=0.85)
        ax.set_xticks(range(1, len(order) + 1), [str(c) for c in order])
        ax.yaxis.set_major_formatter(cs.axis_formatter())
        ax.set_ylabel(spec["y"])
    return data, draw, f"{spec['y']} by {spec['x']}: box = middle 50% of records, line = median"


def _k_count_by_category(df, spec, tgt, ctx):
    _need(df, spec, "x")
    cat, ordered = _as_category(df[spec["x"]])
    counts = cat.value_counts()
    counts = counts.reindex([c for c in ordered if c in counts.index]) if ordered else counts.head(TOP_N)
    data = pd.DataFrame({spec["x"]: counts.index, "records": counts.values,
                         "share_pct": (counts.values / len(df) * 100).round(1)})
    return data, lambda fig, ax: _bars(ax, counts.index, counts.values, "number"), f"Number of records by {spec['x']}"


def _k_composition(df, spec, tgt, ctx):
    _need(df, spec, "x")
    counts = df[spec["x"]].astype(str).value_counts()
    if len(counts) > 6:
        counts = pd.concat([counts.head(5), pd.Series({"Other": counts.iloc[5:].sum()})])
    data = pd.DataFrame({spec["x"]: counts.index, "records": counts.values,
                         "share_pct": (counts.values / counts.sum() * 100).round(1)})

    def draw(fig, ax):
        ax.grid(False)
        colors = [cs.ACCENT, cs.SERIES[0], cs.SERIES[2], cs.SERIES[3], cs.SERIES[4], cs.BASE]
        wedges, _ = ax.pie(counts.values, colors=colors[:len(counts)], startangle=90, counterclock=False,
                           wedgeprops={"width": 0.36, "edgecolor": cs.CANVAS, "linewidth": 2})
        ax.text(0, 0.06, cs.fmt_number(counts.sum()), ha="center", fontsize=20, fontweight="bold", color=cs.INK)
        ax.text(0, -0.16, "records", ha="center", fontsize=10, color=cs.MUTED)
        ax.legend(wedges, [f"{k}   {v:.1f}%" for k, v in zip(data[spec["x"]], data["share_pct"])],
                  loc="center left", bbox_to_anchor=(1.0, 0.5), fontsize=10.5)
        ax.set_aspect("equal")
    return data, draw, f"Share of records by {spec['x']}"


def _k_trend(df, spec, tgt, ctx):
    _need(df, spec, "x")
    raw = df[spec["x"]]
    if pd.api.types.is_numeric_dtype(raw) and not pd.api.types.is_datetime64_any_dtype(raw):
        raise ValueError(f"{spec['x']} is numeric, not a date column")
    d = pd.to_datetime(raw, errors="coerce")
    if d.notna().mean() < 0.8:
        raise ValueError(f"{spec['x']} is not a date column")
    span_days = (d.max() - d.min()).days
    freq = "D" if span_days <= 90 else ("W" if span_days <= 365 else "M")
    per = d.dt.to_period(freq)
    if tgt is not None:
        s, label, kind = tgt.groupby(per).mean() * 100, f"{ctx['target']} rate", "percent"
    elif spec.get("y") in df.columns and pd.api.types.is_numeric_dtype(df[spec["y"]]):
        s, label, kind = df[spec["y"]].groupby(per).mean(), f"Average {spec['y']}", "number"
    else:
        s, label, kind = per.value_counts().sort_index(), "Records", "number"
    s = s.dropna()
    if len(s) < 3:
        raise ValueError("fewer than 3 periods")
    data = pd.DataFrame({"period": s.index.astype(str), label: s.round(2).values})

    def draw(fig, ax):
        x = s.index.to_timestamp()
        ax.plot(x, s.values, color=cs.SERIES[0], lw=2.2)
        ax.fill_between(x, s.values, s.min(), color=cs.SERIES[0], alpha=0.08)
        ax.scatter([x[-1]], [s.values[-1]], color=cs.ACCENT, s=36, zorder=3)
        ax.annotate(cs.fmt_number(s.values[-1], kind), (x[-1], s.values[-1]), xytext=(6, 6),
                    textcoords="offset points", fontsize=10, fontweight="bold", color=cs.ACCENT)
        ax.yaxis.set_major_formatter(cs.axis_formatter(kind))
    unit = {"D": "day", "W": "week", "M": "month"}[freq]
    return data, draw, f"{label} per {unit}"


def _k_scatter(df, spec, tgt, ctx):
    _need(df, spec, "x", "y", numeric=("x", "y"))
    sample = df.sample(min(len(df), 3000), random_state=7)
    if tgt is not None:
        split = {"Others": ~tgt.loc[sample.index], f"{ctx['target']} = {ctx['pos']}": tgt.loc[sample.index]}
    else:
        split = {"Records": pd.Series(True, index=sample.index)}
    corr = df[[spec["x"], spec["y"]]].corr().iloc[0, 1]
    data = pd.DataFrame([{"x": spec["x"], "y": spec["y"], "correlation": round(corr, 3), "records": len(df)}])

    def draw(fig, ax):
        for (name, m), c in zip(split.items(), [cs.BASE, cs.ACCENT] if len(split) > 1 else [cs.SERIES[0]]):
            ax.scatter(sample.loc[m, spec["x"]], sample.loc[m, spec["y"]], s=12, alpha=0.5, color=c,
                       label=name, edgecolors="none")
        ax.grid(axis="x", visible=True)
        ax.set_xlabel(spec["x"])
        ax.set_ylabel(spec["y"])
        ax.xaxis.set_major_formatter(cs.axis_formatter())
        ax.yaxis.set_major_formatter(cs.axis_formatter())
        if len(split) > 1:
            ax.legend(loc="upper left", markerscale=2)
    return data, draw, f"{spec['y']} vs {spec['x']} (correlation {corr:.2f}, {len(sample):,} sampled records)"


def _k_correlation_matrix(df, spec, tgt, ctx):
    num = df.select_dtypes(include=np.number).copy()
    num = num.loc[:, num.nunique() > 1]
    if tgt is not None:
        num.insert(0, ctx["target"], tgt.astype(float))
    if num.shape[1] < 3:
        raise ValueError("needs 3+ numeric columns")
    corr = num.corr()
    keep = (corr[ctx["target"]].abs().sort_values(ascending=False).index if tgt is not None
            else num.var().sort_values(ascending=False).index)[:9]
    corr = corr.loc[keep, keep].round(2)
    data = corr.reset_index().rename(columns={"index": "column"})

    # Lower triangle without the diagonal (self-correlation is always 1 and only adds noise).
    tri = corr.values[1:, :-1]
    rows, cols = list(corr.index[1:]), list(corr.columns[:-1])

    def draw(fig, ax):
        ax.grid(False)
        fig.subplots_adjust(bottom=0.24)
        mask = np.triu(np.ones_like(tri, dtype=bool), k=1)
        ax.imshow(np.ma.array(tri, mask=mask), cmap=cs.DIVERGE, vmin=-1, vmax=1)
        for i in range(len(rows)):
            for j in range(i + 1):
                v = tri[i, j]
                ax.text(j, i, f"{v:.2f}", ha="center", va="center", fontsize=9.5,
                        color=cs.CANVAS if abs(v) > 0.6 else cs.INK)
        ax.set_xticks(range(len(cols)), cols, rotation=30, ha="right")
        ax.set_yticks(range(len(rows)), rows)
    return data, draw, "Correlation between measures (−1 to +1); stronger colour = stronger link"


_KIND_FUNCS: dict = {k: globals()[f"_k_{k}"] for k in KINDS}


# ── Public API ────────────────────────────────────────────────────────────────

def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(s).lower()).strip("_")[:40] or "chart"


def build_chart_pack(table: Optional[str] = None, goal: str = "", db_uri: str = "",
                     max_charts: int = MAX_CHARTS, record_session: bool = True) -> dict:
    """Plan → compute → write insights → render. Returns charts with paths and insights."""
    engine = _engine(_resolve_db_uri(db_uri))
    if not table:
        from features.dashboard import _pick_table
        table = _pick_table(engine, None)
    profile = profile_table(engine, table)
    df = pd.read_sql(text(f"SELECT * FROM {_q(table)} LIMIT {MAX_ROWS}"), engine)

    plan, u1 = _plan(profile, goal, max_charts)
    tgt, pos = _target_mask(df, plan.get("target_column", ""), str(plan.get("positive_value", "")))
    ctx = {"target": plan.get("target_column", "") if tgt is not None else "", "pos": pos}

    items, skipped, seen = [], [], set()
    for spec in plan.get("charts", []):
        key = (spec.get("kind"), spec.get("x"), spec.get("y"))
        if key in seen or spec.get("kind") not in _KIND_FUNCS:
            continue
        seen.add(key)
        try:
            data, draw, subtitle = _KIND_FUNCS[spec["kind"]](df, spec, tgt, ctx)
        except Exception as e:
            skipped.append({"title": spec.get("title"), "kind": spec.get("kind"), "reason": str(e)[:160]})
            continue
        items.append({"id": f"c{len(items)}", "kind": spec["kind"], "question": spec.get("question", ""),
                      "title": spec.get("title", ""), "data": data, "draw": draw, "subtitle": subtitle})
        if len(items) >= max_charts:
            break
    if not items:
        raise ValueError(f"No chart could be built for '{table}'. Skipped: {skipped}")

    usage, notes = [u1], {}
    try:
        res, u2 = _insights(goal, items)
        usage.append(u2)
        notes = {n.get("id"): n for n in res.get("insights", [])}
    except Exception as e:
        print(f"[ChartPack] insight writing skipped: {e}", flush=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    source = f"Source: {table} · {len(df):,} records"
    charts = []
    for i, it in enumerate(items):
        note = notes.get(it["id"], {})
        title = (note.get("headline") or it["title"] or it["question"]).strip().rstrip(".")
        fig, ax = cs.new_figure()
        it["draw"](fig, ax)
        cs.frame(fig, title, it["subtitle"], source)
        path = cs.save(fig, os.path.join(CHARTS_DIR, f"chart_{i + 1}_{_slug(it['kind'])}_{_slug(table)}_{ts}.png"))
        charts.append({
            "title": title, "chart_type": it["kind"], "question": it["question"],
            "chart_path": path, "chart_url": "/outputs/charts/" + os.path.basename(path),
            "analysis": note.get("insight", ""), "recommendation": note.get("recommendation", ""),
            "data": json.loads(it["data"].head(15).to_json(orient="records", default_handler=str)),
        })

    if record_session:
        _record_session(charts)
    return {
        "table": table, "target": ctx["target"], "positive_value": pos, "charts": charts, "skipped": skipped,
        "llm_usage": {"calls": len(usage), "input_tokens": sum(u["input_tokens"] for u in usage),
                      "output_tokens": sum(u["output_tokens"] for u in usage)},
    }


def _record_session(charts: list) -> None:
    """Append to session_charts.json in the schema app.py already reads."""
    try:
        with open(META_PATH, encoding="utf-8") as fh:
            existing = json.load(fh)
    except Exception:
        existing = []
    for c in charts:
        entry = {"title": c["title"], "chart_type": c["chart_type"], "chart_url": c["chart_url"],
                 "gemini_analysis": c["analysis"], "nvidia_recommendations": c["recommendation"]}
        if c.get("chart_html_url"):
            entry["chart_html_url"] = c["chart_html_url"]   # interactive version (Plotly/Altair/Bokeh)
        existing.append(entry)
    with open(META_PATH, "w", encoding="utf-8") as fh:
        json.dump(existing, fh, indent=2, ensure_ascii=False)
