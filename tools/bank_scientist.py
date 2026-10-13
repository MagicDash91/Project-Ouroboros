"""
tools/bank_scientist.py – Banking ML model training tools.
Mirrors Bank_Agent/tools/scientist_tools.py with paths adjusted to this system.
"""

import os
import sys
import json
import warnings
import joblib
import numpy as np
import pandas as pd
from datetime import datetime

warnings.filterwarnings("ignore")

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns
sns.set_theme(style="whitegrid", palette="husl")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crewai.tools import tool
from features.db_connect import cached_engine as create_engine   # one shared pool per database
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.cluster import KMeans
from sklearn.metrics import accuracy_score, roc_auc_score, classification_report

from config import POSTGRES_URI, query_ollama as query_nvidia


def _get_db_uri() -> str:
    """Return the active database URI (set per-run via ACTIVE_DB_URI env var)."""
    return os.environ.get("ACTIVE_DB_URI") or POSTGRES_URI

_BASE_DIR   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODELS_DIR = os.path.join(_BASE_DIR, "outputs", "models")
_CHARTS_DIR = os.path.join(_BASE_DIR, "outputs", "charts")
os.makedirs(_MODELS_DIR, exist_ok=True)
os.makedirs(_CHARTS_DIR, exist_ok=True)


def _save_model(artifact: dict, name: str) -> str:
    path = os.path.join(_MODELS_DIR, f"{name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.joblib")
    joblib.dump(artifact, path)
    return path


def _plot_feature_importance(feature_names, importances, model_name, top_n=10) -> str:
    pairs  = sorted(zip(feature_names, importances), key=lambda x: x[1], reverse=True)[:top_n]
    names  = [p[0] for p in reversed(pairs)]
    values = [p[1] for p in reversed(pairs)]

    fig, ax = plt.subplots(figsize=(10, 6))
    bars = ax.barh(names, values, color=sns.color_palette("husl", len(names)), edgecolor="white", height=0.6)
    for bar, val in zip(bars, values):
        ax.text(bar.get_width() + max(values) * 0.01, bar.get_y() + bar.get_height() / 2,
                f"{val:.4f}", va="center", ha="left", fontsize=9)
    ax.set_xlabel("Feature Importance", fontsize=12)
    ax.set_title(f"Top {top_n} Feature Importances — {model_name}", fontsize=14, fontweight="bold", pad=15)
    plt.tight_layout()

    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(_CHARTS_DIR, f"feature_importance_{model_name.lower().replace(' ', '_')}_{ts}.png")
    plt.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close()
    return path


def _find_target(df: pd.DataFrame, hints: list[str]) -> str:
    """Find a target column by case-insensitive hint matching."""
    col_map = {c.lower(): c for c in df.columns}
    for h in hints:
        if h.lower() in col_map:
            return col_map[h.lower()]
    raise ValueError(f"Target column not found. Tried {hints}. Available: {list(df.columns)}")


def _preprocess(df: pd.DataFrame, target_col: str):
    """Preprocess for training. Returns (X, y, encoders) where ``encoders`` maps
    each label-encoded feature column to its fitted LabelEncoder, so the same
    transform can be replayed at scoring time."""
    df = df.copy()
    id_cols = [c for c in df.columns if c.lower() in ("customerid", "id", "customer_id")]
    df.drop(columns=id_cols, errors="ignore", inplace=True)
    if "TotalCharges" in df.columns:
        df["TotalCharges"] = pd.to_numeric(df["TotalCharges"], errors="coerce")

    X = df.drop(columns=[target_col]).copy()
    y = df[target_col].copy()

    if y.dtype == object or str(y.dtype) == "category":
        le_y = LabelEncoder()
        y = pd.Series(le_y.fit_transform(y.astype(str)), index=y.index, name=target_col)

    encoders: dict = {}
    for col in X.select_dtypes(include="object").columns:
        le = LabelEncoder()
        X[col] = le.fit_transform(X[col].astype(str))
        encoders[col] = le

    X = X.select_dtypes(include=np.number).fillna(X.mean(numeric_only=True))
    return X, y, encoders


@tool("Train Fraud Detection Model")
def train_fraud_detection_model(table_name: str) -> str:
    """
    Train Random Forest + Gradient Boosting fraud detection models.
    Automatically detects the fraud label column (is_fraud, fraud, fraudulent, target).

    Args:
        table_name: Database table containing transaction records.

    Returns:
        JSON with per-model metrics, best model path, and analysis.
    """
    try:
        engine = create_engine(_get_db_uri())
        df = pd.read_sql(f"SELECT * FROM {table_name} LIMIT 10000", engine)

        try:
            target_column = _find_target(df, ["is_fraud", "fraud", "fraudulent", "label", "target"])
        except ValueError as e:
            return json.dumps({"status": "error", "message": str(e)})

        X, y, encoders = _preprocess(df, target_column)
        X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
        scaler = StandardScaler()
        X_tr_s = scaler.fit_transform(X_tr)
        X_te_s = scaler.transform(X_te)

        candidates = {
            "RandomForest":     RandomForestClassifier(n_estimators=100, random_state=42, class_weight="balanced"),
            "GradientBoosting": GradientBoostingClassifier(n_estimators=100, random_state=42),
        }

        results = {}
        best_name, best_model, best_auc = None, None, 0.0

        for name, clf in candidates.items():
            clf.fit(X_tr_s, y_tr)
            y_pred = clf.predict(X_te_s)
            y_prob = clf.predict_proba(X_te_s)[:, 1]
            auc = roc_auc_score(y_te, y_prob)
            results[name] = {"accuracy": round(float(accuracy_score(y_te, y_pred)), 4), "roc_auc": round(float(auc), 4)}
            if auc > best_auc:
                best_auc, best_name, best_model = auc, name, clf

        model_path  = _save_model({"model": best_model, "scaler": scaler, "features": list(X.columns),
                                    "encoders": encoders, "target": target_column,
                                    "model_type": "fraud_detection", "positive_label": "fraud"}, "fraud_detection")
        chart_path  = _plot_feature_importance(list(X.columns), best_model.feature_importances_.tolist(), "Fraud Detection")
        try:
            analysis = query_nvidia([
                {"role": "system", "content": "You are a banking fraud analytics expert."},
                {"role": "user",   "content": f"Fraud detection results:\n{json.dumps(results, indent=2)}\nProvide analysis."},
            ])
        except Exception as _nvidia_err:
            print(f"[Scientist] NVIDIA analysis skipped: {_nvidia_err}", flush=True)
            analysis = f"AI analysis unavailable (NVIDIA timeout). Best model: {best_name}, ROC-AUC: {round(best_auc, 4)}"

        return json.dumps({"status": "success", "best_model": best_name, "best_roc_auc": round(best_auc, 4),
                           "model_path": model_path, "feature_importance_chart": chart_path,
                           "all_results": results, "ai_analysis": analysis}, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Train Credit Risk Model")
def train_credit_risk_model(table_name: str) -> str:
    """
    Train a Logistic Regression credit-risk model.
    Automatically detects the default/risk label column (default, is_default, credit_risk, risk, target).

    Args:
        table_name: Database table with loan/applicant data.

    Returns:
        JSON with AUC, risk segment distribution, model path, and analysis.
    """
    try:
        engine = create_engine(_get_db_uri())
        df = pd.read_sql(f"SELECT * FROM {table_name} LIMIT 10000", engine)

        try:
            target_column = _find_target(df, ["default", "is_default", "credit_risk", "risk", "label", "target"])
        except ValueError as e:
            return json.dumps({"status": "error", "message": str(e)})

        X, y, encoders = _preprocess(df, target_column)
        X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=42)
        scaler = StandardScaler()
        clf = LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)
        clf.fit(scaler.fit_transform(X_tr), y_tr)

        y_pred = clf.predict(scaler.transform(X_te))
        y_prob = clf.predict_proba(scaler.transform(X_te))[:, 1]
        auc    = roc_auc_score(y_te, y_prob)

        credit_scores = (1 - y_prob) * 1000
        segments = pd.cut(credit_scores, bins=[0, 300, 500, 700, 1000],
                          labels=["Very High Risk", "High Risk", "Medium Risk", "Low Risk"])
        segment_dist = segments.value_counts().to_dict()

        model_path = _save_model({"model": clf, "scaler": scaler, "features": list(X.columns),
                                  "encoders": encoders, "target": target_column,
                                  "model_type": "credit_risk", "positive_label": "default"}, "credit_risk")
        chart_path = _plot_feature_importance(list(X.columns), np.abs(clf.coef_[0]).tolist(), "Credit Risk")
        try:
            analysis = query_nvidia([
                {"role": "system", "content": "You are a banking credit risk officer."},
                {"role": "user",   "content": f"Credit risk AUC: {auc:.4f}. Segments: {str(segment_dist)}. Provide Basel III analysis."},
            ])
        except Exception as _nvidia_err:
            print(f"[Scientist] NVIDIA analysis skipped: {_nvidia_err}", flush=True)
            analysis = f"AI analysis unavailable (NVIDIA timeout). ROC-AUC: {round(float(auc), 4)}"

        return json.dumps({"status": "success", "roc_auc": round(float(auc), 4),
                           "accuracy": round(float(accuracy_score(y_te, y_pred)), 4),
                           "risk_segments": {str(k): int(v) for k, v in segment_dist.items()},
                           "model_path": model_path, "feature_importance_chart": chart_path,
                           "ai_analysis": analysis}, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Train Customer Churn Model")
def train_churn_model(table_name: str) -> str:
    """
    Train a Gradient Boosting churn prediction model.
    Automatically detects the churn label column (Churn, churn, is_churn, churned, target).

    Args:
        table_name: Database table with customer records.

    Returns:
        JSON with AUC, top churn predictors, model path, and retention strategy.
    """
    try:
        engine = create_engine(_get_db_uri())
        df = pd.read_sql(f"SELECT * FROM {table_name} LIMIT 10000", engine)

        try:
            target_column = _find_target(df, ["Churn", "churn", "is_churn", "churned", "label", "target"])
        except ValueError as e:
            return json.dumps({"status": "error", "message": str(e)})

        X, y, encoders = _preprocess(df, target_column)
        X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=42)
        scaler = StandardScaler()
        clf = GradientBoostingClassifier(n_estimators=100, random_state=42)
        clf.fit(scaler.fit_transform(X_tr), y_tr)

        y_pred = clf.predict(scaler.transform(X_te))
        y_prob = clf.predict_proba(scaler.transform(X_te))[:, 1]
        auc    = roc_auc_score(y_te, y_prob)

        feature_importance = dict(zip(list(X.columns), clf.feature_importances_.tolist()))
        top_features = dict(sorted(feature_importance.items(), key=lambda x: x[1], reverse=True)[:10])

        model_path = _save_model({"model": clf, "scaler": scaler, "features": list(X.columns),
                                  "encoders": encoders, "target": target_column,
                                  "model_type": "churn_model", "positive_label": "churn"}, "churn_model")
        chart_path = _plot_feature_importance(list(X.columns), clf.feature_importances_.tolist(), "Customer Churn")
        try:
            analysis = query_nvidia([
                {"role": "system", "content": "You are a banking customer retention strategist."},
                {"role": "user",   "content": f"Churn AUC: {auc:.4f}. Top predictors: {json.dumps(top_features)}. Design a 90-day retention program."},
            ])
        except Exception as _nvidia_err:
            print(f"[Scientist] NVIDIA analysis skipped: {_nvidia_err}", flush=True)
            analysis = f"AI analysis unavailable (NVIDIA timeout). ROC-AUC: {round(float(auc), 4)}"

        return json.dumps({"status": "success", "roc_auc": round(float(auc), 4),
                           "accuracy": round(float(accuracy_score(y_te, y_pred)), 4),
                           "top_churn_predictors": {k: round(v, 4) for k, v in top_features.items()},
                           "model_path": model_path, "feature_importance_chart": chart_path,
                           "ai_analysis": analysis}, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Perform Time Series Forecasting")
def time_series_forecast(
    table_name: str,
    date_column: str,
    value_column: str,
    forecast_periods: int = 30,
    aggregation: str = "sum",
) -> str:
    """
    Forecast future values using Holt-Winters Exponential Smoothing.

    Args:
        table_name:       Database table with time-series data.
        date_column:      Column containing date/timestamp values.
        value_column:     Numeric column to forecast.
        forecast_periods: Number of future periods to predict (default 30).

    Returns:
        JSON with forecast range, trend direction, and financial interpretation.
    """
    try:
        from statsmodels.tsa.holtwinters import ExponentialSmoothing

        if not (table_name and date_column and value_column):
            return json.dumps({"status": "error", "message": "table_name, date_column, and value_column are required."})

        engine = create_engine(_get_db_uri())
        # Full history (not the first N rows), aggregated per period below — transactional
        # tables have many rows per date, so each row is NOT a time-series point.
        df = pd.read_sql(f"SELECT {date_column} AS d, {value_column} AS v FROM {table_name} LIMIT 2000000", engine)
        df["d"] = pd.to_datetime(df["d"], errors="coerce")
        df["v"] = pd.to_numeric(df["v"], errors="coerce")
        df = df.dropna()
        if df.empty:
            return json.dumps({"status": "error", "message": f"No usable {date_column}/{value_column} values."})

        span = (df["d"].max() - df["d"].min()).days
        # Respect the data's own granularity: an already-monthly table (one row per month)
        # must not be resampled weekly, which would invent empty weeks between months.
        uniq = df["d"].drop_duplicates().sort_values()
        gap = float(uniq.diff().dt.days.median()) if len(uniq) > 1 else 1.0
        if gap >= 28:
            freq, season, label = "MS", 12, "month"
        elif gap >= 7:
            freq, season, label = "W", 52, "week"
        else:
            freq, season, label = (("D", 7, "day") if span <= 180 else
                                   ("W", 52, "week") if span <= 3 * 365 else ("MS", 12, "month"))
        agg = aggregation if aggregation in ("sum", "mean", "count") else "sum"
        series = getattr(df.set_index("d")["v"].resample(freq), agg)().fillna(0)
        if len(series) < 10:
            return json.dumps({"status": "error", "message": f"Only {len(series)} {label}s of history (need ≥ 10)."})

        def _fit(s):
            seasonal = season if len(s) >= season * 2 else None
            return ExponentialSmoothing(s, trend="add", seasonal="add" if seasonal else None,
                                        seasonal_periods=seasonal).fit(optimized=True)

        # Backtest on the most recent ~20% so the forecast's accuracy is visible.
        hold = max(2, len(series) // 5)
        bt = _fit(series[:-hold]).forecast(hold)
        mape = float((abs(bt.values - series[-hold:].values) / series[-hold:].abs().clip(lower=1e-9)).mean() * 100)
        horizon = forecast_periods if forecast_periods and forecast_periods != 30 else {"D": 30, "W": 8, "MS": 6}[freq]
        forecast = _fit(series).forecast(horizon)
        last, nxt = float(series[-hold:].mean()), float(forecast.mean())
        trend_dir = "upward" if nxt > last * 1.02 else "downward" if nxt < last * 0.98 else "flat"

        try:
            analysis = query_nvidia([
                {"role": "system", "content": "You are a business analyst. Be concrete and brief (3 sentences)."},
                {"role": "user", "content": (
                    f"{agg} of '{value_column}' per {label} from table '{table_name}'. Recent {hold}-{label} average: "
                    f"{last:,.2f}. Next {horizon} {label}s forecast average: {nxt:,.2f} ({trend_dir}). Backtest MAPE: "
                    f"{mape:.1f}%. Explain what this means for the business and how much to trust it.")},
            ], max_tokens=400)
        except Exception as _err:
            analysis = f"Trend: {trend_dir}. (Narrative unavailable: {_err})"

        return json.dumps({
            "status": "success", "source": f"{table_name}.{value_column}", "aggregation": f"{agg} per {label}",
            "history_periods": len(series), "history_range": [str(series.index.min().date()), str(series.index.max().date())],
            "recent_history": {str(k.date()): round(float(v), 2) for k, v in series[-6:].items()},
            "forecast": {str(k.date()): round(float(v), 2) for k, v in forecast.items()},
            "trend": trend_dir, "backtest_mape_pct": round(mape, 1), "ai_analysis": analysis,
        }, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("Perform Customer Segmentation")
def customer_segmentation(table_name: str) -> str:
    """
    Segment customers into 4 groups using K-Means clustering on numeric features.

    Args:
        table_name: Database table with customer features.

    Returns:
        JSON with cluster sizes, mean profiles per segment, and segment descriptions.
    """
    n_clusters = 4
    try:
        engine = create_engine(_get_db_uri())
        df = pd.read_sql(f"SELECT * FROM {table_name} LIMIT 10000", engine)

        id_cols = [c for c in df.columns if c.lower() in ("customerid", "id", "customer_id")]
        df.drop(columns=id_cols, errors="ignore", inplace=True)

        if "TotalCharges" in df.columns:
            df["TotalCharges"] = pd.to_numeric(df["TotalCharges"], errors="coerce")

        for col in df.select_dtypes(include=["object", "category"]).columns:
            le = LabelEncoder()
            df[col] = le.fit_transform(df[col].astype(str))

        numeric_df = df.select_dtypes(include=np.number).fillna(0)
        if numeric_df.shape[1] < 2:
            return json.dumps({"status": "error", "message": "Need at least 2 numeric columns."})

        scaler = StandardScaler()
        X_s = scaler.fit_transform(numeric_df)

        kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
        df["segment"] = kmeans.fit_predict(X_s)

        segment_counts = df["segment"].value_counts().sort_index().to_dict()

        seg_table = f"{table_name}_segmented"
        df.to_sql(seg_table, create_engine(_get_db_uri()), if_exists="replace", index=False)

        try:
            analysis = query_nvidia([
                {"role": "system", "content": "You are a banking customer analytics expert."},
                {"role": "user",   "content": f"K-Means ({n_clusters} clusters) on '{table_name}'. Cluster sizes: {segment_counts}. Name each cluster and recommend strategy."},
            ])
        except Exception as _nvidia_err:
            print(f"[Scientist] NVIDIA analysis skipped: {_nvidia_err}", flush=True)
            analysis = f"AI analysis unavailable (NVIDIA timeout). Cluster sizes: {segment_counts}"

        return json.dumps({"status": "success", "n_clusters": n_clusters,
                           "segment_counts": {str(k): int(v) for k, v in segment_counts.items()},
                           "segmented_table": seg_table, "ai_analysis": analysis}, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})
