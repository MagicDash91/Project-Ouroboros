"""
tools/chart_runner.py – sandboxed executor for Claude-written chart code.

Run as a separate process by tools/chart_codegen.py (never used for execution
inside the API process). Layers of protection, since no Python sandbox is perfect:

  1. AST screen (`check_code`): only charting/data imports; no file, OS, network,
     eval/exec or dunder/private attribute access; no data loading or file writing.
  2. Restricted builtins and an import hook that only admits the allowed modules.
  3. The parent starts this process with a scrubbed environment (no API keys, no
     database URI), a time limit, and only a pickled copy of the table.
  4. Output paths are chosen here; the generated code never writes files itself.

Protocol (JSON lines over stdin/stdout):
  phase 1  parent → {"data": <pickle path>, "jobs": [{id, code}]}
           runner → {"phase": "ran", "results": [{id, ok, error, library, summary}]}
  phase 2  parent → {"titles": {id: {title, subtitle}}, "source": str, "out_dir": str, "stem": str}
           runner → {"phase": "exported", "results": [{id, png, html}]}
"""

import ast
import builtins
import json
import os
import sys
import traceback

ALLOWED_IMPORTS = {
    "pandas", "numpy", "plotly", "altair", "bokeh", "matplotlib", "seaborn",
    "math", "statistics", "datetime", "collections", "itertools", "textwrap", "re", "json",
}
BLOCKED_NAMES = {
    "open", "exec", "eval", "compile", "input", "breakpoint", "help", "exit", "quit",
    "getattr", "setattr", "delattr", "globals", "locals", "vars", "dir", "memoryview", "type",
}
BLOCKED_ATTRS = {
    # file / network / process access through library methods
    "to_csv", "to_excel", "to_json", "to_pickle", "to_parquet", "to_sql", "to_hdf", "to_feather",
    "to_html", "to_clipboard", "to_latex", "to_markdown", "to_stata", "to_xml", "to_orc",
    "write_html", "write_image", "write_json", "savefig", "save", "show", "output_file",
    "output_notebook", "export_png", "export_svg", "imsave", "imread", "load", "loadtxt",
    "fromfile", "tofile", "genfromtxt", "system", "popen", "remove", "unlink", "rmdir",
    "mkdir", "makedirs", "chdir", "walk", "listdir", "scandir", "io", "os", "sys",
    "subprocess", "socket", "urlopen", "request", "use",
}
SAFE_BUILTINS = {
    n: getattr(builtins, n) for n in (
        "abs", "all", "any", "bool", "dict", "enumerate", "filter", "float", "format",
        "frozenset", "int", "isinstance", "issubclass", "iter", "len", "list", "map", "max",
        "min", "next", "pow", "print", "range", "repr", "reversed", "round", "set", "slice",
        "sorted", "str", "sum", "tuple", "zip", "hasattr", "callable", "divmod",
        "Exception", "ValueError", "KeyError", "TypeError", "IndexError", "ZeroDivisionError",
        "AttributeError", "RuntimeError", "StopIteration",
    )
}


def check_code(code: str) -> list:
    """Return a list of problems; empty means the code passed the screen."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"syntax error: {e}"]
    problems = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.ImportFrom) and node.level:
                problems.append("relative imports are not allowed")
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            for n in names:
                if n.split(".")[0] not in ALLOWED_IMPORTS:
                    problems.append(f"import of '{n}' is not allowed")
        elif isinstance(node, ast.Name) and (node.id in BLOCKED_NAMES or node.id.startswith("_")):
            problems.append(f"use of '{node.id}' is not allowed")
        elif isinstance(node, ast.Attribute) and (node.attr.startswith("_") or node.attr in BLOCKED_ATTRS
                                                  or node.attr.startswith("read_")):
            problems.append(f"attribute '.{node.attr}' is not allowed")
        elif isinstance(node, (ast.Global, ast.Nonlocal, ast.AsyncFunctionDef, ast.Await,
                               ast.ClassDef, ast.With, ast.AsyncWith)):
            problems.append(f"{type(node).__name__} statements are not allowed")
    return sorted(set(problems))


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0 or name.split(".")[0] not in ALLOWED_IMPORTS:
        raise ImportError(f"import of '{name}' is not allowed")
    return builtins.__import__(name, globals, locals, fromlist, level)


# ── Theme registration for every supported library ───────────────────────────

def _register_themes(cs):
    import plotly.graph_objects as go
    import plotly.io as pio
    pio.templates["uaa"] = go.layout.Template(layout=go.Layout(
        font={"family": "Segoe UI, Calibri, Arial, sans-serif", "size": 13, "color": cs.INK},
        paper_bgcolor=cs.CANVAS, plot_bgcolor=cs.CANVAS, colorway=cs.SERIES,
        xaxis={"gridcolor": cs.GRID, "linecolor": cs.GRID, "zeroline": False,
               "title": {"font": {"color": cs.MUTED}}},
        yaxis={"gridcolor": cs.GRID, "linecolor": "rgba(0,0,0,0)", "zeroline": False,
               "title": {"font": {"color": cs.MUTED}}},
        legend={"bgcolor": "rgba(0,0,0,0)", "font": {"color": cs.INK}},
        hoverlabel={"bgcolor": cs.CANVAS, "bordercolor": cs.GRID, "font": {"color": cs.INK}},
        margin={"l": 70, "r": 30, "t": 100, "b": 90},
        bargap=0.35,
    ))
    pio.templates.default = "uaa"

    import altair as alt

    def _alt_theme():
        return {"config": {
            "background": cs.CANVAS, "font": "Segoe UI",
            "view": {"stroke": "transparent"},
            "range": {"category": cs.SERIES},
            "axis": {"gridColor": cs.GRID, "domainColor": cs.GRID, "tickColor": cs.GRID,
                     "labelColor": cs.MUTED, "titleColor": cs.MUTED, "labelFontSize": 12},
            "legend": {"labelColor": cs.INK, "titleColor": cs.MUTED},
            "title": {"anchor": "start", "color": cs.INK, "fontSize": 18, "subtitleColor": cs.MUTED},
        }}
    alt.themes.register("uaa", _alt_theme)
    alt.themes.enable("uaa")
    cs.apply_theme()   # matplotlib / seaborn


def _bokeh_theme(cs):
    from bokeh.themes import Theme
    return Theme(json={"attrs": {
        "figure": {"background_fill_color": cs.CANVAS, "border_fill_color": cs.CANVAS, "outline_line_color": None},
        "Axis": {"axis_line_color": cs.GRID, "major_tick_line_color": None, "minor_tick_line_color": None,
                 "major_label_text_color": cs.MUTED, "axis_label_text_color": cs.MUTED,
                 "major_label_text_font": "Segoe UI", "axis_label_text_font": "Segoe UI"},
        "Grid": {"grid_line_color": cs.GRID},
        "Title": {"text_color": cs.INK, "text_font": "Segoe UI", "text_font_size": "18px"},
        "Legend": {"background_fill_alpha": 0, "border_line_color": None, "label_text_color": cs.INK},
    }})


# ── Phase 1: run generated code ───────────────────────────────────────────────

def _kind_of(fig) -> str:
    mod = type(fig).__module__
    for lib in ("plotly", "altair", "bokeh", "matplotlib"):
        if mod.startswith(lib):
            return lib
    return ""


def _run_one(job, df, cs, modules) -> dict:
    problems = check_code(job["code"])
    if problems:
        return {"ok": False, "error": "blocked: " + "; ".join(problems)}
    import matplotlib.pyplot as plt
    plt.close("all")
    env = {"__builtins__": {**SAFE_BUILTINS, "__import__": _guarded_import},
           "df": df.copy(), "THEME": dict(cs.THEME), **modules}
    try:
        exec(compile(job["code"], f"<chart {job['id']}>", "exec"), env)   # noqa: S102 – screened above
    except Exception as e:
        return {"ok": False, "error": traceback.format_exception_only(type(e), e)[-1].strip()[:400]}
    fig = env.get("fig")
    if fig is None and plt.get_fignums():
        fig = plt.gcf()
    if fig is not None and _kind_of(fig) == "matplotlib" and not hasattr(fig, "savefig"):
        fig = fig.figure                                     # an Axes was assigned
    lib = _kind_of(fig) if fig is not None else ""
    if not lib:
        return {"ok": False, "error": "code did not assign a plotly/altair/bokeh/matplotlib chart to `fig`"}
    summary = env.get("summary")
    try:
        import pandas as pd
        if isinstance(summary, pd.Series):
            summary = summary.reset_index()
        if isinstance(summary, pd.DataFrame):
            summary = json.loads(summary.head(15).to_json(orient="records", default_handler=str))
        elif not isinstance(summary, (list, dict)):
            summary = []
    except Exception:
        summary = []
    return {"ok": True, "fig": fig, "library": lib, "summary": summary}


# ── Phase 2: titles + export ──────────────────────────────────────────────────

def _export(res, title, subtitle, source, base, cs) -> dict:
    fig, lib, out = res["fig"], res["library"], {"png": "", "html": ""}
    if lib == "plotly":
        fig.update_layout(template="uaa", title={
            "text": f"<b>{title}</b><br><span style='font-size:13px;color:{cs.MUTED}'>{subtitle}</span>",
            "x": 0.01, "xanchor": "left", "y": 0.95, "font": {"size": 19}})
        fig.add_annotation(text=source, xref="paper", yref="paper", x=0, y=0, yshift=-62, showarrow=False,
                           font={"size": 10, "color": cs.FAINT}, xanchor="left", yanchor="top")
        fig.write_html(base + ".html", include_plotlyjs="cdn", full_html=True,
                       config={"displaylogo": False, "responsive": True})
        out["html"] = base + ".html"
        try:
            fig.write_image(base + ".png", width=1100, height=620, scale=1.5)
            out["png"] = base + ".png"
        except Exception as e:
            out["png_error"] = str(e)[:200]
    elif lib == "altair":
        import altair as alt
        fig = fig.properties(title=alt.TitleParams(text=title, subtitle=[subtitle, source], anchor="start"))
        fig.save(base + ".html")
        out["html"] = base + ".html"
    elif lib == "bokeh":
        from bokeh.embed import file_html
        from bokeh.models import Title
        from bokeh.resources import CDN
        try:
            fig.title.text = title
            fig.add_layout(Title(text=subtitle, text_color=cs.MUTED, text_font_size="13px"), "above")
            fig.add_layout(Title(text=source, text_color=cs.FAINT, text_font_size="10px"), "below")
        except Exception:
            pass                                             # layouts without a single title
        with open(base + ".html", "w", encoding="utf-8") as fh:
            fh.write(file_html(fig, CDN, title, theme=_bokeh_theme(cs)))
        out["html"] = base + ".html"
    else:                                                    # matplotlib / seaborn
        fig.set_size_inches(cs.FIG_W, cs.FIG_H)
        for t in list(fig.texts):
            t.remove()
        fig.suptitle("")
        for ax in fig.axes:
            ax.set_title("")
        fig.subplots_adjust(top=0.80, bottom=0.15)
        cs.frame(fig, title, subtitle, source)
        fig.savefig(base + ".png", dpi=cs.DPI)
        out["png"] = base + ".png"
    return out


def main(project_root: str) -> None:
    sys.path.insert(0, project_root)
    import pickle
    import warnings

    warnings.filterwarnings("ignore")
    import matplotlib
    matplotlib.use("Agg")
    from tools import chart_style as cs
    _register_themes(cs)

    import altair as alt
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import plotly.express as px
    import plotly.graph_objects as go
    import seaborn as sns
    from bokeh import plotting as bk
    modules = {"pd": pd, "np": np, "px": px, "go": go, "alt": alt, "plt": plt, "sns": sns, "bk": bk}

    req = json.loads(sys.stdin.readline())
    with open(req["data"], "rb") as fh:
        df = pickle.load(fh)                                # written by the parent, trusted
    alt.data_transformers.disable_max_rows()

    # Run job batches (the first one, then any repaired code) until titles arrive.
    results = {}
    while "jobs" in req:
        batch = {job["id"]: _run_one(job, df, cs, modules) for job in req["jobs"]}
        results.update(batch)
        print(json.dumps({"phase": "ran", "results": [
            {"id": i, "ok": r["ok"], "error": r.get("error", ""), "library": r.get("library", ""),
             "summary": r.get("summary", [])} for i, r in batch.items()]}, default=str), flush=True)
        req = json.loads(sys.stdin.readline())

    req2 = req
    exported = []
    for i, r in results.items():
        if not r["ok"]:
            continue
        t = req2["titles"].get(i, {})
        base = os.path.join(req2["out_dir"], f"{req2['stem']}_{i}")
        try:
            exported.append({"id": i, **_export(r, t.get("title", ""), t.get("subtitle", ""),
                                                req2["source"], base, cs)})
        except Exception as e:
            exported.append({"id": i, "png": "", "html": "", "error": str(e)[:300]})
    print(json.dumps({"phase": "exported", "results": exported}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
