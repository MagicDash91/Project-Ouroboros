"""features/deeper.py — Feature 3: deeper, beyond-descriptive analysis.

Three capabilities:
  1. driver_analysis — SHAP-based ranking of what drives a trained model's
     predictions (falls back to feature_importances_/coef_ when SHAP can't run).
  2. what_if        — scenario simulation: change inputs, see how a trained
     model's predicted probability moves.
  3. nl_explore     — natural-language → read-only SQL data explorer, answered
     with a Claude summary.
"""
import os
import re
from typing import Optional

import numpy as np
import pandas as pd
from sqlalchemy import create_engine, inspect as sa_inspect

from features.scoring import load_artifact, score_dataframe, _transform


def _resolve_db_uri(db_uri: str = "") -> str:
    if db_uri:
        # Any provider's format (postgres://, JDBC, Azure "Server=…;", …) → SQLAlchemy URI.
        from features.db_connect import normalize_db_uri
        return normalize_db_uri(db_uri)
    from config import POSTGRES_URI
    return os.environ.get("ACTIVE_DB_URI") or POSTGRES_URI


def _engine(uri: str):
    # Shared pool per database — per-call engines leaked connections and exhausted
    # Supabase's 15-client session pooler.
    from features.db_connect import cached_engine
    return cached_engine(uri)


# ── 1. Driver / causal analysis ───────────────────────────────────────────────

def driver_analysis(model_ref: str, df: Optional[pd.DataFrame] = None, top_n: int = 15) -> dict:
    """Rank the features that most drive a trained model's predictions."""
    art   = load_artifact(model_ref)
    model = art["model"]
    feats = list(art["features"])

    importances = None
    directions  = None
    method      = ""

    # Preferred: SHAP over a real data sample.
    if df is not None and len(df) > 0:
        try:
            import shap
            Xs = _transform(df.head(2000), art)          # scaled feature matrix
            explainer = shap.TreeExplainer(model)
            sv = explainer.shap_values(Xs)
            if isinstance(sv, list):                      # [class0, class1]
                sv = sv[1] if len(sv) > 1 else sv[0]
            sv = np.array(sv)
            if sv.ndim == 3:                              # (n, features, classes)
                sv = sv[..., -1]
            importances = np.abs(sv).mean(axis=0)
            directions  = np.sign(sv.mean(axis=0))
            method      = "shap"
        except Exception:
            importances = None

    # Fallbacks: model-native importances.
    if importances is None:
        if hasattr(model, "feature_importances_"):
            importances = np.asarray(model.feature_importances_)
            directions  = np.zeros(len(feats))
            method      = "feature_importance"
        elif hasattr(model, "coef_"):
            coef        = np.asarray(model.coef_).ravel()
            importances = np.abs(coef)
            directions  = np.sign(coef)
            method      = "coefficient"
        else:
            raise ValueError("Model exposes neither SHAP-compatible structure nor importances.")

    order = np.argsort(importances)[::-1][:top_n]
    drivers = []
    for i in order:
        d = directions[i] if directions is not None else 0
        drivers.append({
            "feature":    feats[i],
            "importance": round(float(importances[i]), 4),
            "direction":  "increases" if d > 0 else ("decreases" if d < 0 else "n/a"),
        })

    narrative = _narrate_drivers(art, drivers, method)
    return {"model_type": art.get("model_type", model_ref), "method": method,
            "drivers": drivers, "narrative": narrative}


def plot_drivers(drivers: list, model_type: str, out_path: str, method: str = "shap") -> str:
    """Render a clean, dark-themed horizontal bar chart of model drivers.

    Bars are coloured by direction (red = increases the predicted likelihood,
    green = decreases it, blue = magnitude only) with value labels — a tidy,
    report-ready feature-importance / SHAP visual.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Patch

    drivers = drivers[:12][::-1]   # top 12, smallest at bottom for readability
    names = [d["feature"] for d in drivers]
    vals  = [d["importance"] for d in drivers]
    dirs  = [d.get("direction", "n/a") for d in drivers]
    cmap  = {"increases": "#ef4444", "decreases": "#22c55e", "n/a": "#3b82f6"}
    colors = [cmap.get(d, "#3b82f6") for d in dirs]

    plt.style.use("dark_background")
    fig, ax = plt.subplots(figsize=(11, max(4, 0.55 * len(names) + 1)))
    fig.patch.set_facecolor("#0d1117")
    ax.set_facecolor("#161b22")

    bars = ax.barh(names, vals, color=colors, edgecolor="#0d1117", height=0.66)
    vmax = max(vals) if vals else 1
    for bar, v in zip(bars, vals):
        ax.text(bar.get_width() + vmax * 0.01, bar.get_y() + bar.get_height() / 2,
                f"{v:.3f}", va="center", ha="left", color="#e6edf3", fontsize=9)

    label = {"shap": "Mean |SHAP value|",
             "feature_importance": "Feature importance",
             "coefficient": "|Coefficient|"}.get(method, "Importance")
    ax.set_xlabel(label, color="#e6edf3", fontsize=11)
    pretty = model_type.replace("_", " ").title()
    ax.set_title(f"Key Drivers — {pretty}  ({method.upper()})",
                 color="#e6edf3", fontsize=14, fontweight="bold", pad=14)
    ax.tick_params(colors="#8b949e")
    for s in ax.spines.values():
        s.set_color("#30363d")
    ax.margins(x=0.12)

    if any(d in ("increases", "decreases") for d in dirs):
        ax.legend(handles=[
            Patch(color="#ef4444", label="increases likelihood"),
            Patch(color="#22c55e", label="decreases likelihood"),
        ], loc="lower right", facecolor="#161b22", edgecolor="#30363d", labelcolor="#e6edf3", fontsize=9)

    plt.tight_layout()
    plt.savefig(out_path, dpi=140, bbox_inches="tight", facecolor="#0d1117")
    plt.close()
    return out_path


def driver_analysis_with_chart(model_ref: str, df: Optional[pd.DataFrame],
                               charts_dir: str, top_n: int = 12) -> dict:
    """Run driver analysis and render the tidy chart. Returns the analysis plus
    `chart_path`/`chart_url` (relative to /outputs)."""
    import os
    from datetime import datetime

    res = driver_analysis(model_ref, df, top_n=top_n)
    os.makedirs(charts_dir, exist_ok=True)
    fname = f"key_drivers_{res['model_type']}_{datetime.now():%Y%m%d_%H%M%S}.png"
    path  = os.path.join(charts_dir, fname)
    plot_drivers(res["drivers"], res["model_type"], path, method=res["method"])
    res["chart_path"] = path
    res["chart_url"]  = "/outputs/charts/" + fname
    return res


def _narrate_drivers(art: dict, drivers: list, method: str) -> str:
    try:
        from config import query_cerebras
        target = art.get("target") or art.get("model_type", "the outcome")
        rows = "\n".join(
            f"- {d['feature']}: importance {d['importance']} "
            f"({d['direction']} the predicted likelihood)" for d in drivers
        )
        return query_cerebras([
            {"role": "system", "content": (
                "You are a data scientist explaining a model to business "
                "stakeholders. Given a ranked list of the model's most important "
                "drivers, explain in 4-6 sentences what most influences "
                f"'{target}', what the top 3 drivers mean in practice, and one "
                "concrete intervention the business could test. Do not invent "
                "features that are not listed."
            )},
            {"role": "user", "content": f"Driver-importance method: {method}\n\nDrivers:\n{rows}"},
        ], max_tokens=700)
    except Exception as exc:
        return f"(Driver narrative unavailable: {exc})"


# ── 2. What-if simulation ─────────────────────────────────────────────────────

def what_if(model_ref: str, overrides: dict,
            df: Optional[pd.DataFrame] = None, base_row: Optional[dict] = None) -> dict:
    """Compare a model's prediction for a baseline row vs. an overridden scenario."""
    art   = load_artifact(model_ref)
    feats = list(art["features"])

    if base_row:
        base = dict(base_row)
    elif df is not None and len(df) > 0:
        base = {}
        for c in df.columns:
            if pd.api.types.is_numeric_dtype(df[c]):
                base[c] = float(df[c].mean())
            else:
                mode = df[c].mode()
                base[c] = (mode.iloc[0] if not mode.empty else "")
    else:
        base = {f: 0 for f in feats}

    scenario = dict(base)
    scenario.update(overrides or {})

    b = score_dataframe(pd.DataFrame([base]), art)
    s = score_dataframe(pd.DataFrame([scenario]), art)

    def _prob(x):
        return round(float(x["probability"].iloc[0]), 4) if "probability" in x.columns else None

    result = {
        "model_type":            art.get("model_type", model_ref),
        "overrides":             overrides,
        "baseline_prediction":   int(b["prediction"].iloc[0]),
        "scenario_prediction":   int(s["prediction"].iloc[0]),
        "baseline_probability":  _prob(b),
        "scenario_probability":  _prob(s),
    }
    if result["baseline_probability"] is not None and result["scenario_probability"] is not None:
        result["probability_delta"] = round(
            result["scenario_probability"] - result["baseline_probability"], 4)

    result["narrative"] = _narrate_whatif(art, result)
    return result


def _narrate_whatif(art: dict, result: dict) -> str:
    try:
        from config import query_cerebras
        return query_cerebras([
            {"role": "system", "content": (
                "You are a decision-support analyst. Given a baseline prediction "
                "and a what-if scenario from a model, explain in 2-4 sentences how "
                "the change moved the predicted probability and what it implies. "
                "Be concrete and cite the numbers."
            )},
            {"role": "user", "content": str(result)},
        ], max_tokens=500)
    except Exception as exc:
        return f"(What-if narrative unavailable: {exc})"


# ── 3. Natural-language data explorer (read-only) ─────────────────────────────

_SQL_BANNED = ("insert", "update", "delete", "drop", "alter", "create",
               "truncate", "grant", "revoke", "merge", "--", "/*", "attach",
               "pragma", "vacuum")


def _is_safe_select(sql: str) -> bool:
    s = sql.strip().rstrip(";").lower()
    if not (s.startswith("select") or s.startswith("with")):
        return False
    if ";" in s:                      # no multiple statements
        return False
    return not any(tok in s for tok in _SQL_BANNED)


def _schema_text(engine, only_table: Optional[str] = None) -> str:
    insp = sa_inspect(engine)
    tables = [only_table] if only_table else insp.get_table_names()
    lines = []
    for t in tables[:20]:
        try:
            cols = [f"{c['name']} {str(c['type'])}" for c in insp.get_columns(t)]
            lines.append(f"TABLE {t} (" + ", ".join(cols) + ")")
        except Exception:
            continue
    return "\n".join(lines)


def nl_explore(question: str, db_uri: str = "", table: Optional[str] = None,
               max_rows: int = 200) -> dict:
    """Translate a natural-language question into a read-only SELECT, run it,
    and summarise the result with Claude."""
    from config import query_cerebras

    uri    = _resolve_db_uri(db_uri)
    engine = _engine(uri)
    dialect = "SQLite" if uri.startswith("sqlite") else "PostgreSQL"
    schema = _schema_text(engine, table)
    if not schema:
        raise ValueError("No tables found in the target database.")

    sql_raw = query_cerebras([
        {"role": "system", "content": (
            f"You are a {dialect} expert. Convert the user's question into ONE "
            "read-only SQL SELECT query. Rules:\n"
            "- Output ONLY the SQL, no markdown, no explanation.\n"
            "- SELECT (or WITH ... SELECT) only — never modify data.\n"
            "- Use only the tables/columns in the schema below.\n"
            + ("- Wrap every table and column name in double quotes exactly as written "
               "in the schema (PostgreSQL folds unquoted names to lowercase).\n"
               if dialect == "PostgreSQL" else "")
            + f"- Always include a LIMIT of at most {max_rows}.\n\n"
            f"Schema:\n{schema}"
        )},
        {"role": "user", "content": question},
    ], max_tokens=400)

    # Strip code fences / stray prose.
    sql = re.sub(r"```(?:sql)?", "", sql_raw, flags=re.IGNORECASE).strip().rstrip(";")
    m = re.search(r"(?is)\b(with|select)\b.*", sql)
    if m:
        sql = m.group(0).strip()

    if not _is_safe_select(sql):
        raise ValueError(f"Generated query rejected (not a safe read-only SELECT): {sql}")

    if "limit" not in sql.lower():
        sql = f"{sql} LIMIT {max_rows}"

    df = pd.read_sql(sql, engine)
    rows = df.head(max_rows).where(pd.notnull(df.head(max_rows)), None).to_dict(orient="records")

    try:
        summary = query_cerebras([
            {"role": "system", "content": (
                "You are a data analyst. Answer the user's question in 2-4 sentences "
                "using ONLY the query result rows provided. Cite specific numbers. Never assume a "
                "currency: name one only if the column names or question indicate it (e.g. *_idr → Rp/IDR)."
            )},
            {"role": "user", "content": (
                f"Question: {question}\n\nSQL: {sql}\n\n"
                f"Result (up to 50 rows shown):\n{df.head(50).to_string(index=False)}"
            )},
        ], max_tokens=600)
    except Exception as exc:
        summary = f"(Summary unavailable: {exc})"

    return {"question": question, "sql": sql, "row_count": int(len(df)),
            "rows": rows, "summary": summary}
