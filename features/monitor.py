"""features/monitor.py — Feature 2: scheduled monitoring + drift/anomaly alerts.

Turns the one-shot pipeline into continuous monitoring. A *monitor* points at a
database table, captures a baseline of key metrics on creation, then re-checks
on an interval. When current metrics deviate from the baseline beyond a z-score
threshold (mean shift, null-rate change, row-count change, target-rate change),
it raises an alert with a plain-language explanation written by Claude and,
optionally, POSTs it to a webhook.

State is persisted to outputs/monitors/ so monitors survive restarts.
"""
import os
import json
import time
import uuid
import threading
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
from sqlalchemy import create_engine

_BASE_DIR     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MON_DIR      = os.path.join(_BASE_DIR, "outputs", "monitors")
_MON_FILE     = os.path.join(_MON_DIR, "monitors.json")
_ALERTS_FILE  = os.path.join(_MON_DIR, "alerts.jsonl")
os.makedirs(_MON_DIR, exist_ok=True)

_Z_THRESHOLD   = 3.0     # mean-shift sensitivity (standard deviations)
_NULL_DELTA    = 0.15    # absolute null-rate change that triggers an alert
_ROWS_DELTA    = 0.50    # relative row-count change that triggers an alert
_MAX_ROWS      = 100_000

_lock = threading.Lock()


# ── Persistence ───────────────────────────────────────────────────────────────

def _load() -> dict:
    if os.path.exists(_MON_FILE):
        try:
            with open(_MON_FILE, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            return {}
    return {}


def _save(monitors: dict):
    with open(_MON_FILE, "w", encoding="utf-8") as fh:
        json.dump(monitors, fh, indent=2, ensure_ascii=False, default=str)


def _record_alert(entry: dict):
    with open(_ALERTS_FILE, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")


# ── Metrics & drift ───────────────────────────────────────────────────────────

def _resolve_db_uri(db_uri: str = "") -> str:
    if db_uri:
        return db_uri
    from config import POSTGRES_URI
    return os.environ.get("ACTIVE_DB_URI") or POSTGRES_URI


def _compute_metrics(df: pd.DataFrame, metric_columns: list, target_column: str = "") -> dict:
    metrics = {"row_count": int(len(df)), "columns": {}}
    nums = df.select_dtypes(include=np.number).columns.tolist()
    cols = [c for c in (metric_columns or nums) if c in df.columns]
    for c in cols:
        s = pd.to_numeric(df[c], errors="coerce")
        metrics["columns"][c] = {
            "mean":      float(np.nanmean(s)) if len(s) else 0.0,
            "std":       float(np.nanstd(s))  if len(s) else 0.0,
            "null_rate": float(s.isna().mean()) if len(s) else 0.0,
        }
    if target_column and target_column in df.columns:
        ts = df[target_column]
        try:
            # positive-rate for binary targets (handles Yes/No, 1/0, True/False)
            pos = ts.astype(str).str.lower().isin(["1", "yes", "true", "churn", "fraud", "default"])
            metrics["target_rate"] = float(pos.mean())
        except Exception:
            metrics["target_rate"] = None
    return metrics


def _pull(db_uri: str, table: str) -> pd.DataFrame:
    engine = create_engine(db_uri, connect_args={"connect_timeout": 10} if db_uri.startswith("postgre") else {})
    return pd.read_sql(f"SELECT * FROM {table} LIMIT {_MAX_ROWS}", engine)


def _detect_drift(baseline: dict, current: dict, target_column: str = "") -> list:
    findings = []

    # Row-count change
    b_rows, c_rows = baseline.get("row_count", 0), current.get("row_count", 0)
    if b_rows > 0:
        rel = abs(c_rows - b_rows) / b_rows
        if rel >= _ROWS_DELTA:
            findings.append({
                "type": "row_count_change", "severity": "warning",
                "detail": f"Row count changed {rel*100:.0f}% (baseline {b_rows} → current {c_rows}).",
            })

    # Per-column mean shift & null-rate change
    for col, b in baseline.get("columns", {}).items():
        c = current.get("columns", {}).get(col)
        if not c:
            continue
        std = b.get("std", 0.0) or 1e-9
        z = abs(c["mean"] - b["mean"]) / std
        if z >= _Z_THRESHOLD:
            findings.append({
                "type": "mean_shift", "column": col,
                "severity": "critical" if z >= 2 * _Z_THRESHOLD else "warning",
                "z_score": round(float(z), 2),
                "detail": f"'{col}' mean shifted from {b['mean']:.3g} to {c['mean']:.3g} (z={z:.1f}).",
            })
        nd = abs(c["null_rate"] - b["null_rate"])
        if nd >= _NULL_DELTA:
            findings.append({
                "type": "null_rate_change", "column": col, "severity": "warning",
                "detail": f"'{col}' null rate changed from {b['null_rate']:.0%} to {c['null_rate']:.0%}.",
            })

    # Target-rate change
    if target_column and baseline.get("target_rate") is not None and current.get("target_rate") is not None:
        bd = abs(current["target_rate"] - baseline["target_rate"])
        if bd >= 0.05:
            findings.append({
                "type": "target_rate_change", "column": target_column,
                "severity": "critical" if bd >= 0.10 else "warning",
                "detail": (f"Target '{target_column}' positive rate moved from "
                           f"{baseline['target_rate']:.1%} to {current['target_rate']:.1%}."),
            })
    return findings


def _narrate(monitor: dict, findings: list) -> str:
    """Ask Claude to explain the drift in business terms."""
    if not findings:
        return "No significant drift detected — metrics are within expected ranges."
    try:
        from config import query_cerebras
        bullets = "\n".join(f"- {f['detail']} (severity: {f['severity']})" for f in findings)
        return query_cerebras([
            {"role": "system", "content": (
                "You are a data-monitoring analyst. You are given automatically "
                "detected drift in a production data table. In 3-5 sentences, explain "
                "what likely changed, why it matters for the business, and the single "
                "most important action to take. Be concrete and non-alarmist."
            )},
            {"role": "user", "content": (
                f"Monitor: {monitor.get('name')} on table '{monitor.get('table')}'.\n"
                f"Detected drift:\n{bullets}"
            )},
        ], max_tokens=600)
    except Exception as exc:
        return f"(Drift detected; narrative unavailable: {exc})"


def _post_webhook(url: str, payload: dict):
    try:
        import httpx
        httpx.post(url, json=payload, timeout=10)
    except Exception:
        pass


# ── Public API ────────────────────────────────────────────────────────────────

def create_monitor(
    name: str,
    table: str,
    db_uri: str = "",
    target_column: str = "",
    metric_columns: Optional[list] = None,
    interval_minutes: int = 60,
    webhook_url: str = "",
) -> dict:
    """Create a monitor, capturing the current state as the baseline."""
    uri = _resolve_db_uri(db_uri)
    df  = _pull(uri, table)
    baseline = _compute_metrics(df, metric_columns or [], target_column)

    mon = {
        "id":               str(uuid.uuid4()),
        "name":             name or table,
        "table":            table,
        "db_uri":           db_uri,            # stored as given ("" → resolved at run time)
        "target_column":    target_column,
        "metric_columns":   metric_columns or list(baseline["columns"].keys()),
        "interval_minutes": int(interval_minutes),
        "webhook_url":      webhook_url,
        "baseline":         baseline,
        "enabled":          True,
        "created_at":       datetime.now().isoformat(),
        "last_run":         None,
        "last_status":      "baseline_captured",
        "alert_count":      0,
    }
    with _lock:
        monitors = _load()
        monitors[mon["id"]] = mon
        _save(monitors)
    return mon


def list_monitors() -> list:
    return list(_load().values())


def get_monitor(monitor_id: str) -> Optional[dict]:
    return _load().get(monitor_id)


def delete_monitor(monitor_id: str) -> bool:
    with _lock:
        monitors = _load()
        if monitor_id in monitors:
            del monitors[monitor_id]
            _save(monitors)
            return True
    return False


def run_monitor(monitor_id: str) -> dict:
    """Run a drift check now; persist any alert and return the result."""
    mon = get_monitor(monitor_id)
    if not mon:
        raise KeyError(f"Monitor '{monitor_id}' not found.")

    uri = _resolve_db_uri(mon.get("db_uri", ""))
    try:
        df = _pull(uri, mon["table"])
    except Exception as exc:
        result = {"monitor_id": monitor_id, "checked_at": datetime.now().isoformat(),
                  "status": "error", "error": str(exc)}
        _update_after_run(monitor_id, status="error")
        return result

    current  = _compute_metrics(df, mon.get("metric_columns") or [], mon.get("target_column", ""))
    findings = _detect_drift(mon["baseline"], current, mon.get("target_column", ""))
    narrative = _narrate(mon, findings)

    result = {
        "monitor_id": monitor_id,
        "name":       mon["name"],
        "table":      mon["table"],
        "checked_at": datetime.now().isoformat(),
        "status":     "drift_detected" if findings else "ok",
        "findings":   findings,
        "narrative":  narrative,
        "current_metrics": current,
    }

    if findings:
        _record_alert(result)
        if mon.get("webhook_url"):
            _post_webhook(mon["webhook_url"], result)

    _update_after_run(monitor_id, status=result["status"], had_alert=bool(findings))
    return result


def _update_after_run(monitor_id: str, status: str, had_alert: bool = False):
    with _lock:
        monitors = _load()
        if monitor_id in monitors:
            monitors[monitor_id]["last_run"]    = datetime.now().isoformat()
            monitors[monitor_id]["last_status"] = status
            if had_alert:
                monitors[monitor_id]["alert_count"] = monitors[monitor_id].get("alert_count", 0) + 1
            _save(monitors)


def get_alerts(monitor_id: Optional[str] = None, limit: int = 100) -> list:
    if not os.path.exists(_ALERTS_FILE):
        return []
    out = []
    with open(_ALERTS_FILE, "r", encoding="utf-8") as fh:
        for line in fh:
            try:
                a = json.loads(line)
            except Exception:
                continue
            if monitor_id is None or a.get("monitor_id") == monitor_id:
                out.append(a)
    return out[-limit:][::-1]


# ── Background scheduler ──────────────────────────────────────────────────────

_scheduler_thread: Optional[threading.Thread] = None
_scheduler_stop = threading.Event()


def _due(mon: dict) -> bool:
    if not mon.get("enabled", True):
        return False
    last = mon.get("last_run")
    if not last:
        return True
    try:
        elapsed = (datetime.now() - datetime.fromisoformat(last)).total_seconds()
    except Exception:
        return True
    return elapsed >= mon.get("interval_minutes", 60) * 60


def _scheduler_loop(tick_seconds: int = 30):
    while not _scheduler_stop.is_set():
        try:
            for mon in list_monitors():
                if _due(mon):
                    try:
                        run_monitor(mon["id"])
                    except Exception as exc:
                        print(f"[Monitor] run failed for {mon.get('id')}: {exc}", flush=True)
        except Exception as exc:
            print(f"[Monitor] scheduler error: {exc}", flush=True)
        _scheduler_stop.wait(tick_seconds)


def start_scheduler():
    global _scheduler_thread
    if _scheduler_thread and _scheduler_thread.is_alive():
        return
    _scheduler_stop.clear()
    _scheduler_thread = threading.Thread(target=_scheduler_loop, daemon=True)
    _scheduler_thread.start()
    print("[Monitor] background scheduler started.", flush=True)
