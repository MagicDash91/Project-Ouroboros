"""
tools/py_kernel.py – persistent, sandboxed Python kernel for "chat with your data".

One process per chat session (started by features/data_chat.py with a scrubbed
environment, `python -I`, and a watchdog). Variables persist between questions like a
notebook, but every code cell passes the same screen as the chart sandbox
(tools/chart_runner.py): allow-listed imports, no file/OS/network/eval/dunder access,
restricted builtins. Datasets are loaded by this trusted loader, so the AI's code never
needs file access; charts are exported to paths chosen here. Personal-data columns are
pseudonymised on load (tools/llm_guard.py), before any AI-written code can see them.

Protocol (JSON lines over stdin/stdout):
  {"op": "init", "datasets": [{"name", "path", "format"}], "out_dir": str, "pii_key": hex, "results_dir": str}
      → {"ok": true, "datasets": [{"name", "rows", "columns": [[name, dtype], …], "masked": {col: kind}}]}
  {"op": "add", "name": str, "path": str, "format": str}     → same shape, one dataset
  {"op": "exec", "code": str, "cell": str}
      → {"ok", "stdout", "result", "charts": [{"path", "kind"}], "table_ref", "error"}

A table result is also written in full (up to MAX_RESULT_ROWS) to results_dir/<cell>.parquet (the
session's private folder) for exports, and a plotly chart's spec to <cell>.json for PNG export. Both are
written by this trusted loop, never by the AI's code.
"""

import ast
import contextlib
import io
import json
import os
import re
import sys
import traceback

MAX_STDOUT = 6000
PREVIEW_ROWS = 20
MAX_RESULT_ROWS = 200_000


def _ident(s: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z_]", "_", str(s)).strip("_").lower() or "data"
    return f"t_{s}" if s[0].isdigit() else s


def _load(path: str, fmt: str) -> dict:
    """Trusted loader. Returns {name_suffix: DataFrame} (multi-sheet Excel → several frames)."""
    import pandas as pd
    fmt = fmt.lower()
    if fmt in ("csv", "txt"):
        return {"": pd.read_csv(path, sep=None, engine="python")}          # sniff the delimiter
    if fmt == "tsv":
        return {"": pd.read_csv(path, sep="\t")}
    if fmt in ("xlsx", "xlsm", "xls"):
        sheets = pd.read_excel(path, sheet_name=None)
        if len(sheets) == 1:
            return {"": next(iter(sheets.values()))}
        return {f"_{_ident(k)}": v for k, v in sheets.items()}
    if fmt == "parquet":
        return {"": pd.read_parquet(path)}
    if fmt == "feather":
        return {"": pd.read_feather(path)}
    if fmt in ("json", "jsonl", "ndjson"):
        try:
            return {"": pd.read_json(path, lines=fmt != "json")}
        except ValueError:
            return {"": pd.read_json(path, lines=True)}
    raise ValueError(f"Unsupported format: {fmt}")


def _summary(name: str, df, masked: dict) -> dict:
    return {"name": name, "rows": int(len(df)),
            "columns": [[str(c), str(t)] for c, t in df.dtypes.items()][:200], "masked": masked}


def _preview(value):
    """JSON-safe preview of the last expression's value."""
    import pandas as pd
    if isinstance(value, pd.Series):
        value = value.to_frame()
    if isinstance(value, pd.DataFrame):
        head = value.head(PREVIEW_ROWS)
        if not isinstance(head.index, pd.RangeIndex):
            head = head.reset_index()
        return {"type": "table", "shape": list(value.shape), "columns": [str(c) for c in head.columns],
                "rows": json.loads(head.to_json(orient="values", date_format="iso", default_handler=str))}
    return {"type": "text", "text": repr(value)[:MAX_STDOUT]}


def main(project_root: str) -> None:
    sys.path.insert(0, project_root)
    import warnings
    warnings.filterwarnings("ignore")
    import matplotlib
    matplotlib.use("Agg")

    from tools import chart_style as cs
    from tools.llm_guard import pseudonymize_frame
    from tools.chart_runner import SAFE_BUILTINS, _export, _guarded_import, _kind_of, _register_themes, check_code
    _register_themes(cs)

    import altair as alt
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import plotly.express as px
    import plotly.graph_objects as go
    import seaborn as sns
    from bokeh import plotting as bk
    alt.data_transformers.disable_max_rows()

    ns = {"__builtins__": {**SAFE_BUILTINS, "__import__": _guarded_import},
          "pd": pd, "np": np, "px": px, "go": go, "alt": alt, "plt": plt, "sns": sns, "bk": bk,
          "THEME": dict(cs.THEME)}
    out_dir = "."
    results_dir = ""
    pii_key = b""

    def reply(obj):
        print(json.dumps(obj, default=str), flush=True)

    for line in sys.stdin:
        try:
            req = json.loads(line)
        except Exception:
            continue
        op = req.get("op")
        try:
            if op in ("init", "add"):
                if op == "init":
                    out_dir = req["out_dir"]
                    pii_key = bytes.fromhex(req.get("pii_key", ""))
                    results_dir = req.get("results_dir") or ""
                    if results_dir:
                        os.makedirs(results_dir, exist_ok=True)
                items = req.get("datasets", []) if op == "init" else [req]
                loaded = []
                for d in items:
                    for suffix, df in _load(d["path"], d["format"]).items():
                        masked = {}
                        if pii_key:
                            df, masked = pseudonymize_frame(df, pii_key)
                        ns[d["name"] + suffix] = df
                        loaded.append(_summary(d["name"] + suffix, df, masked))
                reply({"ok": True, "datasets": loaded})

            elif op == "exec":
                code = req.get("code", "")
                problems = check_code(code)
                if problems:
                    reply({"ok": False, "error": "blocked: " + "; ".join(problems)})
                    continue
                plt.close("all")
                ns["fig"] = None
                tree = ast.parse(code)
                tail = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
                buf = io.StringIO()
                result = None
                with contextlib.redirect_stdout(buf):
                    exec(compile(tree, "<cell>", "exec"), ns)                                # noqa: S102 – screened
                    if tail is not None:
                        result = eval(compile(ast.Expression(tail.value), "<cell>", "eval"), ns)  # noqa: S307
                stdout = buf.getvalue()

                fig = ns.get("fig")
                if fig is None and result is not None and _kind_of(result):
                    fig, result = result, None                       # a chart was the last expression
                if fig is None and plt.get_fignums():
                    fig = plt.gcf()
                if fig is not None and _kind_of(fig) == "matplotlib" and not hasattr(fig, "savefig"):
                    fig = fig.figure                                  # an Axes was produced
                charts = []
                lib = _kind_of(fig) if fig is not None else ""
                if lib:
                    base = os.path.join(out_dir, req.get("cell", "cell"))
                    if lib == "plotly":
                        # Chat charts: interactive HTML only (PNG export via Kaleido is slow).
                        fig.update_layout(template="uaa")
                        fig.write_html(base + ".html", include_plotlyjs="cdn", full_html=True,
                                       config={"displaylogo": False, "responsive": True})
                        charts.append({"path": base + ".html", "kind": "html"})
                        try:
                            fig.write_json(base + ".json")                 # for PNG export / reports
                        except Exception:
                            pass
                    else:
                        exp = _export({"fig": fig, "library": lib}, "", "", "", base, cs)
                        if exp.get("html"):
                            charts.append({"path": exp["html"], "kind": "html"})
                        elif exp.get("png"):
                            charts.append({"path": exp["png"], "kind": "png"})
                    ns["fig"] = None

                table_ref = None
                if results_dir and isinstance(result, (pd.DataFrame, pd.Series)):
                    try:
                        full = result.to_frame() if isinstance(result, pd.Series) else result
                        if not isinstance(full.index, pd.RangeIndex):
                            full = full.reset_index()
                        full = full.head(MAX_RESULT_ROWS).copy()
                        full.columns = [str(c) for c in full.columns]
                        path = os.path.join(results_dir, re.sub(r"[^A-Za-z0-9_]", "_", req.get("cell", "cell")) + ".parquet")
                        try:
                            full.to_parquet(path, index=False)
                        except Exception:
                            full.astype(str).to_parquet(path, index=False)
                        table_ref = os.path.basename(path)[:-8]
                    except Exception:
                        table_ref = None
                reply({"ok": True, "stdout": stdout[-MAX_STDOUT:],
                       "result": _preview(result) if result is not None else None, "charts": charts,
                       "table_ref": table_ref})
            else:
                reply({"ok": False, "error": f"unknown op {op!r}"})
        except Exception as e:
            reply({"ok": False, "error": traceback.format_exception_only(type(e), e)[-1].strip()[:800]})


if __name__ == "__main__":
    main(sys.argv[1])
