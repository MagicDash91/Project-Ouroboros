"""
tools/chart_codegen.py – Claude picks the visualizations and writes their code.

One Claude call looks at a profile of the real table plus the analysis goal, decides
which charts answer the problem, and writes the code for each in the library that
suits it (Plotly, Altair, Bokeh, Matplotlib or Seaborn). The code runs in
tools/chart_runner.py — a separate, time-limited process with a scrubbed environment,
screened imports and restricted builtins. Failed charts get one batched repair call;
a final call turns the plotted numbers into finding-style headlines.

Interactive charts are saved as HTML (shown in the web app); PNGs are exported where
the library allows (Plotly via Kaleido, Matplotlib/Seaborn) for the PDF/PowerPoint.
"""

import json
import os
import pickle
import shutil
import subprocess
import sys
import tempfile
import threading
from datetime import datetime
from typing import Optional

import pandas as pd
from sqlalchemy import text

from features.dashboard import _pick_table, _profile_text, _q, profile_table
from features.deeper import _engine, _resolve_db_uri
from tools.chart_pack import CHARTS_DIR, _insights, _record_session, _slug, _tool_call
from tools.chart_runner import check_code

BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER      = os.path.join(BASE_DIR, "tools", "chart_runner.py")
MAX_CHARTS  = 6
MAX_ROWS    = 50000
RUN_TIMEOUT = 300           # seconds for the whole sandbox session
LIBRARIES   = ["plotly", "altair", "bokeh", "matplotlib", "seaborn"]
# Only what Python, matplotlib and Kaleido need — no API keys or database URIs.
_ENV_KEEP   = ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA",
               "APPDATA", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE")

_CODE_TOOL = {
    "name": "write_charts",
    "description": "Return the charts to build, each with its code.",
    "input_schema": {
        "type": "object",
        "properties": {
            "target_column": {"type": "string", "description": "Outcome column the business cares about, or empty."},
            "charts": {
                "type": "array", "maxItems": MAX_CHARTS,
                "items": {
                    "type": "object",
                    "properties": {
                        "title":    {"type": "string", "description": "Short working title."},
                        "question": {"type": "string", "description": "The business question this chart answers (one line)."},
                        "library":  {"type": "string", "enum": LIBRARIES},
                        "code":     {"type": "string", "description": "Python code following the contract."},
                    },
                    "required": ["title", "question", "library", "code"],
                },
            },
        },
        "required": ["target_column", "charts"],
    },
}

_FIX_TOOL = {
    "name": "fix_charts",
    "description": "Return corrected code for the failed charts.",
    "input_schema": {
        "type": "object",
        "properties": {"fixes": {"type": "array", "items": {
            "type": "object",
            "properties": {"id": {"type": "string"}, "library": {"type": "string", "enum": LIBRARIES},
                           "code": {"type": "string"}},
            "required": ["id", "library", "code"]}}},
        "required": ["fixes"],
    },
}

_CONTRACT = """Code contract — the code runs in a sandbox:
- `df` (pandas DataFrame with the whole table) is already loaded. Never load/fetch data, never write files, never call show()/save()/write_*().
- Pre-imported: pd, np, px (plotly.express), go (plotly.graph_objects), alt (altair), bk (bokeh.plotting), plt (matplotlib.pyplot), sns (seaborn). Other allowed imports: math, statistics, datetime, collections, itertools, re, json. Everything else is blocked, as are open/eval/exec/getattr/type, os/sys, classes, with-blocks, and any name or attribute starting with "_".
- Assign the finished chart to `fig` (plotly Figure, altair Chart, bokeh figure, or matplotlib Figure).
- Assign `summary` = a pandas DataFrame (max 15 rows) of exactly the numbers the chart shows.
- Do NOT set a chart title — a headline is added afterwards. Use short, readable axis titles.
- Style: light background (themes are pre-set). THEME = dict(accent, base, series[list], ink, muted, grid).
  Colour the single most important bar/segment/line — the one the finding is about, usually the highest
  risk or largest value — with THEME["accent"] and the rest with THEME["base"]. For grouped series use
  THEME["series"], giving the accent colour to the group the finding is about. No 3D, gradients,
  rainbow palettes, or chart borders.
- Aggregate before plotting (no thousands of raw bars); sample scatters to <= 3000 points.
- Percentages on a 0–100 scale with a % suffix. Sort bars by value unless the axis is ordinal.
- Plain top-level statements, under ~40 lines per chart."""

_LIBRARY_GUIDE = (
    "Pick the library per chart: plotly for most charts (interactive hover/zoom; also treemap, sunburst, "
    "funnel, waterfall); altair for compact statistical or faceted views; bokeh for dense interactive "
    "scatter views; matplotlib/seaborn only for static statistical plots (e.g. annotated heatmaps) where "
    "interactivity adds nothing. Prefer plotly when unsure."
)


def _design(profile: dict, goal: str, max_charts: int) -> tuple:
    system = (
        "You are a senior data analyst and visualization engineer. From the data profile, identify the "
        "outcome the business cares about (if any) and choose the charts that best answer the problem: what "
        "drives the outcome, which segments are most affected, how key measures differ, how things move over "
        "time if there is a date. Use whatever chart type fits each question best — not a fixed recipe. Every "
        "chart must answer a different question; use exact column names; skip id and free-text columns.\n\n"
        f"{_LIBRARY_GUIDE}\n\n{_CONTRACT}"
    )
    user = (f"{_profile_text(profile)}\n\nAnalysis goal: {goal.strip() or 'General analysis of this data.'}\n\n"
            f"Write {max_charts} charts, most important first.")
    return _tool_call(system, user, _CODE_TOOL, max_tokens=12000)


def _repair(profile: dict, failed: list) -> tuple:
    system = "You fix Python chart code so it runs in the sandbox and follows the contract.\n\n" + _CONTRACT
    user = _profile_text(profile) + "\n\nThese charts failed:\n\n" + "\n\n".join(
        f"[{f['id']}] {f['question']} (library: {f['library']})\nError: {f['error']}\nCode:\n{f['code']}"
        for f in failed)
    return _tool_call(system, user, _FIX_TOOL, max_tokens=8000)


class _Sandbox:
    """The chart_runner subprocess plus a watchdog that kills it on timeout."""

    def __init__(self, data_path: str, workdir: str):
        env = {k: os.environ[k] for k in _ENV_KEEP if k in os.environ}
        env.update(MPLBACKEND="Agg", PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
        self.proc = subprocess.Popen(
            [sys.executable, "-I", RUNNER, BASE_DIR], cwd=workdir, env=env, text=True, encoding="utf-8",
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.data_path = data_path
        self._timer = threading.Timer(RUN_TIMEOUT, self.proc.kill)
        self._timer.start()
        self._first = True

    def send(self, msg: dict) -> dict:
        if self._first:
            msg = {"data": self.data_path, **msg}
            self._first = False
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("chart sandbox stopped (timed out or crashed)")
        return json.loads(line)

    def close(self):
        self._timer.cancel()
        if self.proc.poll() is None:
            self.proc.kill()


def _url(path: str) -> str:
    return "/outputs/charts/" + os.path.basename(path) if path else ""


def build_code_charts(table: Optional[str] = None, goal: str = "", db_uri: str = "",
                      max_charts: int = MAX_CHARTS, record_session: bool = True) -> dict:
    """Claude designs + codes the charts; they run sandboxed; returns charts with files and insights."""
    engine = _engine(_resolve_db_uri(db_uri))
    table = table or _pick_table(engine, None)
    profile = profile_table(engine, table)
    df = pd.read_sql(text(f"SELECT * FROM {_q(table)} LIMIT {MAX_ROWS}"), engine)

    design, u = _design(profile, goal, max_charts)
    usage = [u]
    specs = {f"c{i}": {**c, "id": f"c{i}"} for i, c in enumerate(design.get("charts", [])[:max_charts])}
    if not specs:
        raise ValueError("Claude returned no charts")

    workdir = tempfile.mkdtemp(prefix="uaa_charts_")
    data_path = os.path.join(workdir, "table.pkl")
    with open(data_path, "wb") as fh:
        pickle.dump(df, fh)
    box = _Sandbox(data_path, workdir)
    try:
        def run(batch: dict) -> dict:
            ready, blocked = [], {}
            for cid, s in batch.items():
                problems = check_code(s["code"])
                if problems:
                    blocked[cid] = {"id": cid, "ok": False, "error": "blocked: " + "; ".join(problems)}
                else:
                    ready.append({"id": cid, "code": s["code"]})
            out = {r["id"]: r for r in box.send({"jobs": ready})["results"]} if ready else {}
            return {**out, **blocked}

        results = run(specs)
        failed = [{**specs[i], "error": r["error"]} for i, r in results.items() if not r["ok"]]
        repaired = [f["id"] for f in failed]
        if failed:
            try:
                fixes, u = _repair(profile, failed)
                usage.append(u)
                for fx in fixes.get("fixes", []):
                    if fx.get("id") in specs:
                        specs[fx["id"]].update(code=fx["code"], library=fx.get("library", specs[fx["id"]]["library"]))
                results.update(run({f["id"]: specs[f["id"]] for f in failed}))
            except Exception as e:
                print(f"[ChartCodegen] repair skipped: {e}", flush=True)

        ok = [cid for cid in specs if results.get(cid, {}).get("ok")]
        if not ok:
            raise ValueError("No chart code ran successfully: " +
                             "; ".join(f"{i}: {r['error']}" for i, r in results.items()))

        items = []
        for cid in ok:
            summ = results[cid]["summary"]
            items.append({"id": cid, "kind": results[cid]["library"], "question": specs[cid]["question"],
                          "data": pd.DataFrame(summ if isinstance(summ, list) else [summ])})
        notes = {}
        try:
            res, u = _insights(goal, items)
            usage.append(u)
            notes = {n.get("id"): n for n in res.get("insights", [])}
        except Exception as e:
            print(f"[ChartCodegen] insight writing skipped: {e}", flush=True)

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        titles = {cid: {"title": (notes.get(cid, {}).get("headline") or specs[cid]["title"]).strip().rstrip("."),
                        "subtitle": specs[cid]["question"]} for cid in ok}
        exported = {e["id"]: e for e in box.send({
            "titles": titles, "source": f"Source: {table} · {len(df):,} records",
            "out_dir": CHARTS_DIR, "stem": f"chart_{_slug(table)}_{ts}"})["results"]}
    finally:
        box.close()
        shutil.rmtree(workdir, ignore_errors=True)

    charts = []
    for cid in ok:
        e = exported.get(cid, {})
        if not (e.get("png") or e.get("html")):
            continue
        charts.append({
            "title": titles[cid]["title"], "question": specs[cid]["question"],
            "chart_type": results[cid]["library"], "library": results[cid]["library"],
            "chart_path": e.get("png") or e.get("html"),
            "chart_url": _url(e.get("png")), "chart_html_url": _url(e.get("html")),
            "analysis": notes.get(cid, {}).get("insight", ""),
            "recommendation": notes.get(cid, {}).get("recommendation", ""),
            "data": results[cid]["summary"], "code": specs[cid]["code"],
        })
    if record_session:
        _record_session(charts)
    return {
        "table": table, "target": design.get("target_column", ""), "charts": charts, "repaired": repaired,
        "failed": [{"id": i, "title": specs[i]["title"], "error": r["error"]} for i, r in results.items() if not r["ok"]],
        "llm_usage": {"calls": len(usage), "input_tokens": sum(x["input_tokens"] for x in usage),
                      "output_tokens": sum(x["output_tokens"] for x in usage)},
    }
