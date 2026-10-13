"""features/scoring.py — Feature 1: score new data against trained models.

The analytics crew trains fraud / credit-risk / churn models and saves them as
joblib artifacts in outputs/models/. This module loads those artifacts and
applies them to fresh data, so a trained model becomes an operational scoring
service instead of a one-off report.

Artifact format (written by tools/bank_scientist.py):
    {"model", "scaler", "features", "encoders", "target",
     "model_type", "positive_label"}
Older artifacts (model/scaler/features only) are still supported with a
best-effort fallback for categorical encoding.
"""
import os
import re
from datetime import datetime
from typing import Optional

import joblib
import numpy as np
import pandas as pd

_BASE_DIR   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODELS_DIR = os.path.join(_BASE_DIR, "outputs", "models")

# filenames look like  fraud_detection_20250101_120000.joblib
_TS_RE = re.compile(r"_(\d{8}_\d{6})\.joblib$")


def _model_type_from_name(filename: str) -> str:
    return _TS_RE.sub("", filename)


def list_models() -> list:
    """Return metadata for every trained model artifact, newest first."""
    if not os.path.isdir(_MODELS_DIR):
        return []
    out = []
    for fn in os.listdir(_MODELS_DIR):
        if not fn.endswith(".joblib"):
            continue
        path = os.path.join(_MODELS_DIR, fn)
        meta = {
            "filename":   fn,
            "model_type": _model_type_from_name(fn),
            "created":    datetime.fromtimestamp(os.path.getmtime(path)).isoformat(),
            "size_bytes": os.path.getsize(path),
        }
        try:
            art = joblib.load(path)
            meta["features"]   = list(art.get("features", []))
            meta["target"]     = art.get("target")
            meta["algorithm"]  = type(art.get("model")).__name__
            meta["n_features"] = len(art.get("features", []))
        except Exception as exc:
            meta["error"] = f"could not load: {exc}"
        out.append(meta)
    out.sort(key=lambda m: m["created"], reverse=True)
    return out


def load_artifact(model_ref: str) -> dict:
    """Load an artifact by exact filename or by model_type (latest of that type)."""
    if not os.path.isdir(_MODELS_DIR):
        raise FileNotFoundError("No models directory — train a model first.")

    # Exact filename?
    direct = os.path.join(_MODELS_DIR, model_ref)
    if model_ref.endswith(".joblib") and os.path.exists(direct):
        return joblib.load(direct)

    # Otherwise treat as a model_type and pick the most recent.
    candidates = [
        fn for fn in os.listdir(_MODELS_DIR)
        if fn.endswith(".joblib") and _model_type_from_name(fn) == model_ref
    ]
    if not candidates:
        raise FileNotFoundError(
            f"No trained model found for '{model_ref}'. "
            f"Available: {[m['model_type'] for m in list_models()]}"
        )
    latest = max(candidates, key=lambda fn: os.path.getmtime(os.path.join(_MODELS_DIR, fn)))
    return joblib.load(os.path.join(_MODELS_DIR, latest))


def _transform(df: pd.DataFrame, artifact: dict) -> np.ndarray:
    """Replay training preprocessing on new data using the stored encoders/scaler."""
    df = df.copy()

    id_cols = [c for c in df.columns if c.lower() in ("customerid", "id", "customer_id")]
    df.drop(columns=id_cols, errors="ignore", inplace=True)
    if "TotalCharges" in df.columns:
        df["TotalCharges"] = pd.to_numeric(df["TotalCharges"], errors="coerce")

    # Apply the exact LabelEncoders fitted during training (unseen categories
    # fall back to the first known class).
    encoders = artifact.get("encoders") or {}
    for col, le in encoders.items():
        if col in df.columns:
            known = set(le.classes_)
            safe = df[col].astype(str).map(lambda v: v if v in known else le.classes_[0])
            df[col] = le.transform(safe)

    # Any remaining text columns (older artifacts without encoders) — factorize.
    for col in df.select_dtypes(include="object").columns:
        df[col] = pd.factorize(df[col])[0]

    features = artifact["features"]
    X = df.reindex(columns=features)
    X = X.apply(pd.to_numeric, errors="coerce").fillna(0)

    scaler = artifact.get("scaler")
    return scaler.transform(X) if scaler is not None else X.values


def score_dataframe(df: pd.DataFrame, artifact: dict) -> pd.DataFrame:
    """Return the input rows with `prediction` (+ `probability` when available)."""
    Xs = _transform(df, artifact)
    model = artifact["model"]

    out = df.copy()
    out["prediction"] = model.predict(Xs)

    if hasattr(model, "predict_proba"):
        proba = model.predict_proba(Xs)
        if proba.ndim == 2 and proba.shape[1] == 2:
            out["probability"] = np.round(proba[:, 1], 4)   # positive-class prob
        else:
            out["probability"] = np.round(proba.max(axis=1), 4)
    return out


def score(model_ref: str, df: pd.DataFrame) -> dict:
    """High-level scoring: load model, score df, return a JSON-friendly summary."""
    artifact = load_artifact(model_ref)
    scored = score_dataframe(df, artifact)

    pred_col = scored["prediction"]
    summary = {
        "model_type":     artifact.get("model_type", _model_type_from_name(model_ref)),
        "positive_label": artifact.get("positive_label"),
        "rows_scored":    int(len(scored)),
        "positive_count": int((pred_col == 1).sum()) if pred_col.dtype != object else None,
        "prediction_distribution": {str(k): int(v) for k, v in pred_col.value_counts().items()},
    }
    if "probability" in scored.columns:
        summary["mean_probability"] = round(float(scored["probability"].mean()), 4)
        summary["high_risk_count"]  = int((scored["probability"] >= 0.5).sum())

    return {"summary": summary, "scored": scored}
