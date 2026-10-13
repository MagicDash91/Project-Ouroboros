"""
tools/bank_analyst.py – Banking data visualization, chart analysis, and reporting tools.
Mirrors Bank_Agent/tools/analyst_tools.py with paths adjusted to this system.
"""

import os
import sys
import json
import base64
import time
import threading
import warnings
import numpy as np
import pandas as pd
from datetime import datetime

warnings.filterwarnings("ignore")

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import seaborn as sns

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crewai.tools import tool
from features.db_connect import cached_engine as create_engine   # one shared pool per database

from config import POSTGRES_URI, query_ollama as query_nvidia


def _get_db_uri() -> str:
    """Return the active database URI (set per-run via ACTIVE_DB_URI env var)."""
    return os.environ.get("ACTIVE_DB_URI") or POSTGRES_URI

sns.set_theme(style="whitegrid", palette="husl")

BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHARTS_DIR  = os.path.join(BASE_DIR, "outputs", "charts")
REPORTS_DIR = os.path.join(BASE_DIR, "outputs", "reports")
os.makedirs(CHARTS_DIR,  exist_ok=True)
os.makedirs(REPORTS_DIR, exist_ok=True)


# ── Gemini rate limiter ───────────────────────────────────────────────────────

class _GeminiRateLimiter:
    def __init__(self, max_requests: int = 3, pause_seconds: int = 60):
        self._count = 0
        self._max   = max_requests
        self._pause = pause_seconds
        self._lock  = threading.Lock()

    def throttle(self):
        with self._lock:
            if self._count > 0 and self._count % self._max == 0:
                print(f"\n[GeminiRateLimiter] {self._count} requests completed. "
                      f"Pausing {self._pause}s to avoid rate limits...")
                time.sleep(self._pause)
                print("[GeminiRateLimiter] Resuming.\n")
            self._count += 1


_gemini_rate_limiter = _GeminiRateLimiter(max_requests=3, pause_seconds=60)


def _chart_data_summary(
    df: pd.DataFrame,
    chart_type: str,
    x_column: str = "",
    y_column: str = "",
    hue_column: str = "",
    table_name: str = "",
    title: str = "",
    max_rows: int = 25,
) -> str:
    """Summarise the *data that produced a chart* as compact, self-describing text.

    gpt-oss-120b cannot read images, so instead of sending the rendered PNG we
    send the actual aggregated numbers behind it, plus a plain-language header
    that explains exactly what the chart plots and how to read each number.
    """
    header_lines = [
        f"Chart title : {title or '(auto)'}",
        f"Chart type  : {chart_type}",
        f"Source table: {table_name or '(unknown)'}",
        f"Rows in data: {len(df)}",
    ]
    if x_column:
        header_lines.append(f"X axis / grouping column: {x_column}")
    if y_column:
        header_lines.append(f"Y axis / measured column: {y_column}")
    if hue_column and hue_column in df.columns:
        header_lines.append(f"Colour grouping (series): {hue_column}")
    header = "\n".join(header_lines)

    try:
        hue = hue_column if hue_column and hue_column in df.columns else None

        if chart_type == "heatmap":
            corr = df.select_dtypes(include=np.number).corr().round(3)
            body = ("This is a correlation matrix. Each cell is the Pearson correlation "
                    "(-1 to +1) between two numeric columns; values near +1/-1 mean a "
                    "strong positive/negative relationship, near 0 means none.\n\n"
                    + corr.to_string())

        elif chart_type in ("histogram", "histplot", "box"):
            col = (y_column or x_column)
            if col in df.columns and pd.api.types.is_numeric_dtype(df[col]):
                desc = df[col].describe().round(3)
                body = (f"This shows the distribution of the numeric column '{col}'. "
                        "Below are summary statistics (count, mean, std, min, quartiles, max):\n\n"
                        + desc.to_string())
            else:
                vc = df[col].value_counts().head(max_rows) if col in df.columns else pd.Series(dtype=float)
                body = (f"This shows how often each category of '{col}' occurs "
                        "(category : number of rows):\n\n" + vc.to_string())

        elif chart_type == "pie":
            if y_column and y_column in df.columns:
                agg = df.groupby(x_column)[y_column].sum().sort_values(ascending=False).head(max_rows)
            else:
                agg = df[x_column].value_counts().head(max_rows)
            total = float(agg.sum()) or 1.0
            pct = (agg / total * 100).round(2)
            body = (f"This pie chart shows each slice's share of the total for '{x_column}'. "
                    "Columns below are the raw value and its percentage of the whole:\n\n"
                    + pd.concat([agg.round(3), pct.rename("pct_of_total_%")], axis=1).to_string())

        elif chart_type == "scatter" and y_column in df.columns and x_column in df.columns:
            sub = df[[x_column, y_column]].dropna()
            corr = sub[x_column].corr(sub[y_column]) if len(sub) > 1 else float("nan")
            body = (f"This scatter plot relates '{x_column}' (X) to '{y_column}' (Y). "
                    f"Their Pearson correlation is {round(float(corr), 3)} "
                    "(-1 to +1; magnitude = strength of the linear relationship).\n\n"
                    f"Statistics for {x_column}:\n{sub[x_column].describe().round(3).to_string()}\n\n"
                    f"Statistics for {y_column}:\n{sub[y_column].describe().round(3).to_string()}")

        elif y_column and y_column in df.columns and pd.api.types.is_numeric_dtype(df[y_column]):
            group_cols = [x_column] + ([hue] if hue else [])
            agg = df.groupby(group_cols)[y_column].mean().round(3)
            if not hue:
                agg = agg.sort_values(ascending=False)
            body = (f"This {chart_type} chart plots the AVERAGE of '{y_column}' for each "
                    f"value of {group_cols}. Below are those averages "
                    f"(showing the top {max_rows}):\n\n" + agg.head(max_rows).to_string())

        else:
            vc = df[x_column].value_counts().head(max_rows)
            body = (f"This {chart_type} chart shows the number of rows for each value of "
                    f"'{x_column}' (category : count):\n\n" + vc.to_string())

        return header + "\n\n" + body
    except Exception as exc:
        return header + f"\n\n(Could not summarise chart data: {exc})"


def _analyze_chart_data(summary: str, context: str = "") -> str:
    """Send a chart's underlying data summary to Claude for narrative analysis.

    The model never sees the image — it reasons purely over the numeric summary,
    so the prompt explains that explicitly and asks for a structured answer.
    """
    system_prompt = (
        "You are a senior banking & business-intelligence analyst writing the "
        "commentary that will sit underneath a chart in an executive report.\n\n"
        "IMPORTANT: You are given the AGGREGATED DATA that the chart was built "
        "from (tables and statistics), NOT the chart image. Base every statement "
        "strictly on these numbers — do not invent values you cannot see, and do "
        "not describe colours, axes positions, or visual styling.\n\n"
        "Write the analysis using EXACTLY these five Markdown sections:\n"
        "1. **Key Findings** — the 2-4 most important facts, each citing a "
        "specific number from the data.\n"
        "2. **Business Insights** — what these numbers mean for strategy, "
        "operations, revenue, or customers.\n"
        "3. **Trends & Anomalies** — the largest/smallest values, notable gaps, "
        "outliers, or correlations, with the figures that prove them.\n"
        "4. **Risk Factors** — concrete risks the data exposes (concentration, "
        "decline, volatility, imbalance, etc.).\n"
        "5. **Recommendations** — exactly 3 specific, actionable next steps.\n\n"
        "Be concise, quantitative, and decision-oriented. Use plain business "
        "language an executive can act on."
    )
    user_prompt = (
        f"Chart context: {context}\n\n"
        f"Here is the data behind the chart:\n\n{summary}\n\n"
        "Now write the five-section analysis described in your instructions."
    )
    try:
        return query_nvidia([
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ], max_tokens=1024)
    except Exception as exc:
        return f"AI analysis unavailable: {exc}"


def _save_fig(chart_type: str, table_name: str) -> str:
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(CHARTS_DIR, f"{chart_type}_{table_name}_{ts}.png")
    plt.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close()
    return path


@tool("Generate Data Visualization")
def generate_visualization(
    table_name: str,
    chart_type: str,
    x_column: str,
    y_column: str = "",
    title: str = "",
    hue_column: str = "",
) -> str:
    """
    Generate a single chart from a database table and analyse it with AI vision.

    Args:
        table_name:  Source database table name.
        chart_type:  'bar', 'line', 'scatter', 'histogram', 'heatmap', 'pie', 'histplot'
        x_column:    X-axis or grouping column (required).
        y_column:    Y-axis column — leave blank for histogram, pie, or heatmap.
        title:       Chart title (auto-generated if blank).
        hue_column:  Colour grouping column (optional — leave blank if not needed).

    Returns:
        JSON with chart_path, gemini_vision_analysis, and nvidia_recommendations.
    """
    if not (table_name and x_column):
        return json.dumps({"status": "error", "message": "table_name and x_column are required."})

    try:
        engine = create_engine(_get_db_uri())
        df = pd.read_sql(f"SELECT * FROM {table_name} LIMIT 10000", engine)

        fig, ax = plt.subplots(figsize=(12, 7))
        auto_title = title or f"{chart_type.title()}: {y_column or x_column} by {x_column}"
        hue = hue_column if hue_column and hue_column in df.columns else None

        if chart_type == "bar":
            sns.barplot(data=df, x=x_column, y=y_column, hue=hue, palette="husl", errorbar=None, ax=ax)
        elif chart_type == "line":
            sns.lineplot(data=df.sort_values(x_column), x=x_column, y=y_column, hue=hue, palette="husl", ax=ax)
        elif chart_type == "scatter":
            sns.scatterplot(data=df, x=x_column, y=y_column, hue=hue, palette="husl", alpha=0.6, ax=ax)
        elif chart_type == "histogram":
            sns.histplot(data=df, x=x_column, bins=30, kde=True, edgecolor="white", alpha=0.85, ax=ax)
        elif chart_type == "heatmap":
            nums = df.select_dtypes(include=np.number).columns.tolist()
            corr = df[nums].corr()
            sns.heatmap(corr, annot=True, fmt=".2f", cmap="RdYlGn", ax=ax, center=0, linewidths=0.5, annot_kws={"size": 8})
        elif chart_type in ("box", "histplot"):
            col = y_column or x_column
            sns.histplot(data=df, x=col, hue=hue, palette="husl", bins=30, kde=True, alpha=0.55, multiple="layer", ax=ax)
            ax.set_xlabel(col, fontsize=12)
            ax.set_ylabel("Number of Customers", fontsize=12)
        elif chart_type == "pie":
            pdata = (df.groupby(x_column)[y_column].sum() if y_column else df[x_column].value_counts())
            ax.pie(pdata.values, labels=pdata.index, autopct="%1.1f%%", startangle=90,
                   colors=sns.color_palette("husl", len(pdata)))
            ax.axis("equal")

        ax.set_title(auto_title, fontsize=14, fontweight="bold", pad=20)
        if chart_type not in ("histogram", "heatmap", "pie", "box", "histplot"):
            ax.set_xlabel(x_column, fontsize=12)
            if y_column:
                ax.set_ylabel(y_column, fontsize=12)
        if chart_type not in ("heatmap", "pie"):
            plt.xticks(rotation=45, ha="right")
        plt.tight_layout()

        chart_path = _save_fig(chart_type, table_name)

        _data_summary = _chart_data_summary(
            df, chart_type, x_column=x_column, y_column=y_column,
            hue_column=hue_column, table_name=table_name, title=auto_title,
        )
        gemini_analysis = _analyze_chart_data(
            _data_summary,
            context=f"'{chart_type}' chart showing '{y_column or x_column}' from table '{table_name}'."
        )

        nvidia_recs = ""
        try:
            nvidia_recs = query_nvidia([
                {"role": "system", "content": "You are a banking analytics expert. Be brief."},
                {"role": "user",   "content": f"Chart: {auto_title}. Analysis:\n{gemini_analysis}\n\nGive 3 concise actionable recommendations."},
            ], max_tokens=512)
        except Exception as _nv_err:
            print(f"[BankAnalyst] NVIDIA recommendations skipped: {_nv_err}", flush=True)

        # Persist metadata for session blog
        _meta_path = os.path.join(CHARTS_DIR, "session_charts.json")
        try:
            _existing: list = []
            if os.path.exists(_meta_path):
                with open(_meta_path, "r", encoding="utf-8") as _fh:
                    _existing = json.load(_fh)
            _existing.append({
                "title":                  auto_title,
                "chart_type":             chart_type,
                "chart_url":              "/outputs/charts/" + os.path.basename(chart_path),
                "gemini_analysis":        gemini_analysis,
                "nvidia_recommendations": nvidia_recs,
            })
            with open(_meta_path, "w", encoding="utf-8") as _fh:
                json.dump(_existing, _fh, indent=2, ensure_ascii=False)
        except Exception:
            pass

        return json.dumps({
            "status":                 "success",
            "chart_path":             chart_path,
            "title":                  auto_title,
            "gemini_vision_analysis": gemini_analysis,
            "nvidia_recommendations": nvidia_recs,
        }, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Generate Analytics Dashboard")
def generate_dashboard(table_name: str) -> str:
    """
    Generate a comprehensive 7-panel analytics dashboard PNG from a database table.

    Args:
        table_name: Source database table name.

    Returns:
        JSON with dashboard PNG path and Gemini full-dashboard analysis.
    """
    try:
        engine = create_engine(_get_db_uri())
        df   = pd.read_sql(f"SELECT * FROM {table_name} LIMIT 10000", engine)
        nums = df.select_dtypes(include=np.number).columns.tolist()

        if len(nums) < 2:
            return json.dumps({"status": "error", "message": "Need ≥ 2 numeric columns for a dashboard."})

        fig = plt.figure(figsize=(22, 17))
        fig.suptitle(f"Banking Analytics Dashboard — {table_name.replace('_', ' ').title()}",
                     fontsize=18, fontweight="bold", y=0.99)
        gs = fig.add_gridspec(3, 3, hspace=0.45, wspace=0.38)

        ax1 = fig.add_subplot(gs[0, 0])
        df[nums[0]].hist(ax=ax1, bins=30, color="#2196F3", edgecolor="white", alpha=0.85)
        ax1.set_title(f"Distribution: {nums[0]}", fontweight="bold")

        ax2 = fig.add_subplot(gs[0, 1:])
        top_cols = nums[:min(8, len(nums))]
        sns.heatmap(df[top_cols].corr(), annot=True, fmt=".2f", cmap="RdYlGn",
                    ax=ax2, center=0, linewidths=0.5, annot_kws={"size": 7})
        ax2.set_title("Correlation Matrix", fontweight="bold")

        ax3 = fig.add_subplot(gs[1, :2])
        date_cols = [c for c in df.columns if any(d in c.lower() for d in ("date", "time", "month", "year"))]
        if date_cols:
            try:
                dts = pd.to_datetime(df[date_cols[0]], errors="coerce")
                sdf = df.assign(_dt=dts).dropna(subset=["_dt"]).sort_values("_dt")
                ax3.plot(sdf["_dt"], sdf[nums[0]], linewidth=2, color="#4CAF50")
                ax3.fill_between(sdf["_dt"], sdf[nums[0]], alpha=0.2, color="#4CAF50")
                ax3.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
                plt.setp(ax3.xaxis.get_majorticklabels(), rotation=45)
                ax3.set_title(f"Trend: {nums[0]} over Time", fontweight="bold")
            except Exception:
                df[nums[:3]].plot(ax=ax3, linewidth=2)
                ax3.set_title("Multi-Metric Trend", fontweight="bold")
        else:
            df[nums[:3]].plot(ax=ax3, linewidth=2)
            ax3.set_title("Multi-Metric Overview", fontweight="bold")
        ax3.grid(True, alpha=0.3)

        ax4 = fig.add_subplot(gs[1, 2])
        plot_cols = nums[:min(5, len(nums))]
        df_norm = df[plot_cols].apply(lambda x: (x - x.mean()) / (x.std() + 1e-9))
        df_norm.boxplot(ax=ax4, grid=False)
        ax4.set_title("Normalised Distributions", fontweight="bold")
        ax4.set_xticklabels(ax4.get_xticklabels(), rotation=45, ha="right", fontsize=8)

        ax5 = fig.add_subplot(gs[2, 0])
        top10 = df[nums[0]].nlargest(10)
        ax5.barh(range(len(top10)), top10.values, color=sns.color_palette("husl", 10))
        ax5.set_title(f"Top 10: {nums[0]}", fontweight="bold")

        ax6 = fig.add_subplot(gs[2, 1])
        if len(nums) >= 2:
            ax6.scatter(df[nums[0]], df[nums[1]], alpha=0.4, color="#9C27B0", edgecolors="white", s=30)
            ax6.set_xlabel(nums[0], fontsize=9)
            ax6.set_ylabel(nums[1], fontsize=9)
            ax6.set_title(f"{nums[0]} vs {nums[1]}", fontweight="bold")

        ax7 = fig.add_subplot(gs[2, 2])
        ax7.axis("off")
        stats = df[nums[:4]].describe().round(2)
        tbl = ax7.table(cellText=stats.values, rowLabels=stats.index,
                        colLabels=stats.columns, cellLoc="center", loc="center", bbox=[0, 0, 1, 1])
        tbl.auto_set_font_size(False)
        tbl.set_fontsize(7)
        ax7.set_title("Statistical Summary", fontweight="bold", pad=10)

        dashboard_path  = _save_fig("dashboard", table_name)

        _desc = df[nums[:8]].describe().round(3).to_string()
        _corr = df[nums[:8]].corr().round(3).to_string()
        _dash_summary = (
            f"Multi-panel analytics dashboard for table '{table_name}' "
            f"({len(df)} rows, {len(nums)} numeric columns).\n\n"
            f"Summary statistics for key numeric columns "
            f"(count, mean, std, min, quartiles, max):\n{_desc}\n\n"
            f"Correlation matrix between key numeric columns "
            f"(-1 to +1):\n{_corr}"
        )
        gemini_analysis = _analyze_chart_data(
            _dash_summary,
            context=f"Full analytics dashboard for '{table_name}'."
        )

        # Persist metadata
        _meta_path = os.path.join(CHARTS_DIR, "session_charts.json")
        try:
            _existing: list = []
            if os.path.exists(_meta_path):
                with open(_meta_path, "r", encoding="utf-8") as _fh:
                    _existing = json.load(_fh)
            _existing.append({
                "title":                  f"Analytics Dashboard — {table_name.replace('_', ' ').title()}",
                "chart_type":             "dashboard",
                "chart_url":              "/outputs/charts/" + os.path.basename(dashboard_path),
                "gemini_analysis":        gemini_analysis,
                "nvidia_recommendations": "",
            })
            with open(_meta_path, "w", encoding="utf-8") as _fh:
                json.dump(_existing, _fh, indent=2, ensure_ascii=False)
        except Exception:
            pass

        return json.dumps({"status": "success", "dashboard_path": dashboard_path,
                           "gemini_vision_analysis": gemini_analysis}, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Generate Business Insight Report")
def generate_text_report(analysis_results: str) -> str:
    """
    Generate a professional markdown business-insight report using NVIDIA LLaMA.

    Args:
        analysis_results: JSON or text summarising all analysis outputs.

    Returns:
        JSON with markdown report content and saved file path.
    """
    report_title = "Banking Analytics Report"
    try:
        try:
            content = query_nvidia([
                {
                    "role": "system",
                    "content": (
                        "You are a senior banking business analyst writing executive reports. "
                        "Be concise — each section should be 3-5 bullet points maximum."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f'Create a banking analytics report titled "{report_title}".\n\n'
                        f"Analysis Data:\n{analysis_results[:6000]}\n\n"
                        f"# {report_title}\n"
                        "## Executive Summary\n## Key Findings\n## Risk Assessment\n"
                        "## Business Recommendations\n## Next Steps\n\n"
                        "Be specific with metrics. Keep total response under 800 words."
                    ),
                },
            ], max_tokens=1200)
        except Exception as _nv_err:
            print(f"[BankAnalyst] NVIDIA report generation skipped: {_nv_err}", flush=True)
            content = f"# {report_title}\n\nReport generation timed out. Analysis data:\n\n{analysis_results[:3000]}"

        ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(REPORTS_DIR, f"insight_report_{ts}.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)

        return json.dumps({"status": "success", "report_path": path, "report_content": content}, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Label Encode Categorical Columns")
def label_encode_table(table_name: str) -> str:
    """
    Label-encode every categorical column in a database table and save as
    a new table named <table_name>_encoded.

    Args:
        table_name: Source database table (e.g. 'churn').

    Returns:
        JSON with the output table name, encoded column list, and row count.
    """
    from sklearn.preprocessing import LabelEncoder

    try:
        dest   = f"{table_name}_encoded"
        engine = create_engine(_get_db_uri())
        df     = pd.read_sql(f"SELECT * FROM {table_name} LIMIT 10000", engine)

        # Dates are not categories: turn date/datetime columns into "days since the first date"
        # so correlations stay meaningful, instead of label-encoding them.
        date_cols = []
        for col in df.columns:
            s = df[col]
            sample = s.dropna().head(50)
            looks_date = pd.api.types.is_datetime64_any_dtype(s) or (
                s.dtype == object and len(sample) > 0 and (
                    sample.map(lambda v: hasattr(v, "year") and hasattr(v, "month")).all()          # date objects
                    or sample.astype(str).str.match(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}.*)?$").all()))  # ISO text
            if looks_date:
                d = pd.to_datetime(s, errors="coerce")
                df[col] = (d - d.min()).dt.days
                date_cols.append(col)

        cat_cols     = [c for c in df.select_dtypes(include=["object", "category"]).columns if c not in date_cols]
        encoded_cols = []
        le           = LabelEncoder()
        for col in cat_cols:
            df[col] = le.fit_transform(df[col].astype(str))
            encoded_cols.append(col)

        for col in df.columns:
            if df[col].dtype == object:
                df[col] = pd.to_numeric(df[col], errors="coerce")

        df.to_sql(dest, engine, if_exists="replace", index=False)

        return json.dumps({"status": "success", "source_table": table_name, "output_table": dest,
                           "encoded_columns": encoded_cols, "row_count": len(df)}, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Generate Problem-Driven Charts")
def generate_problem_charts(table_name: str, goal: str) -> str:
    """
    Claude picks the charts that best answer the analysis goal for this table and writes their
    code (Plotly / Altair / Bokeh / Matplotlib), which runs in a sandbox. Produces ~6 modern,
    light-themed charts with finding-style headlines, insights and recommendations.

    Args:
        table_name: The primary analysis table (use the dbt mart when one is available).
        goal:       One sentence describing the business question to answer.

    Returns:
        JSON with each chart's title, PNG path (for PDF/PowerPoint), interactive link and insight.
    """
    try:
        from tools.chart_codegen import build_code_charts
        r = build_code_charts(table=table_name.strip(), goal=goal, db_uri=_get_db_uri())
        charts = [{"title": c["title"], "library": c["library"], "chart_path": c["chart_path"],
                   "interactive_url": c["chart_html_url"], "insight": c["analysis"],
                   "recommendation": c["recommendation"]} for c in r["charts"]]
        return json.dumps({
            "status": "success" if charts else "error",
            "charts": charts,
            "png_paths_for_reports": [c["chart_path"] for c in r["charts"] if c["chart_url"]],
            "failed": r["failed"],
        }, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)[:500]})
