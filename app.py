"""
app.py – Ouroboros: analytics + digital marketing FastAPI backend
================================================================

Three-phase pipeline:
  Phase 1 → LangGraph strategic planning (5 nodes, Gemini)
  HITL    → Human approval checkpoint
  Phase 2 → Analytics CrewAI (5 agents: Engineer, Scientist, LabelEncoder, Analyst, CDO)
             + Gemini enrichment of analytics report
  Phase 3 → Digital Marketing CrewAI (4 agents) fed analytics context

User provides a Database URI (any SQLAlchemy-compatible DB) — the system
auto-discovers the schema and adapts all analysis, ML models, and marketing
campaigns to whatever data is in the connected database.

7-tab Bootstrap 5 dark UI:
  Console | Analytics Report | Charts | Marketing Report | Content | Downloads | Conversation

Run:
    python main.py   →  http://localhost:8002
"""

import os
import sys

os.environ["OTEL_SDK_DISABLED"]         = "true"
os.environ["CREWAI_TELEMETRY_OPT_OUT"] = "true"

import re
import json
import uuid
import queue
import asyncio
import threading
from datetime import datetime
from pathlib import Path
from typing import List, Optional
import pandas as pd

BASE_DIR = Path(__file__).parent
sys.path.insert(0, str(BASE_DIR))

for _d in ("outputs/charts", "outputs/reports", "outputs/models",
           "outputs/videos", "outputs/content", "outputs/audit", "outputs/uploads", "static"):
    (BASE_DIR / _d).mkdir(parents=True, exist_ok=True)

AUDIT_DIR = BASE_DIR / "outputs" / "audit"

from fastapi import FastAPI, HTTPException, File, UploadFile, Form, Request
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(
    title="Ouroboros · Analytics + Digital Marketing Multi-Agent System",
    description="Connect any database — AI agents auto-discover, analyse, and build marketing campaigns",
    version="2.0.0",
)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

app.mount("/static",  StaticFiles(directory=str(BASE_DIR / "static")),  name="static")
app.mount("/outputs", StaticFiles(directory=str(BASE_DIR / "outputs")), name="outputs")

# ── In-memory store ───────────────────────────────────────────────────────────
tasks: dict       = {}
log_queues: dict  = {}
hitl_events: dict = {}
_analysis_lock    = threading.Lock()
_uploaded_files: dict = {}

# Finished runs are also written to disk so Chat, Graph and Results survive a
# backend restart. Kept out of the publicly served outputs/ directory.
TASKS_DIR = BASE_DIR / "data" / "tasks"
TASKS_DIR.mkdir(parents=True, exist_ok=True)


def _save_task(task_id: str) -> None:
    t = tasks.get(task_id)
    if not t or t.get("status") in ("running", "awaiting_approval"):
        return
    try:
        tmp = TASKS_DIR / f"{task_id}.json.tmp"
        tmp.write_text(json.dumps(t, default=str, ensure_ascii=False), encoding="utf-8")
        from features.agent import _replace               # retries while Windows holds the file open
        _replace(tmp, TASKS_DIR / f"{task_id}.json")
    except Exception as exc:
        print(f"[tasks] could not save {task_id}: {exc}", flush=True)


def _load_saved_tasks() -> None:
    for p in TASKS_DIR.glob("*.json"):
        try:
            tasks.setdefault(p.stem, json.loads(p.read_text(encoding="utf-8")))
        except Exception as exc:
            print(f"[tasks] skipped {p.name}: {exc}", flush=True)

# ── Security patterns ────────────────────────────────────────────────────────
_PII_PATTERNS = [
    (re.compile(r'\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b'), '[EMAIL]'),
    (re.compile(r'(\+62|62|0)[\s.\-]?8[1-9][0-9]{6,10}\b'), '[PHONE]'),
    (re.compile(r'\b\d{16}\b'), '[NIK/ACCT]'),
    (re.compile(r'\b(?:\d{4}[\s\-]?){3}\d{4}\b'), '[CARD]'),
    (re.compile(r'\b\d{10,15}\b'), '[ACCT]'),
]

_SQL_RE = re.compile(
    r'(union\s+(all\s+)?select)|(drop\s+(table|database))'
    r'|(insert\s+into\s+\w)|(delete\s+from\s+\w)|(update\s+\w+\s+set\s)'
    r'|(exec\s*\(|xp_cmdshell)|(\bor\b\s+[\'"]?\d[\'"]?\s*=\s*[\'"]?\d)'
    r'|(--\s*[\r\n]|;\s*--)|(\/\*[\s\S]*?\*\/)',
    re.IGNORECASE,
)

_GUARDRAIL_RE = re.compile(
    r'\b(transfer|send|wire)\s+(money|fund|cash|rp|usd|idr)'
    r'|\b(withdraw|deposit)\s+(from|to|my)'
    r'|\bmy\s+(account\s+(number|balance|pin|password)|card\s+number)'
    r'|\b(ignore|forget|disregard)\s+(previous|all|above|your)\s+(instruction|rule|prompt)'
    r'|\b(jailbreak|prompt.injection|bypass.filter|bypass.security)'
    r'|\b(act\s+as\s+a\s+|you\s+are\s+now\s+a|pretend\s+(you\s+are|to\s+be))'
    r'|\b(override|reset)\s+your\s+(system|instruction|role)',
    re.IGNORECASE,
)


def _redact_pii(text: str):
    found = False
    for pattern, placeholder in _PII_PATTERNS:
        new_text = pattern.sub(placeholder, text)
        if new_text != text:
            found = True
            text = new_text
    return text, found


def _is_sql_injection(text: str) -> bool:
    return bool(_SQL_RE.search(text))


def _is_guardrail_violation(text: str) -> bool:
    return bool(_GUARDRAIL_RE.search(text))


def _audit_log(entry: dict):
    try:
        with open(AUDIT_DIR / "conversation_audit.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


# ── Pydantic models ───────────────────────────────────────────────────────────

class CombinedRequest(BaseModel):
    # Data sources — all optional; system auto-detects what's available
    database_uri:      str       = ""   # any provider's connection string (normalized server-side)
    database_schema:   str       = ""   # optional schema, e.g. "retail" (Postgres search_path, MySQL db…)
    uploaded_file_ids: List[str] = []   # IDs returned by /api/upload (optional)
    # Analytics inputs
    analysis_request:  str       = ""
    use_langgraph:     bool      = True
    # Marketing inputs
    brand_name:        str = "Brand"
    industry:          str = "General"
    target_audience:   str = "General audience"
    campaign_goals:    str = "Grow retention and engagement"
    budget:            str = "Not specified"
    competitors:       str = "Not specified"
    campaign_type:     str = "Retention & Growth"


class ChatRequest(BaseModel):
    message: str


class ApproveRequest(BaseModel):
    abort: bool = False


# ── Stdout capture ────────────────────────────────────────────────────────────

class _TeeWriter:
    """
    Capture stdout → SSE log queue, keeping clean progress lines and
    suppressing CrewAI's verbose ReAct / Rich panel output.

    Two classes of noise to suppress
    ─────────────────────────────────
    1. ASCII pipe-table lines  │  CrewAI formats task/agent descriptions as
       (3+ '|' in the line)   │  | | Agent: X | | Task: Y | | | |  — drop them.

    2. Rich panel body lines   │  Tool execution boxes use Unicode box-drawing:
       (starts with │ or ╰)   │  │ Tool: X  │   ╰──────╯  — drop these too.
                               │  Panel headers (╭─── 🔧 Tool … ──╮) are stripped
                               │  of box chars and forwarded as clean status lines.

    3. JSON schema / tool-     │  "properties": {...}  "required": [...]
       output fragments        │  Bare  {  }  [  ]  and "key": value lines.

    4. ReAct / tool-list       │  "You ONLY have access to the following tools"
       schema dump blocks      │  and everything inside until a clean marker.
    """

    # Single-line substrings that are always dropped
    _NOISE = (
        "You ONLY have access to the following tools",
        '"additionalProperties"',
        "Tool Name:",
        "Tool Arguments:",
        "Tool Description:",
        '"type": "object"',
        '"required":',
        '"properties":',
        "IMPORTANT: Use the following format",
        "Use the following format in your response",
        "Thought: you should always think about what to do",
        "Action Input: the input to the action, always a single string",
        "Once all necessary information is gathered",
    )

    # Rich box-drawing characters to strip from otherwise-useful lines
    _BOX_RE = re.compile(r'[╭╮╰╯│─]+')

    def __init__(self, task_id: str, original):
        self._tid        = task_id
        self._original   = original
        self._skip_block = False   # True while inside a tool-schema dump block

    def write(self, text: str):
        self._original.write(text)
        self._original.flush()

        # ── 1. Enter schema-dump skip-block ──────────────────────────────
        if "You ONLY have access to the following tools" in text:
            self._skip_block = True

        # ── 2. ASCII pipe-heavy lines (CrewAI task/agent table format) ───
        # ≥2 catches both  | | Agent: X | |  (many pipes) and  || "key":  (double-pipe JSON)
        if text.count('|') >= 2:
            return

        stripped = text.rstrip()
        if not stripped:
            return

        first = stripped.lstrip()

        # ── 3. Rich panel BODY lines (│ … │) and footers (╰────╯) ───────
        if first.startswith(('│', '╰')):
            return

        # ── 4. Rich panel HEADER lines (╭─── … ──╮) — strip box chars ──
        if first.startswith('╭'):
            clean_hdr = self._BOX_RE.sub('', stripped).strip()
            if not clean_hdr:
                return
            self._emit(clean_hdr)
            return

        # ── 5. Schema-dump skip-block ─────────────────────────────────────
        if self._skip_block:
            if any(first.startswith(p) for p in (
                "Thought:", "Final Answer:", "Action:", "[Watchdog]",
                "━", "=", "Phase", "Error", "WARNING",
            )):
                self._skip_block = False      # resume forwarding
            else:
                return                        # still inside block — drop

        # ── 6. Single-line noise patterns ────────────────────────────────
        if any(p in text for p in self._NOISE):
            return

        # ── 7. JSON fragment lines ────────────────────────────────────────
        if first in ('{', '}', '[', ']'):     # bare bracket alone
            return
        if re.match(r'^"[a-zA-Z_]+":\s', first):   # "key": value
            return

        self._emit(stripped)

    def _emit(self, message: str):
        entry = {"type": "log", "message": message, "timestamp": datetime.now().isoformat()}
        tasks[self._tid]["logs"].append(entry)
        try:
            log_queues[self._tid].put_nowait(entry)
        except Exception:
            pass

    def flush(self):
        self._original.flush()

    def isatty(self):
        return False


def _push(task_id: str, msg: str, kind: str = "log"):
    entry = {"type": kind, "message": msg, "timestamp": datetime.now().isoformat()}
    tasks[task_id]["logs"].append(entry)
    try:
        log_queues[task_id].put_nowait(entry)
    except Exception:
        pass


def _strip_md_fences(text: str) -> str:
    text = re.sub(r'^```(?:markdown|md)?\s*\n', '', text.strip())
    text = re.sub(r'\n```\s*$', '', text.strip())
    text = re.sub(r'\n```(?:markdown|md)?\n[\s\S]*?```(?:\n|$)', '\n', text)
    return text.strip()


def _default_analytics_request() -> str:
    return (
        "Perform a comprehensive end-to-end data analysis on the connected data source.\n\n"
        "━━━ STEP 1 — DATA ENGINEERING (Data Engineer Agent) ━━━\n"
        "• Call list_database_tables to discover ALL available tables.\n"
        "• Call profile_database_table on the primary/most relevant table.\n"
        "• Record: row count, column names, data types, null percentages, numeric statistics,\n"
        "  and the value distribution of any binary or categorical target column.\n"
        "• Remove ID/UUID columns that add no predictive value.\n"
        "• Normalize data types (convert text-stored numbers to numeric).\n"
        "• Report data quality findings (missing values, outliers, type mismatches).\n\n"
        "━━━ STEP 2 — MACHINE LEARNING (Data Scientist Agent) ━━━\n"
        "• Inspect the schema and automatically choose the right ML approach:\n"
        "  - Binary target column found → train classification model (churn, fraud, or credit risk)\n"
        "  - Continuous target column found → regression analysis\n"
        "  - Date/timestamp column found → run time_series_forecast in addition to other models\n"
        "  - No clear target → run customer_segmentation only\n"
        "• Always run customer_segmentation (4 segments) regardless of other models.\n"
        "• Report AUC-ROC (or RMSE for regression), accuracy, and the top 5 most important\n"
        "  features with plain-English business explanations of why each matters.\n"
        "• Translate ML outputs into business language — avoid jargon.\n\n"
        "━━━ STEP 3 — DATA VISUALIZATION (Data Analyst Agent) ━━━\n"
        "• Generate at least 5 individual charts using ACTUAL column names from the data:\n"
        "  1. Target/outcome distribution — pie chart\n"
        "  2. Key numeric feature — histogram\n"
        "  3. Numeric feature grouped by target — histplot\n"
        "  4. Two-numeric relationship — scatter plot\n"
        "  5. Category vs. numeric — bar chart\n"
        "  6. Full feature correlation — heatmap (use the _encoded table)\n"
        "• After each chart, call Gemini AI vision to analyse what the chart reveals.\n"
        "• Extract 2–3 actionable business insights per chart.\n"
        "• Do NOT generate a dashboard — individual charts only.\n\n"
        "━━━ STEP 4 — REPORTING (CDO/Manager Agent) ━━━\n"
        "• Generate PDF and PowerPoint executive reports.\n"
        "• Write an Executive Summary with the top 5 findings, each with:\n"
        "  - A specific metric (e.g. '34% of Segment A churned in Q3')\n"
        "  - A clear business implication\n"
        "  - A concrete recommendation with an owner, KPI target, and timeline\n"
        "• End with a numbered action plan: [N]. Action — Owner — Deadline — Success Metric\n"
    )


def _list_files(directory: str, extensions: list) -> list:
    p = BASE_DIR / directory
    if not p.exists():
        return []
    items = []
    for ext in extensions:
        for f in sorted(p.glob(f"*{ext}"), key=os.path.getmtime, reverse=True):
            rel = f.relative_to(BASE_DIR).as_posix()
            items.append({
                "name":     f.name,
                "url":      f"/{rel}",
                "size":     f.stat().st_size,
                "ext":      ext.lstrip("."),
                "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
            })
    return items


# ── Document text extraction helpers ─────────────────────────────────────────

def _extract_pdf_text(path: str) -> str:
    try:
        import pdfplumber
        parts = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                t = page.extract_text()
                if t:
                    parts.append(t)
        return "\n\n".join(parts)
    except Exception:
        pass
    try:
        import pypdf
        r = pypdf.PdfReader(path)
        return "\n\n".join(p.extract_text() or "" for p in r.pages)
    except Exception:
        return ""


def _extract_word_text(path: str) -> str:
    try:
        from docx import Document
        doc = Document(path)
        return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())
    except Exception:
        return ""


def _extract_pptx_text(path: str) -> str:
    try:
        from pptx import Presentation
        prs = Presentation(path)
        parts = []
        for i, slide in enumerate(prs.slides, 1):
            texts = [sh.text.strip() for sh in slide.shapes if hasattr(sh, "text") and sh.text.strip()]
            if texts:
                parts.append(f"[Slide {i}]\n" + "\n".join(texts))
        return "\n\n".join(parts)
    except Exception:
        return ""


def _build_adaptive_request(
    has_db: bool,
    has_documents: bool,
    has_any_data: bool,
    struct_summary: str,
    doc_context: str,
) -> str:
    """Build an analysis prompt that adapts to whatever data sources are available."""
    lines = [
        "Perform a comprehensive analysis using whatever data sources are available below.\n"
        "Adapt your methodology to fit the inputs — not all steps apply in every scenario.\n"
    ]
    if has_db:
        lines += [
            "\n━━━ STEP 1 — DATA ENGINEERING ━━━",
            "• Call list_database_tables to discover all available tables.",
            "• Profile the primary/most relevant table: row count, columns, types, nulls, distributions.",
            "• Remove ID/UUID columns, normalize data types, report data quality issues.",
        ]
        if struct_summary:
            lines.append(f"  Available structured sources:\n{struct_summary}")
        lines += [
            "\n━━━ STEP 2 — MACHINE LEARNING ━━━",
            "• Inspect the schema and choose the appropriate model:",
            "  - Binary target column → classification (churn / fraud / risk)",
            "  - Continuous target → regression",
            "  - Date/time column found → also run time_series_forecast",
            "  - No clear target → customer_segmentation (4 clusters)",
            "• Always run customer_segmentation regardless of other models.",
            "• Report metrics and top feature importances in plain business language.",
            "\n━━━ STEP 3 — VISUALIZATION ━━━",
            "• Generate 5+ individual charts using real column names from the data.",
            "• Analyse each chart with Gemini AI vision — extract 2-3 business insights per chart.",
            "• Do NOT generate a dashboard — individual charts only.",
        ]
    else:
        lines.append("\n━━━ DATA NOTE ━━━\nNo structured database or tabular file was provided. Skip ML and visualization steps.")

    if has_documents:
        lines += [
            "\n━━━ DOCUMENT ANALYSIS ━━━",
            "The following documents have been provided. Extract all key insights, data points,",
            "facts, metrics, and strategic recommendations from them:\n",
            doc_context,
            "\nSummarise the main findings and highlight any quantitative data or actionable insights.",
        ]

    if not has_any_data:
        lines += [
            "\n━━━ RESEARCH MODE — Tavily Web Search ━━━",
            "No data was provided by the user. Use web_search_collect to research:",
            "• Industry benchmarks and market data relevant to this domain",
            "• Competitor landscape and positioning",
            "• Current trends, statistics, and best practices",
            "Build the entire analysis from web research findings.",
        ]
    elif not has_db:
        lines += [
            "\n━━━ SUPPLEMENTAL RESEARCH ━━━",
            "If the document context is insufficient for a complete analysis,",
            "use web_search_collect to fill gaps with industry data and benchmarks.",
        ]

    lines += [
        "\n━━━ STEP 4 — REPORTING ━━━",
        "• Generate PDF and PowerPoint executive reports.",
        "• Executive Summary: top 5 findings with specific metrics.",
        "• Recommendations table: Finding | Recommendation | Owner | Timeline | KPI Target.",
        "• If data was limited, include a section recommending additional data to collect.",
    ]
    return "\n".join(lines)


def _merge_db_sources(sqlite_uri: str, db_uri: str, task_id: str) -> str:
    """Load tables from an external DB into the SQLite file DB and return the SQLite URI."""
    try:
        import pandas as pd
        from sqlalchemy import create_engine, inspect as sa_inspect
        src_engine  = create_engine(db_uri, connect_args={"connect_timeout": 10})
        dest_engine = create_engine(sqlite_uri)
        inspector   = sa_inspect(src_engine)
        tables      = inspector.get_table_names()[:10]
        for tbl in tables:
            try:
                df = pd.read_sql(f"SELECT * FROM {tbl} LIMIT 50000", src_engine)
                dest_name = "db_" + "".join(c if c.isalnum() else "_" for c in tbl)
                df.to_sql(dest_name, dest_engine, if_exists="replace", index=False)
                _push(task_id, f"  Merged DB table '{tbl}' → '{dest_name}' ({len(df)} rows)", "info")
            except Exception as e:
                _push(task_id, f"  Could not merge table '{tbl}': {e}", "warn")
        return sqlite_uri
    except Exception as e:
        _push(task_id, f"  DB merge failed ({e}) — using file data only", "warn")
        return sqlite_uri


# ── Deeper-analysis integration (SHAP key drivers) ────────────────────────────

def _load_active_df_for_model(artifact: dict):
    """Best-effort: pull a sample from the active DB table whose columns best
    match the model's features (needed for SHAP)."""
    uri = os.environ.get("ACTIVE_DB_URI")
    if not uri:
        try:
            from config import POSTGRES_URI
            uri = POSTGRES_URI
        except Exception:
            return None
    try:
        from sqlalchemy import create_engine, inspect as sa_inspect
        ca = {"connect_timeout": 8} if uri.startswith("postgre") else {}
        eng = create_engine(uri, connect_args=ca)
        insp = sa_inspect(eng)
        feats = {f.lower() for f in artifact.get("features", [])}
        best, best_ov = None, 0
        for t in insp.get_table_names():
            cols = {c["name"].lower() for c in insp.get_columns(t)}
            ov = len(feats & cols)
            if ov > best_ov:
                best_ov, best = ov, t
        if best and best_ov > 0:
            return pd.read_sql(f"SELECT * FROM {best} LIMIT 2000", eng)
    except Exception:
        return None
    return None


def _run_driver_step(task_id: str, banking_blog_sections: list) -> dict:
    """After ML training, compute SHAP key drivers, render a tidy chart, surface
    it in the report gallery, and return drivers for the marketing handoff."""
    try:
        from features import scoring, deeper
        models = scoring.list_models()
        if not models:
            _push(task_id, "  Driver analysis skipped — no trained model found.", "info")
            return {}
        latest    = models[0]                      # newest first
        model_ref = latest["filename"]
        artifact  = scoring.load_artifact(model_ref)
        df        = _load_active_df_for_model(artifact)

        res = deeper.driver_analysis_with_chart(
            model_ref, df, str(BASE_DIR / "outputs" / "charts"))

        section = {
            "title": f"Key Drivers — {res['model_type'].replace('_', ' ').title()} ({res['method'].upper()})",
            "chart_type":             "key_drivers",
            "chart_url":              res["chart_url"],
            "gemini_analysis":        res.get("narrative", ""),
            "nvidia_recommendations": "",
        }
        banking_blog_sections.append(section)
        _meta = BASE_DIR / "outputs" / "charts" / "session_charts.json"
        try:
            existing = json.loads(_meta.read_text(encoding="utf-8")) if _meta.exists() else []
            existing.append(section)
            _meta.write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

        tasks[task_id]["key_drivers"] = res["drivers"]
        _push(task_id, "  Key drivers computed (" + res["method"] + "): "
              + ", ".join(d["feature"] for d in res["drivers"][:5]), "success")
        return res
    except Exception as exc:
        _push(task_id, f"  Driver analysis (non-critical): {exc}", "warn")
        return {}


# ── Main pipeline ─────────────────────────────────────────────────────────────

def _run_analysis(task_id: str, req: CombinedRequest):
    original_stdout = sys.stdout
    sys.stdout = _TeeWriter(task_id, original_stdout)

    try:
        _push(task_id, "━" * 62, "info")
        _push(task_id, "  ANALYTICS + DIGITAL MARKETING SYSTEM  —  starting", "info")
        _push(task_id, "━" * 62, "info")

        # ── Clear session sidecar files ────────────────────────────────────────
        for _sidecar in (
            BASE_DIR / "outputs" / "charts" / "session_charts.json",
            BASE_DIR / "outputs" / "content" / "session_content.json",
        ):
            try:
                if _sidecar.exists():
                    _sidecar.unlink()
            except Exception:
                pass

        _brand_name = req.brand_name.strip() or "Brand"
        tasks[task_id]["brand_name"] = _brand_name

        # ── Resolve data sources (fully adaptive — all inputs optional) ────
        from config import POSTGRES_URI

        _structured_files = []   # CSV/Excel → SQLite tables
        _document_files   = []   # PDF/Word/PPTX → text context

        for fid in (req.uploaded_file_ids or []):
            info = _uploaded_files.get(fid.strip())
            if not info:
                continue
            if info["file_type"] == "structured":
                _structured_files.append(info)
            elif info["file_type"] == "document":
                _document_files.append(info)

        _has_explicit_db  = bool(req.database_uri.strip())
        _has_structured   = bool(_structured_files)
        _has_documents    = bool(_document_files)
        _has_any_data     = _has_explicit_db or _has_structured or _has_documents

        # ── Build unified SQLite when structured files exist ───────────────
        _active_db: str | None = None
        if _has_structured or _has_explicit_db:
            _db_uri_to_merge = None
            if _has_explicit_db:
                # Accept any provider's format (postgres://, JDBC, Azure "Server=…;", …).
                from features.db_connect import describe, normalize_db_uri
                _db_uri_to_merge = normalize_db_uri(req.database_uri, req.database_schema)
                _dbi = describe(_db_uri_to_merge)
                _push(task_id, f"  Database: {_dbi['engine']} on {_dbi['provider']}", "info")
            if _has_structured:
                # Merge all structured files into one SQLite
                from sqlalchemy import create_engine as _ce_mrg
                ts_mrg     = datetime.now().strftime("%Y%m%d_%H%M%S")
                _sq_path   = BASE_DIR / "outputs" / "uploads" / f"combined_{ts_mrg}.db"
                _dest_eng  = _ce_mrg(f"sqlite:///{_sq_path}")
                for sfi in _structured_files:
                    try:
                        _src_eng = _ce_mrg(sfi["sqlite_uri"])
                        _df_tmp  = pd.read_sql(f"SELECT * FROM {sfi['table_name']}", _src_eng)
                        _df_tmp.to_sql(sfi["table_name"], _dest_eng, if_exists="replace", index=False)
                        _push(task_id, f"  Loaded '{sfi['table_name']}' from {sfi['original_name']} ({len(_df_tmp)} rows)", "info")
                    except Exception as _e:
                        _push(task_id, f"  Skipped '{sfi['original_name']}': {_e}", "warn")
                _active_db = f"sqlite:///{_sq_path}"
                if _db_uri_to_merge:
                    _active_db = _merge_db_sources(_active_db, _db_uri_to_merge, task_id)
            else:
                _active_db = _db_uri_to_merge
        # else: no structured data — document/research-only mode

        if _active_db:
            os.environ["ACTIVE_DB_URI"] = _active_db
        elif "ACTIVE_DB_URI" in os.environ:
            del os.environ["ACTIVE_DB_URI"]

        # ── Build document context string ─────────────────────────────────
        _doc_context = ""
        if _has_documents:
            _parts = []
            for di in _document_files:
                if di.get("extracted_text"):
                    _parts.append(
                        f"### {di['original_name']} ({di['format'].upper()})\n"
                        f"{di['extracted_text']}"
                    )
            _doc_context = "\n\n---\n\n".join(_parts)
            # Persist raw documents on the task for retrieval-augmented chat (Feature 5)
            tasks[task_id]["documents"] = [
                {"name": di["original_name"], "text": di["extracted_text"]}
                for di in _document_files if di.get("extracted_text")
            ]

        # ── Build structured-file summary for prompt injection ────────────
        _struct_summary = ""
        if _has_structured:
            _struct_summary = "\n".join(
                f"  • {s['original_name']} → table '{s['table_name']}' "
                f"({s['rows']} rows, {len(s['columns'])} cols: {', '.join(s['columns'][:15])})"
                for s in _structured_files
            )
        if _has_explicit_db:
            _struct_summary += f"\n  • Database URI: {req.database_uri.strip()[:80]}…"

        # ── Log data source summary ────────────────────────────────────────
        _source_parts = []
        if _has_explicit_db:   _source_parts.append("Database")
        if _has_structured:    _source_parts.append(f"{len(_structured_files)} structured file(s)")
        if _has_documents:     _source_parts.append(f"{len(_document_files)} document(s)")
        if not _source_parts:  _source_parts.append("No data — Tavily research mode")
        _push(task_id, f"  Data sources: {' + '.join(_source_parts)}", "info")

        # ── Build adaptive analysis request ───────────────────────────────
        if req.analysis_request.strip():
            analysis_request = req.analysis_request.strip()
            if _struct_summary:
                analysis_request += f"\n\n[AVAILABLE STRUCTURED DATA]:\n{_struct_summary}"
            if _doc_context:
                analysis_request += f"\n\n[DOCUMENT CONTEXT (extracted text)]:\n{_doc_context}"
        else:
            analysis_request = _build_adaptive_request(
                has_db         = _has_explicit_db or _has_structured,
                has_documents  = _has_documents,
                has_any_data   = _has_any_data,
                struct_summary = _struct_summary,
                doc_context    = _doc_context,
            )

        # ══════════════════════════════════════════════════════════════════════
        # PHASE 1 — LangGraph Strategic Planning
        # ══════════════════════════════════════════════════════════════════════
        langgraph_plan = None
        if req.use_langgraph:
            print("\n" + "=" * 62)
            print("  PHASE 1 — LangGraph Strategic Planning")
            print("=" * 62)

            from graphs.banking_graph import run_banking_analysis as _lg_run
            graph_state = _lg_run(analysis_request, [])

            langgraph_plan = {
                "analysis_plan":      graph_state.get("analysis_plan", ""),
                "etl_guidance":       graph_state.get("etl_guidance", ""),
                "ml_guidance":        graph_state.get("ml_guidance", ""),
                "analytics_guidance": graph_state.get("analytics_guidance", ""),
                "preliminary_report": graph_state.get("report_content", ""),
            }
            tasks[task_id]["langgraph_plan"] = langgraph_plan
            print("\n  LangGraph strategic planning complete.\n")

            # ── HITL Pause ─────────────────────────────────────────────────────
            _push(task_id, "━" * 58, "info")
            _push(task_id, "  HUMAN IN THE LOOP — Review the strategic plan", "info")
            _push(task_id, "  Approve in the UI to continue to Phase 2.", "info")
            _push(task_id, "  Auto-approving in 10 minutes if no response.", "info")
            _push(task_id, "━" * 58, "info")

            hitl_entry = {
                "type":               "hitl_pause",
                "task_id":            task_id,
                "plan_preview":       langgraph_plan.get("analysis_plan", ""),
                "preliminary_report": langgraph_plan.get("preliminary_report", ""),
                "timestamp":          datetime.now().isoformat(),
                "auto_approve_secs":  600,
            }
            tasks[task_id]["logs"].append(hitl_entry)
            try:
                log_queues[task_id].put_nowait(hitl_entry)
            except Exception:
                pass

            tasks[task_id]["status"] = "awaiting_approval"
            approved = hitl_events[task_id].wait(timeout=600)

            if tasks[task_id].get("hitl_aborted", False):
                raise RuntimeError("Analysis aborted by user during HITL review.")

            if not approved:
                _push(task_id, "  HITL: 10-minute timeout — auto-approving.", "warn")
            else:
                _push(task_id, "  HITL: Approved — proceeding to Phase 2.", "success")

            tasks[task_id]["status"] = "running"

        # ══════════════════════════════════════════════════════════════════════
        # PHASE 2 — Analytics CrewAI
        # ══════════════════════════════════════════════════════════════════════
        print("\n" + "=" * 62)
        print("  PHASE 2 — Analytics CrewAI Multi-Agent Execution")
        print("=" * 62)

        # ── Data engineering: dbt models (a guaranteed pipeline step, not an agent's choice) ──
        crew_request = analysis_request
        from config import DBT_MODELING
        _cur_db = os.environ.get("ACTIVE_DB_URI") or _active_db or ""
        if DBT_MODELING and _cur_db.startswith(("postgresql", "postgres")):
            try:
                from tools.dbt_builder import build_dbt_project, with_mart_search_path
                _push(task_id, "  Data engineering: modelling the data with dbt (staging → marts, with tests)…", "info")
                _run = build_dbt_project(goal=analysis_request[:500], db_uri=_cur_db)
                tasks[task_id]["dbt_run_id"] = _run["id"]
                _marts = [m for m in _run["models"] if m["layer"] == "marts" and m["status"] == "success"]
                _passed = sum(t["status"] in ("pass", "success") for t in _run["tests"])
                _push(task_id, f"  dbt: {len(_run['models'])} models, {_passed}/{len(_run['tests'])} tests passed"
                               f"{' — marts: ' + ', '.join(m['name'] for m in _marts) if _marts else ''}",
                      "success" if _run["ok"] else "warn")
                if _marts:
                    os.environ["ACTIVE_DB_URI"] = with_mart_search_path(_cur_db)
                    crew_request = (
                        f"{analysis_request}\n\n[Data engineering already done] dbt built and tested these "
                        f"analysis-ready tables ({_passed}/{len(_run['tests'])} dbt tests passed): "
                        + "; ".join(f"{m['relation']} — {m['description'][:160]}" for m in _marts)
                        + ". Always use these schema-qualified names exactly as written (e.g. in SQL and "
                          "tool calls); they are preferred over raw tables, which remain available."
                    )
            except Exception as _dbt_err:
                _push(task_id, f"  dbt modelling skipped (non-critical): {str(_dbt_err)[:300]}", "warn")

        from crew_banking import run_banking_crew
        banking_result      = run_banking_crew(crew_request, langgraph_plan)
        from tools import work_ledger as _wl
        for _kind in sorted(set(_wl.unverified)):
            _push(task_id, f"  ⚠ The {'Data Scientist' if _kind == 'model' else 'Data Analyst'} answered without "
                           f"successful {_kind} tool results — its section is marked UNVERIFIED.", "warn")
        banking_crew_output = banking_result.get("crew_output", "")
        analyst_output      = banking_result.get("analyst_output", "")
        scientist_output    = banking_result.get("scientist_output", "")

        # Load banking blog sections (charts with Gemini analysis)
        banking_blog_sections: list = []
        _meta_file = BASE_DIR / "outputs" / "charts" / "session_charts.json"
        if _meta_file.exists():
            try:
                banking_blog_sections = json.loads(_meta_file.read_text(encoding="utf-8"))
                # Deduplicate
                _seen: set = set()
                _deduped: list = []
                for _s in banking_blog_sections:
                    _url = _s.get("chart_url", "")
                    if _url not in _seen:
                        _seen.add(_url)
                        _deduped.append(_s)
                banking_blog_sections = _deduped
                _push(task_id, f"  Banking charts loaded: {len(banking_blog_sections)}", "info")
            except Exception as _e:
                _push(task_id, f"  Banking chart metadata read failed: {_e}", "warn")

        # ── Deeper analysis: SHAP key-driver chart + section (Feature 3) ──────
        driver_findings = _run_driver_step(task_id, banking_blog_sections)

        banking_charts  = _list_files("outputs/charts", [".png"])
        banking_reports = _list_files("outputs/reports", [".pdf", ".pptx", ".md"])

        # Build banking markdown report
        banking_report = banking_crew_output if len(banking_crew_output) > 50 else \
            langgraph_plan.get("preliminary_report", "# Banking Analysis Complete") if langgraph_plan else \
            "# Banking Analysis Complete"

        # ── Claude enrichment of banking report ────────────────────────────
        banking_enhanced = banking_report
        try:
            from config import get_langchain_llm
            from langchain_core.messages import HumanMessage

            if banking_report and len(banking_report) > 100:
                chart_analyses = "\n\n".join(
                    f"**{s['title']}**:\n{s['gemini_analysis']}"
                    for s in banking_blog_sections
                    if s.get("gemini_analysis")
                )
                enhance_prompt = (
                    f"You are a senior strategy consultant preparing a C-suite briefing "
                    f"for a {req.industry} organisation.\n\n"
                    "## Draft Analytics Report:\n" + banking_report + "\n\n"
                    + (f"## Chart Evidence (for your reference ONLY — do NOT copy into the report):\n{chart_analyses}\n\n" if chart_analyses else "")
                    + "## Your Task — Targeted Enrichment:\n"
                    "Produce the final CEO-ready version (600–900 words). "
                    "Keep Executive Summary max 4 bullets. "
                    "Keep Key Findings max 5 points — you may reference a specific number from the "
                    "Chart Evidence above but do NOT reproduce the full chart analysis text. "
                    "Enrich Recommendations with Owner|KPI Target|30-day|60-day|90-day table. "
                    "Replace Next Steps with numbered action plan [N]. Action — Owner — Deadline — Metric. "
                    "IMPORTANT: Do NOT include chart descriptions, visualization analyses, or image "
                    "references in the report body — those are rendered separately in the Chart Analysis "
                    "section below the report. "
                    "Output the complete report only — no preamble, no chart analysis blocks."
                )
                _push(task_id, "  Claude: enriching analytics report…", "info")
                _ollama = get_langchain_llm(temperature=0.2)
                response = _ollama.invoke([HumanMessage(content=enhance_prompt)])
                enhanced = _strip_md_fences(response.content)
                if enhanced and len(enhanced) > 200:
                    banking_enhanced = enhanced
                    _push(task_id, "  Claude: analytics report enhanced ✓", "success")
        except Exception as _gem_err:
            _push(task_id, f"  Claude enrichment (non-critical): {_gem_err}", "warn")

        tasks[task_id].update({
            "banking_report":        banking_enhanced,
            "banking_blog_sections": banking_blog_sections,
            "banking_charts":        banking_charts,
            "analyst_output":        analyst_output,
            "scientist_output":      scientist_output,
        })

        # ── Zep Knowledge Graph — analytics layer ─────────────────────────────
        _graph_builder = None
        try:
            from zep_graph import KnowledgeGraphBuilder
            _tables = []
            try:
                from tools.bank_engineer import list_database_tables as _ldt
                _tbl_raw = _ldt()
                _tbl_json = json.loads(_tbl_raw)
                _tables = [t.get("table", "") for t in _tbl_json.get("tables", []) if t.get("table")]
            except Exception:
                pass
            _chart_titles = [s.get("title", "") for s in banking_blog_sections if s.get("title")]
            _graph_builder = KnowledgeGraphBuilder(task_id)
            _graph_builder.build_analytics(
                industry         = req.industry or "General",
                brand_name       = req.brand_name or "Brand",
                tables           = _tables,
                chart_titles     = _chart_titles,
                banking_report   = banking_enhanced,
                scientist_output = scientist_output,
            )
            tasks[task_id]["graph_task_id"] = task_id
            _push(task_id, "  Zep knowledge graph: analytics layer built ✓", "success")
        except Exception as _ge:
            _push(task_id, f"  Zep knowledge graph (non-critical): {_ge}", "warn")

        # ── Automatic dashboard (one Claude design call; viewing/filtering is LLM-free) ──
        # The Data Engineer's dbt build (if any) points ACTIVE_DB_URI at the tested marts.
        _dash_db = os.environ.get("ACTIVE_DB_URI") or _active_db
        _dash_table = None                     # prefer this run's tested dbt mart, named explicitly
        try:
            from tools.dbt_builder import latest_run
            _dbt_run = latest_run(since=tasks[task_id].get("started_at"))
            if _dbt_run:
                tasks[task_id]["dbt_run_id"] = _dbt_run["id"]
                _ok_marts = [m["relation"] for m in _dbt_run["models"]
                             if m["layer"] == "marts" and m["status"] == "success"]
                _dash_table = _ok_marts[0] if _ok_marts else None
        except Exception:
            pass
        from config import AUTO_DASHBOARD
        if AUTO_DASHBOARD and _dash_db:
            try:
                from features import dashboard as _dash
                _push(task_id, "  Designing the interactive dashboard…", "info")
                _d = _dash.create_dashboard(db_uri=_dash_db, table=_dash_table, brief=analysis_request[:500],
                                            source_label=req.brand_name or "")
                tasks[task_id]["dashboard_id"] = _d["id"]
                _push(task_id, f"  Dashboard ready: {_d['spec']['title']} "
                               f"({len(_d['spec']['kpis'])} KPIs, {len(_d['spec']['charts'])} visuals) ✓", "success")
            except Exception as _de:
                _push(task_id, f"  Dashboard (non-critical): {_de}", "warn")

        _push(task_id, "━" * 62, "success")
        _push(task_id, f"  Phase 2 complete! Charts: {len(banking_charts)}  Reports: {len(banking_reports)}", "success")

        # ══════════════════════════════════════════════════════════════════════
        # PHASE 3 — Marketing LangGraph Planning + Digital Marketing CrewAI
        # ══════════════════════════════════════════════════════════════════════
        print("\n" + "=" * 62)
        print("  PHASE 3 — Marketing LangGraph + CrewAI Execution")
        print("=" * 62)
        _push(task_id, "━" * 62, "info")
        _push(task_id, "  PHASE 3 — Analytics handing findings to Marketing team…", "info")
        _push(task_id, "━" * 62, "info")

        # Analytics context passed to all marketing agents.
        # Priority: Data Analyst raw output first, then CDO executive summary as supplement.
        if analyst_output:
            banking_context = (
                f"[DATA ANALYST FINDINGS]:\n{analyst_output[:2000]}\n\n"
                f"[CDO EXECUTIVE SUMMARY]:\n{banking_enhanced[:1000]}"
            )
        else:
            banking_context = banking_enhanced[:2000] if banking_enhanced else ""
        analytics_context = banking_context  # unified variable name

        # ── Build chart analysis summary (Data Analyst's findings) ───────────
        _chart_analyses = "\n\n".join(
            f"**{s['title']}**:\n{s.get('gemini_analysis', '')}"
            for s in banking_blog_sections
            if s.get("gemini_analysis")
        )[:2500]

        # ── Generate data-driven campaign brief from Data Analyst output ─────
        # The campaign request is NOT user-typed — it comes entirely from the
        # banking analytics: churn model findings, customer segments, and the
        # Data Analyst's chart insights. The marketing team uses this to design
        # specific, named campaigns (cashback, loyalty programs, etc.).
        _push(task_id, "  Translating analyst findings → data-driven campaign brief…", "info")
        campaign_request = ""
        derived_audience = req.target_audience or "Audience segments identified in analytics"
        derived_goals    = req.campaign_goals   or "Grow retention and engagement"

        try:
            from config import get_langchain_llm
            from langchain_core.messages import HumanMessage as _HMsg

            if banking_enhanced:
                _analyst_section   = f"## Data Analyst Report:\n{analyst_output[:2000]}\n\n"       if analyst_output   else ""
                _scientist_section = f"## Data Scientist ML Results:\n{scientist_output[:1000]}\n\n" if scientist_output else ""
                _chart_section     = f"## Data Analyst Chart Insights:\n{_chart_analyses}\n\n"      if _chart_analyses  else ""

                # SHAP key drivers (Feature 3) → marketing targets the real drivers
                _drivers_section = ""
                _kd = (driver_findings or {}).get("drivers") if "driver_findings" in dir() else None
                _kd = _kd or tasks[task_id].get("key_drivers")
                if _kd:
                    _drv_lines = "\n".join(
                        f"- {d['feature']}: importance {d['importance']} ({d['direction']} the predicted likelihood)"
                        for d in _kd[:8]
                    )
                    _drivers_section = (
                        "## Model Key Drivers (SHAP feature importance):\n"
                        + _drv_lines + "\n"
                        "Design campaigns that directly address these specific drivers.\n\n"
                    )

                _handoff_prompt = (
                    f"You are a Chief Data Officer handing off data analytics results "
                    f"to the Digital Marketing team.\n\n"
                    f"Brand: {_brand_name} | Industry: {req.industry} | Budget: {req.budget}\n\n"
                    "Write a detailed **Digital Marketing Campaign Brief** based strictly on "
                    "the Data Analyst's findings below. The brief must include:\n\n"
                    "1. **At-Risk or High-Opportunity Segments** — name each segment with specific "
                    "numbers from the data (e.g. '34% of Segment A churned', "
                    "'Segment B has 3× higher lifetime value but low engagement'). "
                    "Use the actual segment names and statistics from the analytics.\n\n"
                    "2. **Top Risk/Opportunity Drivers** — list the main predictors for each segment "
                    "from the ML model feature importance (e.g. contract type, usage frequency, "
                    "tenure, product adoption, payment method, etc.).\n\n"
                    "3. **Specific Campaign Ideas (4–6 ideas)** — give each campaign a concrete name "
                    "and mechanic directly tied to a finding from the data. Examples of mechanics:\n"
                    "   - Loyalty point programme for high-value retainable segments\n"
                    "   - Upgrade incentive for users on short-term or low-tier plans\n"
                    "   - Win-back flow for recently churned or disengaged users\n"
                    "   - Digital adoption bonus for users not using premium features\n"
                    "   - VIP early access for top-performing segments\n"
                    "   - Personalised discount for price-sensitive at-risk users\n"
                    "   Invent campaigns that directly address the actual drivers found in the data.\n\n"
                    "4. **Priority Channels** — recommend the best channel for each segment "
                    "(e.g. push notification, email, SMS, Instagram, LinkedIn, in-app message) "
                    "based on the segment profile.\n\n"
                    "5. **Measurable Targets** — specific, quantified goals "
                    "(e.g. 'Reduce Segment B churn from 42% to 28% in 90 days', "
                    "'Increase Segment A average spend by 15% in 60 days').\n\n"
                    + _analyst_section
                    + _scientist_section
                    + _drivers_section
                    + _chart_section
                    + f"## CDO Executive Summary:\n{banking_enhanced[:1500]}\n\n"
                    + "Write the brief in English. Be specific, data-driven, and creative. "
                    "Adapt all language to the industry and domain — do NOT assume banking. "
                    "This document is the primary input for the Digital Marketing creative team."
                )
                _ollama = get_langchain_llm(temperature=0.2)
                _resp = _ollama.invoke([_HMsg(content=_handoff_prompt)])
                _raw_brief = _resp.content if hasattr(_resp, "content") else ""
                campaign_request = _strip_md_fences(_raw_brief)
                if campaign_request and len(campaign_request) > 200:
                    _push(task_id, "  Analyst → Marketing handoff brief generated ✓", "success")
                    derived_audience = "At-risk segments identified by analytics model (see brief)"
                    derived_goals    = "Drive retention and growth via data-driven targeted campaigns"
                else:
                    campaign_request = ""
        except Exception as _br_err:
            _push(task_id, f"  Campaign brief generation (non-critical): {_br_err}", "warn")

        # Fallback — if Gemini brief generation failed, build a structured fallback
        if not campaign_request or len(campaign_request) < 200:
            campaign_request = (
                f"Create a comprehensive digital marketing campaign for {_brand_name} "
                f"in the {req.industry} industry.\n\n"
                f"Campaign Type: {req.campaign_type} | Budget: {req.budget}\n\n"
                "Design specific, named campaign initiatives targeting the at-risk or high-opportunity "
                "segments identified in the analytics below. Include concrete campaign mechanics "
                "(loyalty programmes, upgrade incentives, win-back flows, digital adoption rewards). "
                "Each campaign should directly address a key driver found in the data.\n\n"
                f"Analytics Context:\n{banking_context[:3000]}"
            )
            _push(task_id, "  Using structured fallback campaign brief.", "warn")

        tasks[task_id]["campaign_brief"] = campaign_request

        # ── Phase 3a: Marketing LangGraph pre-planning (5 nodes, Gemini) ─────
        _push(task_id, "  Phase 3a — Marketing LangGraph: 5-node Gemini planning…", "info")
        from graphs.marketing_graph import run_marketing_analysis as _mkt_lg_run
        mkt_plan = _mkt_lg_run(
            task_description  = campaign_request,
            brand_name        = _brand_name,
            industry          = req.industry,
            target_audience   = derived_audience,
            campaign_goals    = derived_goals,
            budget            = req.budget,
            competitors       = req.competitors,
            campaign_type     = req.campaign_type,
            analytics_context = analytics_context,
        )
        tasks[task_id]["marketing_langgraph_plan"] = mkt_plan
        _push(task_id, "  Phase 3a complete — Marketing LangGraph planning done ✓", "success")

        # ── Phase 3b: Marketing CrewAI (4 agents) ────────────────────────────
        _push(task_id, "  Phase 3b — Marketing CrewAI: 4-agent sequential execution…", "info")
        from crew_marketing import run_marketing_crew
        marketing_result = run_marketing_crew(
            campaign_request  = campaign_request,
            brand_name        = _brand_name,
            industry          = req.industry,
            target_audience   = derived_audience,
            campaign_goals    = derived_goals,
            budget            = req.budget,
            competitors       = req.competitors,
            campaign_type     = req.campaign_type,
            analytics_context = analytics_context,
            langgraph_plan    = mkt_plan,
        )

        # Load marketing content sidecar
        marketing_content_items: list = []
        _content_file = BASE_DIR / "outputs" / "content" / "session_content.json"
        if _content_file.exists():
            try:
                all_entries = json.loads(_content_file.read_text(encoding="utf-8"))
                _seen_keys: set = set()
                for entry in all_entries:
                    key = f"{entry.get('type', '')}-{entry.get('title', '')}"
                    if key not in _seen_keys:
                        _seen_keys.add(key)
                        marketing_content_items.append(entry)
                _push(task_id, f"  Marketing content items loaded: {len(marketing_content_items)}", "info")
            except Exception as _e:
                _push(task_id, f"  Marketing content load failed: {_e}", "warn")

        # ── Fallback: generate content directly if crew produced nothing ───────
        if not marketing_content_items:
            _push(task_id, "  Content crew produced no items — running direct content fallback…", "warn")
            try:
                # Import the private helpers directly — NOT the @tool-decorated objects.
                # CrewAI's @tool creates a Tool instance that is NOT callable with kwargs;
                # _gemini and _update_session_content are plain Python functions.
                from tools.mkt_content import _gemini as _mkt_llm, _update_session_content as _save

                _fb_brand    = req.brand_name    or "Brand"
                _fb_campaign = req.campaign_type or "Retention"
                _fb_audience = req.target_audience or "General audience"

                # ── Ad copy (Google + Meta) ────────────────────────────────────
                _push(task_id, "  Fallback: generating ad copy…", "info")
                for _plat, _tone in [("Google", "professional"), ("Meta", "inspirational")]:
                    _copy = _mkt_llm(
                        prompt=(
                            f"Brand: {_fb_brand}\nProduct: {_fb_brand} services\n"
                            f"Audience: {_fb_audience}\nPlatform: {_plat}\nTone: {_tone}\n\n"
                            f"Write 3 ad copy variants optimised for {_plat}. "
                            "Each: Headline (≤30 chars), Description (≤90 chars), Hook, CTA. "
                            "Label each variant clearly."
                        ),
                        system=f"You are a performance marketing copywriter specialising in {_plat} ads.",
                    )
                    _save({
                        "type":      "ad_copy",
                        "title":     f"{_fb_brand} – {_plat} Ad Copy",
                        "platform":  _plat,
                        "content":   _copy,
                        "video_url": "",
                        "timestamp": datetime.now().isoformat(),
                    })

                # ── Social posts (Instagram, Twitter, LinkedIn) ────────────────
                _push(task_id, "  Fallback: generating social posts…", "info")
                for _plat in ["Instagram", "Twitter", "LinkedIn"]:
                    _posts_raw = _mkt_llm(
                        prompt=(
                            f"Brand: {_fb_brand}\nCampaign: {_fb_campaign} for {_fb_audience}\n"
                            f"Platform: {_plat}\n\n"
                            f"Generate 3 unique social media posts for {_plat}. "
                            "Each post: caption, 5–8 hashtags, emoji, CTA. "
                            'Format as JSON array: [{"post": "...", "hashtags": [...], "cta": "..."}]'
                        ),
                        system=f"You are a social media manager expert in {_plat} content strategy.",
                    )
                    _save({
                        "type":      "social_post",
                        "title":     f"{_fb_brand} – {_plat} Posts",
                        "platform":  _plat,
                        "content":   _posts_raw,
                        "video_url": "",
                        "timestamp": datetime.now().isoformat(),
                    })

                _push(task_id, "  Fallback: content generation complete ✓", "success")

                # Re-read the file
                if _content_file.exists():
                    all_entries = json.loads(_content_file.read_text(encoding="utf-8"))
                    _seen_keys2: set = set()
                    for entry in all_entries:
                        key = f"{entry.get('type', '')}-{entry.get('title', '')}"
                        if key not in _seen_keys2:
                            _seen_keys2.add(key)
                            marketing_content_items.append(entry)
                    _push(task_id, f"  Fallback content generated: {len(marketing_content_items)} items", "success")
            except Exception as _fb_err:
                _push(task_id, f"  Content fallback failed: {_fb_err}", "warn")

        # All downloads (banking + marketing reports + videos)
        all_reports = _list_files("outputs/reports", [".pdf", ".pptx", ".md"])
        all_videos  = [item for item in marketing_content_items if item.get("type") == "video"]

        # ── Zep Knowledge Graph — marketing layer ────────────────────────────
        if _graph_builder is not None:
            try:
                _graph_builder.add_marketing(
                    campaign_type    = req.campaign_type or "Retention & Growth",
                    target_audience  = req.target_audience or "General audience",
                    budget           = req.budget or "Not specified",
                    competitors      = req.competitors or "",
                    marketing_report = marketing_result,
                )
                _push(task_id, "  Zep knowledge graph: marketing layer added ✓", "success")
            except Exception as _mge:
                _push(task_id, f"  Zep marketing graph (non-critical): {_mge}", "warn")

        tasks[task_id].update({
            "status":                  "completed",
            "completed_at":            datetime.now().isoformat(),
            "marketing_report":        marketing_result,
            "marketing_content_items": marketing_content_items,
            "all_reports":             all_reports,
            "all_videos":              all_videos,
        })

        _push(task_id, "━" * 62, "success")
        _push(task_id, "  All 3 phases complete! Banking + Marketing analysis done.", "success")
        _push(task_id, f"  Reports: {len(all_reports)}  Videos: {len(all_videos)}  Content items: {len(marketing_content_items)}", "success")
        _push(task_id, "━" * 62, "success")

    except Exception as exc:
        import traceback
        err_trace = traceback.format_exc()
        tasks[task_id].update({
            "status":       "error",
            "error":        str(exc),
            "completed_at": datetime.now().isoformat(),
        })
        _push(task_id, f"ERROR: {exc}", "error")
        _push(task_id, err_trace, "error")

    finally:
        sys.stdout = original_stdout
        done_type = "complete" if tasks[task_id]["status"] == "completed" else (
            "aborted" if tasks[task_id].get("hitl_aborted") else "error"
        )
        hitl_events.pop(task_id, None)
        _save_task(task_id)                                 # before "complete": the report editors read this file
        try:
            log_queues[task_id].put_nowait({
                "type": done_type, "task_id": task_id,
                "timestamp": datetime.now().isoformat()
            })
        except Exception:
            pass
        # Editable deck + document for every report the run produced (also when a later stage failed).
        from features import studio
        reports = [r for r, field in studio.REPORTS.items() if len((tasks[task_id].get(field) or "").strip()) >= 50
                   or (r == "marketing" and len((tasks[task_id].get("campaign_brief") or "").strip()) >= 50)]
        if reports:
            threading.Thread(target=lambda: [studio.prebuild(f"run:{task_id}:{r}") for r in reports],
                             daemon=True).start()


def _run_with_lock(task_id: str, req: CombinedRequest):
    from features import billing
    try:
        with _analysis_lock:
            _run_analysis(task_id, req)
    finally:
        # A run only costs credits if it delivered results.
        charge_id = tasks[task_id].get("charge_id")
        if charge_id and tasks[task_id]["status"] != "completed":
            reason = "aborted at review" if tasks[task_id].get("hitl_aborted") else "run did not complete"
            billing.refund(charge_id, reason)


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def root():
    return FileResponse(str(BASE_DIR / "static" / "index.html"))


@app.get("/api/graph/{task_id}")
async def get_knowledge_graph(task_id: str):
    """Return knowledge graph nodes + edges for vis.js visualization."""
    from zep_graph import get_graph_data
    return get_graph_data(task_id)


@app.post("/api/analyze")
async def start_analysis(req: CombinedRequest):
    """Start a new combined analysis run (background thread)."""
    if _analysis_lock.locked():
        raise HTTPException(status_code=409, detail="An analysis is already running.")

    from features import billing
    task_id = str(uuid.uuid4())
    try:
        charge_id = billing.charge("analytics_run", ref=task_id,
                                   note=f"Analytics run · {(req.brand_name or 'untitled')[:60]}")
    except billing.InsufficientTokens as e:
        raise HTTPException(status_code=402, detail=str(e))
    tasks[task_id] = {
        "status":                  "running",
        "started_at":              datetime.now().isoformat(),
        "completed_at":            None,
        "brand_name":              req.brand_name,
        "database_uri":            req.database_uri,
        "error":                   None,
        "logs":                    [],
        "langgraph_plan":            {},
        "marketing_langgraph_plan": {},
        "campaign_brief":           "",
        "hitl_aborted":            False,
        # Banking outputs
        "banking_report":          "",
        "banking_blog_sections":   [],
        "banking_charts":          [],
        "key_drivers":             [],
        # Marketing outputs
        "marketing_report":        "",
        "marketing_content_items": [],
        "all_reports":             [],
        "all_videos":              [],
        # Conversation
        "conversation":            [],
        # Uploaded document text (for retrieval-augmented chat)
        "documents":               [],
        # Knowledge graph
        "graph_task_id":           None,
        "charge_id":               charge_id,
    }
    log_queues[task_id]  = queue.Queue()
    hitl_events[task_id] = threading.Event()

    thread = threading.Thread(target=_run_with_lock, args=(task_id, req), daemon=True)
    thread.start()

    return {"task_id": task_id, "status": "started"}


@app.get("/api/status/{task_id}")
async def get_status(task_id: str):
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found.")
    t = tasks[task_id]
    return {
        "task_id":      task_id,
        "status":       t["status"],
        "started_at":   t["started_at"],
        "completed_at": t.get("completed_at"),
        "error":        t.get("error"),
        "log_lines":    len(t.get("logs", [])),
    }


@app.get("/api/results/{task_id}")
async def get_results(task_id: str):
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found.")
    t = tasks[task_id]
    if t["status"] == "running":
        raise HTTPException(status_code=202, detail="Analysis still running.")
    if t["status"] == "error":
        raise HTTPException(status_code=500, detail=t.get("error", "Unknown error."))

    return {
        "task_id":                 task_id,
        "status":                  "completed",
        "banking_report":          t.get("banking_report", ""),
        "banking_blog_sections":   t.get("banking_blog_sections", []),
        "banking_charts":          t.get("banking_charts", []),
        "key_drivers":             t.get("key_drivers", []),
        "marketing_report":        t.get("marketing_report", ""),
        "campaign_brief":          t.get("campaign_brief", ""),
        "marketing_content_items": t.get("marketing_content_items", []),
        "all_reports":             t.get("all_reports", []),
        "all_videos":              t.get("all_videos", []),
        "langgraph_plan":          t.get("langgraph_plan", {}),
        "dashboard_id":            t.get("dashboard_id"),
        "dbt_run_id":              t.get("dbt_run_id"),
        "completed_at":            t.get("completed_at"),
    }


@app.get("/api/logs/{task_id}")
async def get_logs(task_id: str):
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found.")
    return {"task_id": task_id, "logs": tasks[task_id].get("logs", [])}


@app.get("/api/stream/{task_id}")
async def stream_events(task_id: str):
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found.")

    async def generator():
        q = log_queues[task_id]
        buffered = list(tasks[task_id].get("logs", []))
        replayed = len(buffered)
        for entry in buffered:
            yield f"data: {json.dumps(entry)}\n\n"

        drained = 0
        while drained < replayed:
            try:
                q.get_nowait()
                drained += 1
            except queue.Empty:
                break

        while True:
            try:
                msg = q.get_nowait()
                yield f"data: {json.dumps(msg)}\n\n"
                if msg.get("type") in ("complete", "error", "aborted"):
                    return
            except queue.Empty:
                if tasks[task_id]["status"] in ("completed", "error", "aborted"):
                    final = "complete" if tasks[task_id]["status"] == "completed" else "error"
                    yield f"data: {json.dumps({'type': final, 'task_id': task_id})}\n\n"
                    return
                await asyncio.sleep(0.35)

    return StreamingResponse(generator(), media_type="text/event-stream",
                              headers={"Cache-Control": "no-cache",
                                       "X-Accel-Buffering": "no",
                                       "Connection": "keep-alive"})


@app.get("/api/charts")
async def list_charts():
    return {"charts": _list_files("outputs/charts", [".png"])}


@app.get("/api/reports")
async def list_reports():
    return {"reports": _list_files("outputs/reports", [".pdf", ".pptx", ".md"])}


@app.get("/api/videos")
async def list_videos():
    return {"videos": _list_files("outputs/videos", [".mp4"])}


@app.get("/api/tasks")
async def list_tasks():
    return [
        {"task_id": tid, "status": t["status"],
         "started_at": t["started_at"], "completed_at": t.get("completed_at"),
         "brand_name": t.get("brand_name", "")}
        for tid, t in tasks.items()
    ]


@app.post("/api/approve/{task_id}")
async def approve_hitl(task_id: str, req: ApproveRequest = None):
    if req is None:
        req = ApproveRequest()
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found.")
    if tasks[task_id]["status"] != "awaiting_approval":
        raise HTTPException(status_code=400, detail="Task is not awaiting approval.")
    if task_id not in hitl_events:
        raise HTTPException(status_code=400, detail="No HITL event found for this task.")

    if req.abort:
        tasks[task_id]["hitl_aborted"] = True

    hitl_events[task_id].set()
    return {"task_id": task_id, "aborted": req.abort}


_SUPPORTED_EXTS = {
    ".csv", ".xlsx", ".xls",          # structured
    ".pdf", ".docx", ".doc",           # documents
    ".pptx", ".ppt",                   # presentations
}
_STRUCTURED_EXTS = {".csv", ".xlsx", ".xls"}


def _ingest_file(filename: str, content: bytes) -> dict:
    """Store one file for analysis (an upload or a connector import) and register it in _uploaded_files."""
    upload_dir = BASE_DIR / "outputs" / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(filename).suffix.lower()
    if ext not in _SUPPORTED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"'{filename}': unsupported format. Allowed: CSV, Excel, PDF, Word (.docx), PowerPoint (.pptx)."
        )

    ts        = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)
    raw_path  = upload_dir / f"{ts}_{safe_name}"
    raw_path.write_bytes(content)

    file_id = ts

    if ext in _STRUCTURED_EXTS:
        # ── Structured: load into SQLite ──────────────────────────────
        try:
            df = pd.read_csv(raw_path) if ext == ".csv" else pd.read_excel(raw_path)
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Could not read '{filename}': {e}")

        tbl = Path(filename).stem.lower()
        tbl = ("".join(c if c.isalnum() else "_" for c in tbl))[:50] or "data"

        sqlite_path = upload_dir / f"{ts}_data.db"
        try:
            from sqlalchemy import create_engine as _ce_up
            pd.DataFrame(df).to_sql(tbl, _ce_up(f"sqlite:///{sqlite_path}"),
                                    if_exists="replace", index=False)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Could not store '{filename}': {e}")

        _uploaded_files[file_id] = {
            "original_name": filename,
            "file_type":     "structured",
            "format":        ext.lstrip("."),
            "table_name":    tbl,
            "sqlite_uri":    f"sqlite:///{sqlite_path}",
            "extracted_text": None,
            "rows":          len(df),
            "columns":       list(df.columns),
            "raw_path":      str(raw_path),
        }
        return {
            "file_id":    file_id,
            "filename":   filename,
            "type":       "structured",
            "format":     ext.lstrip("."),
            "table_name": tbl,
            "rows":       len(df),
            "columns":    list(df.columns),
        }

    else:
        # ── Document: extract text ────────────────────────────────────
        if ext == ".pdf":
            text = _extract_pdf_text(str(raw_path))
        elif ext in (".docx", ".doc"):
            text = _extract_word_text(str(raw_path))
        else:
            text = _extract_pptx_text(str(raw_path))

        word_count = len(text.split()) if text else 0
        _uploaded_files[file_id] = {
            "original_name":  filename,
            "file_type":      "document",
            "format":         ext.lstrip("."),
            "table_name":     None,
            "sqlite_uri":     None,
            "extracted_text": text[:60000],
            "rows":           None,
            "columns":        None,
            "raw_path":       str(raw_path),
        }
        return {
            "file_id":    file_id,
            "filename":   filename,
            "type":       "document",
            "format":     ext.lstrip("."),
            "word_count": word_count,
            "preview":    text[:200] if text else "",
        }


@app.post("/api/upload")
async def upload_data_files(files: List[UploadFile] = File(...)):
    """
    Upload one or more files for analysis.
    Supported: CSV, Excel (.csv/.xlsx/.xls) — structured data loaded into SQLite.
    Supported: PDF, Word, PowerPoint (.pdf/.docx/.pptx) — text extracted as document context.
    Multiple files may be uploaded at once.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files provided.")
    results = [_ingest_file(f.filename, await f.read()) for f in files if f.filename]
    return {"files": results, "count": len(results)}


# ── Agentic Chat Helpers ───────────────────────────────────────────────────

def _execute_viz_code(code: str, output_path: str) -> tuple:
    """
    Execute matplotlib/seaborn visualization code safely.
    Returns (success: bool, message: str).
    """
    BLOCKED = [
        "import os", "import sys", "import subprocess", "import socket",
        "import requests", "import pathlib", "__import__", "eval(", "exec(",
        "open(", "os.system", "os.popen", "shutil",
    ]
    for b in BLOCKED:
        if b in code:
            return False, f"Blocked pattern '{b}' not allowed in visualization code."

    setup = (
        "import matplotlib\nmatplotlib.use('Agg')\n"
        "import matplotlib.pyplot as plt\nimport pandas as pd\nimport numpy as np\n"
        "import json\nimport seaborn as sns\nfrom datetime import datetime\n"
        f"OUTPUT_PATH = {repr(output_path)}\n"
        "plt.style.use('dark_background')\n"
        "plt.rcParams.update({"
        "'figure.facecolor':'#0d1117','axes.facecolor':'#161b22',"
        "'text.color':'#e6edf3','axes.labelcolor':'#e6edf3',"
        "'xtick.color':'#8b949e','ytick.color':'#8b949e',"
        "'axes.edgecolor':'#30363d','grid.color':'#21262d'"
        "})\n"
    )
    full_code = setup + "\n" + code
    if "plt.show()" in full_code:
        full_code = full_code.replace("plt.show()", 'plt.savefig(OUTPUT_PATH, dpi=120, bbox_inches="tight"); plt.close()')
    if "plt.savefig" not in full_code:
        full_code += '\nplt.savefig(OUTPUT_PATH, dpi=120, bbox_inches="tight")\nplt.close()\n'
    try:
        exec(full_code, {})  # noqa: S102
        return True, "Chart generated successfully."
    except Exception as exc:
        return False, f"Code execution error: {exc}"


_VIZ_KEYWORDS = (
    "visualiz", "chart", "graph", "plot", "bar chart", "pie chart",
    "histogram", "scatter", "heatmap", "line chart", "show me a",
    "draw", "figure", "barchart", "linechart", "boxplot",
)


async def _agentic_chat(
    message: str,
    task_ctx: dict,
    history: list,
    task_id: str,
) -> tuple:
    """
    NVIDIA LLaMA agentic chat with intent-based visualization.

    Strategy:
      - Detect visualization intent directly from the user's message (keyword match).
      - If viz requested → two-pass: (1) force code generation, (2) get explanation.
      - Otherwise → single-pass conversational answer.

    Returns (answer: str, chart_urls: list[str], security_flags: list[str]).
    """
    from config import query_ollama

    banking_report   = (task_ctx.get("banking_report") or "")[:4000]
    marketing_report = (task_ctx.get("marketing_report") or "")[:1500]
    chart_analyses   = "\n\n".join(
        f"**{s['title']}**:\n{s.get('gemini_analysis', '')}"
        for s in (task_ctx.get("banking_blog_sections") or [])
        if s.get("gemini_analysis")
    )[:2000]

    context_block = (
        "## Analytics Report:\n" + banking_report + "\n\n"
        + (f"## Chart Analyses:\n{chart_analyses}\n\n" if chart_analyses else "")
        + "## Marketing Campaign Brief:\n" + marketing_report
    )

    # Retrieval-augmented context from uploaded documents (Feature 5)
    _docs = task_ctx.get("documents") or []
    if _docs:
        try:
            from features import rag
            _retrieved = rag.context_for_chat(_docs, message)
            if _retrieved:
                context_block += "\n\n## Relevant Document Excerpts:\n" + _retrieved
        except Exception:
            pass

    # ── Detect visualization intent ───────────────────────────────────────────
    msg_lower = message.lower()
    wants_viz = any(kw in msg_lower for kw in _VIZ_KEYWORDS)

    chart_urls: list = []

    if wants_viz:
        # ── Pass 1: Force Python code generation ──────────────────────────────
        code_system = (
            "You are a Python data visualization expert.\n"
            "Your ONLY job is to write executable matplotlib/seaborn code.\n"
            "Output a single ```python ... ``` code block and nothing else.\n\n"
            "STRICT RULES:\n"
            "1. Use ONLY: matplotlib, seaborn, pandas, numpy, json, datetime\n"
            "2. Do NOT import os, sys, subprocess, requests, pathlib or any other module\n"
            "3. Save with exactly: plt.savefig(OUTPUT_PATH, dpi=150, bbox_inches='tight')\n"
            "4. Do NOT call plt.show()\n"
            "5. Use hardcoded/synthetic data that matches the analytics report context\n"
            "6. Chart must be dark-themed (plt.style.use('dark_background') is already applied)\n"
            "7. Add a clear title and axis labels"
        )
        code_user = (
            f"{context_block}\n\n"
            f"User request: {message}\n\n"
            "Write the Python visualization code now. Output ONLY the ```python``` block."
        )
        code_messages = [
            {"role": "system", "content": code_system},
            {"role": "user",   "content": code_user},
        ]
        try:
            code_response = await asyncio.to_thread(query_ollama, code_messages, 0.1, 1800)
        except Exception as exc:
            return f"LLM error generating visualization: {exc}", [], []

        code_match = re.search(r"```python\s*([\s\S]*?)```", code_response, re.IGNORECASE)
        if not code_match:
            # Model didn't wrap in fences — try treating the whole response as code
            code_match = re.search(r"(import matplotlib[\s\S]*)", code_response)

        if code_match:
            code = code_match.group(1).strip()
            ts_viz         = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            chart_filename = f"chat_viz_{task_id[:8]}_{ts_viz}.png"
            chart_path     = str(BASE_DIR / "outputs" / "charts" / chart_filename)
            chart_url      = f"/outputs/charts/{chart_filename}"

            success, exec_msg = _execute_viz_code(code, chart_path)
            if success and Path(chart_path).exists():
                chart_urls.append(chart_url)
                viz_status = f"Chart successfully generated and saved at {chart_url}."
            else:
                viz_status = f"Visualization failed: {exec_msg}"
                print(f"[Chat] Viz exec failed: {exec_msg}\nCode:\n{code[:400]}", flush=True)
        else:
            viz_status = "Could not extract Python code from the model response."
            print(f"[Chat] No code block found in: {code_response[:300]}", flush=True)

        # ── Pass 2: Get natural-language explanation ───────────────────────────
        explain_system = (
            "You are an expert data analyst assistant.\n"
            "Answer based on the analytics context provided.\n"
            "Be concise and insightful. Do NOT generate code."
        )
        explain_user = (
            f"{context_block}\n\n"
            f"User asked: {message}\n\n"
            f"Visualization status: {viz_status}\n\n"
            "Provide a concise explanation of what the chart shows and key insights from it. "
            "If the chart failed, explain what it would have shown and the key data points."
        )
        explain_messages = [{"role": "system", "content": explain_system}]
        for turn in history[-4:]:
            explain_messages.append({"role": "user",      "content": turn["user"]})
            explain_messages.append({"role": "assistant", "content": turn["assistant"]})
        explain_messages.append({"role": "user", "content": explain_user})

        try:
            answer = await asyncio.to_thread(query_ollama, explain_messages, 0.3, 1024)
        except Exception as exc:
            answer = f"Chart generated. {viz_status}"

        return answer, chart_urls, []

    # ── Conversational answer (no visualization needed) ───────────────────────
    conv_system = (
        "You are an expert data analyst AI assistant.\n"
        "Answer questions based strictly on the analytics results provided.\n"
        "Be concise, specific, and reference actual data from the report.\n"
        "Do NOT generate code or charts — just answer the question directly.\n\n"
        + context_block
    )
    conv_messages = [{"role": "system", "content": conv_system}]
    for turn in history[-6:]:
        conv_messages.append({"role": "user",      "content": turn["user"]})
        conv_messages.append({"role": "assistant", "content": turn["assistant"]})
    conv_messages.append({"role": "user", "content": message})

    try:
        answer = await asyncio.to_thread(query_ollama, conv_messages, 0.3, 1500)
    except Exception as exc:
        return f"LLM error: {exc}", [], []

    return answer, [], []


@app.post("/api/chat/{task_id}")
async def chat(task_id: str, req: ChatRequest):
    """Agentic chat powered by NVIDIA LLaMA with on-demand visualization tool."""
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found.")
    t = tasks[task_id]
    if t["status"] != "completed":
        raise HTTPException(status_code=400, detail="Analysis not yet completed.")

    message = req.message.strip()
    if len(message) > 2000:
        raise HTTPException(status_code=400, detail="Message too long (max 2000 characters).")
    if _is_sql_injection(message):
        _audit_log({"timestamp": datetime.now().isoformat(), "task_id": task_id,
                    "flags": ["sql_injection"], "blocked": True})
        raise HTTPException(status_code=400, detail="Blocked: SQL injection pattern detected.")
    if _is_guardrail_violation(message):
        _audit_log({"timestamp": datetime.now().isoformat(), "task_id": task_id,
                    "flags": ["guardrail_violation"], "blocked": True})
        raise HTTPException(status_code=400, detail="Blocked: out of scope or policy violation.")

    clean_message, pii_in_input = _redact_pii(message)

    answer, chart_urls, _ = await _agentic_chat(
        message   = clean_message,
        task_ctx  = t,
        history   = t.get("conversation", [])[-10:],
        task_id   = task_id,
    )

    reply, pii_in_output = _redact_pii(answer)
    security_flags = []
    if pii_in_input:  security_flags.append("pii_redacted_input")
    if pii_in_output: security_flags.append("pii_redacted_output")

    _audit_log({"timestamp": datetime.now().isoformat(), "task_id": task_id,
                "input_len": len(message), "flags": security_flags, "blocked": False,
                "output_len": len(reply), "chart_urls": chart_urls})

    t["conversation"].append({"user": clean_message, "assistant": reply,
                               "chart_urls": chart_urls})
    _save_task(task_id)
    return {"reply": reply, "chart_urls": chart_urls, "security_flags": security_flags}


@app.get("/api/chat/history/{task_id}")
async def chat_history(task_id: str):
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found.")
    return {"history": tasks[task_id].get("conversation", [])}


# ══════════════════════════════════════════════════════════════════════════════
# FEATURE 1 — Model scoring / prediction
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/models")
async def api_list_models():
    """List trained models available for scoring."""
    from features import scoring
    return {"models": scoring.list_models()}


@app.post("/api/predict")
async def api_predict(
    model_ref: str,                                   # query param (e.g. ?model_ref=churn_model)
    file:      Optional[UploadFile] = File(None),
    file_id:   Optional[str]        = Form(None),
):
    """Score new rows against a trained model.

    Provide a CSV/Excel `file` to score, OR a `file_id` from a prior /api/upload.
    `model_ref` (query param) is a model_type (e.g. 'churn_model') or an exact
    artifact filename. Returns a summary plus a download URL for the scored CSV.
    """
    from features import scoring

    # ── Resolve the dataframe to score ──────────────────────────────────────
    if file is not None and file.filename:
        ext = Path(file.filename).suffix.lower()
        raw = await file.read()
        tmp = BASE_DIR / "outputs" / "uploads" / f"score_in_{datetime.now():%Y%m%d_%H%M%S_%f}{ext}"
        tmp.write_bytes(raw)
        try:
            df = pd.read_csv(tmp) if ext == ".csv" else pd.read_excel(tmp)
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Could not read '{file.filename}': {e}")
    elif file_id:
        info = _uploaded_files.get(file_id.strip())
        if not info or info.get("file_type") != "structured":
            raise HTTPException(status_code=404, detail="Structured upload not found for file_id.")
        from sqlalchemy import create_engine as _ce
        df = pd.read_sql(f"SELECT * FROM {info['table_name']}", _ce(info["sqlite_uri"]))
    else:
        raise HTTPException(status_code=400, detail="Provide either a file or a file_id.")

    # ── Score ───────────────────────────────────────────────────────────────
    try:
        result = scoring.score(model_ref.strip(), df)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Scoring failed: {e}")

    scored = result["scored"]
    out_name = f"scored_{model_ref.strip().replace('.joblib','')}_{datetime.now():%Y%m%d_%H%M%S}.csv"
    out_path = BASE_DIR / "outputs" / "reports" / out_name
    scored.to_csv(out_path, index=False)

    preview = scored.head(50).where(pd.notnull(scored.head(50)), None).to_dict(orient="records")
    return {
        "summary":      result["summary"],
        "download_url": f"/outputs/reports/{out_name}",
        "preview":      preview,
    }


# ══════════════════════════════════════════════════════════════════════════════
# FEATURE 2 — Scheduled monitoring + drift alerts
# ══════════════════════════════════════════════════════════════════════════════

class MonitorRequest(BaseModel):
    name:             str = ""
    table:            str
    db_uri:           str = ""
    target_column:    str = ""
    metric_columns:   List[str] = []
    interval_minutes: int = 60
    webhook_url:      str = ""


@app.post("/api/monitors")
async def api_create_monitor(req: MonitorRequest):
    """Create a monitor and capture a baseline of the table's key metrics."""
    from features import monitor
    try:
        return await asyncio.to_thread(
            monitor.create_monitor,
            name=req.name, table=req.table, db_uri=req.db_uri,
            target_column=req.target_column, metric_columns=req.metric_columns,
            interval_minutes=req.interval_minutes, webhook_url=req.webhook_url,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not create monitor: {e}")


@app.get("/api/monitors")
async def api_list_monitors():
    from features import monitor
    return {"monitors": monitor.list_monitors()}


@app.get("/api/monitors/{monitor_id}")
async def api_get_monitor(monitor_id: str):
    from features import monitor
    mon = monitor.get_monitor(monitor_id)
    if not mon:
        raise HTTPException(status_code=404, detail="Monitor not found.")
    return mon


@app.delete("/api/monitors/{monitor_id}")
async def api_delete_monitor(monitor_id: str):
    from features import monitor
    if not monitor.delete_monitor(monitor_id):
        raise HTTPException(status_code=404, detail="Monitor not found.")
    return {"deleted": True}


@app.post("/api/monitors/{monitor_id}/run")
async def api_run_monitor(monitor_id: str):
    """Run a drift check immediately."""
    from features import monitor
    try:
        return await asyncio.to_thread(monitor.run_monitor, monitor_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Monitor not found.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Monitor run failed: {e}")


@app.get("/api/monitors/{monitor_id}/alerts")
async def api_monitor_alerts(monitor_id: str, limit: int = 100):
    from features import monitor
    return {"alerts": monitor.get_alerts(monitor_id, limit=limit)}


# ══════════════════════════════════════════════════════════════════════════════
# FEATURE 3 — Deeper analysis: drivers, what-if, NL data explorer
# ══════════════════════════════════════════════════════════════════════════════

def _df_from_file_id(file_id: str) -> pd.DataFrame:
    info = _uploaded_files.get((file_id or "").strip())
    if not info or info.get("file_type") != "structured":
        raise HTTPException(status_code=404, detail="Structured upload not found for file_id.")
    from sqlalchemy import create_engine as _ce
    return pd.read_sql(f"SELECT * FROM {info['table_name']}", _ce(info["sqlite_uri"]))


class DriverRequest(BaseModel):
    model_config = {"protected_namespaces": ()}
    model_ref: str
    file_id:   Optional[str] = None
    top_n:     int = 15


class WhatIfRequest(BaseModel):
    model_config = {"protected_namespaces": ()}
    model_ref: str
    overrides: dict
    file_id:   Optional[str] = None
    base_row:  Optional[dict] = None


class ExploreRequest(BaseModel):
    question: str
    db_uri:   str = ""
    table:    Optional[str] = None
    file_id:  Optional[str] = None


@app.post("/api/analyze/drivers")
async def api_drivers(req: DriverRequest):
    """Rank what drives a trained model's predictions (SHAP when data is given)."""
    from features import deeper
    df = _df_from_file_id(req.file_id) if req.file_id else None
    try:
        return await asyncio.to_thread(deeper.driver_analysis, req.model_ref, df, req.top_n)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Driver analysis failed: {e}")


@app.post("/api/analyze/whatif")
async def api_whatif(req: WhatIfRequest):
    """Simulate how changing inputs moves a trained model's predicted probability."""
    from features import deeper
    df = _df_from_file_id(req.file_id) if req.file_id else None
    try:
        return await asyncio.to_thread(
            deeper.what_if, req.model_ref, req.overrides, df, req.base_row)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"What-if failed: {e}")


@app.post("/api/explore")
async def api_explore(req: ExploreRequest):
    """Natural-language → read-only SQL data explorer."""
    from features import deeper
    db_uri, table = req.db_uri, req.table
    if req.file_id:
        info = _uploaded_files.get(req.file_id.strip())
        if not info or info.get("file_type") != "structured":
            raise HTTPException(status_code=404, detail="Structured upload not found for file_id.")
        db_uri, table = info["sqlite_uri"], info["table_name"]
    try:
        return await asyncio.to_thread(deeper.nl_explore, req.question, db_uri, table)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Explore failed: {e}")


# ── Automatic dashboards (features/dashboard.py) ──────────────────────────────
# Claude designs a dashboard once; viewing and filtering only re-run its SQL.

class DashboardCreateRequest(BaseModel):
    db_uri:  str = ""
    table:   Optional[str] = None
    file_id: Optional[str] = None
    brief:   str = ""


class DashboardDataRequest(BaseModel):
    filters: dict[str, List[str]] = {}


@app.post("/api/dashboards")
async def api_dashboard_create(req: DashboardCreateRequest):
    """Design a new dashboard with Claude (one call, plus one repair call at most)."""
    from features import dashboard
    from config import LLMUnavailableError
    db_uri, table, label = req.db_uri, req.table, ""
    if req.file_id:
        info = _uploaded_files.get(req.file_id.strip())
        if not info or info.get("file_type") != "structured":
            raise HTTPException(status_code=404, detail="Structured upload not found for file_id.")
        db_uri, table, label = info["sqlite_uri"], info["table_name"], info.get("filename", "")
    try:
        return await asyncio.to_thread(dashboard.create_dashboard, db_uri, table, req.brief[:500], label)
    except LLMUnavailableError as e:
        raise HTTPException(status_code=503, detail=f"Claude unavailable: {e}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Dashboard design failed: {e}")


@app.get("/api/dashboards")
async def api_dashboard_list():
    from features import dashboard
    return dashboard.list_dashboards()


@app.get("/api/dashboards/{dash_id}")
async def api_dashboard_get(dash_id: str):
    from features import dashboard
    try:
        return dashboard.public(dashboard.load_dashboard(dash_id))
    except (FileNotFoundError, dashboard.DashboardError) as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/api/dashboards/{dash_id}/data")
async def api_dashboard_data(dash_id: str, req: DashboardDataRequest):
    """Run every tile with the given filters. No LLM call."""
    from features import dashboard
    try:
        return await asyncio.to_thread(dashboard.dashboard_data, dash_id, req.filters)
    except (FileNotFoundError, dashboard.DashboardError) as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Dashboard data failed: {e}")


# ── Data chat: chat with a database or tabular files (features/data_chat.py) ──

class DataChatMessage(BaseModel):
    message: str


@app.post("/api/datachat/sessions")
async def api_datachat_create(files: List[UploadFile] = File(default=[]),
                              db_uri: str = Form(default=""), db_schema: str = Form(default=""),
                              import_ids: str = Form(default="")):
    """Start a chat over uploaded tabular files OR a database connection.
    `import_ids` (comma-separated) adds files brought in by /api/connectors/import."""
    from features import data_chat
    payload = [(f.filename or "data.csv", await f.read()) for f in files if f.filename]
    payload += _imported_payload(import_ids.split(","), tables_only=True)
    try:
        return await asyncio.to_thread(data_chat.create_session, payload, db_uri[:4000], db_schema[:128])
    except data_chat.DataChatError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Couldn't start the chat: {str(e).splitlines()[0][:300]}")


@app.get("/api/datachat/sessions")
async def api_datachat_list():
    from features import data_chat
    return data_chat.list_sessions()


@app.get("/api/datachat/sessions/{sid}")
async def api_datachat_get(sid: str):
    from features import data_chat
    try:
        return data_chat.get_session(sid).public()
    except (FileNotFoundError, data_chat.DataChatError) as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/api/datachat/sessions/{sid}")
async def api_datachat_delete(sid: str):
    from features import data_chat
    try:
        data_chat.delete_session(sid)
    except (FileNotFoundError, data_chat.DataChatError) as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"deleted": sid}


@app.post("/api/datachat/sessions/{sid}/message")
async def api_datachat_message(sid: str, req: DataChatMessage):
    """One chat turn: the LangChain agent analyses the data in the session's sandboxed kernel."""
    from features import billing, data_chat
    from config import LLMUnavailableError
    try:
        charge_id = billing.charge("datachat_question", ref=sid, note="Data chat question")
    except billing.InsufficientTokens as e:
        raise HTTPException(status_code=402, detail=str(e))
    try:
        reply = await asyncio.to_thread(data_chat.ask, sid, req.message)
        if reply.get("blocked"):
            billing.refund(charge_id, "question blocked by security screening")
        return reply
    except FileNotFoundError as e:
        billing.refund(charge_id, "chat not found")
        raise HTTPException(status_code=404, detail=str(e))
    except data_chat.DataChatError as e:
        billing.refund(charge_id, "question not answered")
        raise HTTPException(status_code=409 if "still answering" in str(e) else 400, detail=str(e))
    except LLMUnavailableError as e:
        billing.refund(charge_id, "model unavailable")
        raise HTTPException(status_code=503, detail=f"Claude unavailable: {e}")
    except Exception as e:
        billing.refund(charge_id, "question failed")
        raise HTTPException(status_code=500, detail=f"Chat failed: {str(e).splitlines()[0][:300]}")


class AgentTaskRequest(BaseModel):
    goal: str
    db_uri: str = ""
    db_schema: str = ""
    import_ids: List[str] = []      # files from /api/upload or /api/connectors/import


class ConnectorImportRequest(BaseModel):
    connector: str
    params: dict = {}


def _imported_payload(ids: List[str], tables_only: bool = False) -> list:
    """[(filename, bytes)] for files registered by an upload or app import. Documents come back as their
    extracted text (.txt) unless `tables_only`, which rejects them."""
    out = []
    for fid in filter(None, (s.strip() for s in ids)):
        info = _uploaded_files.get(fid)
        if not info or not info.get("raw_path") or not Path(info["raw_path"]).is_file():
            raise HTTPException(status_code=404, detail="An imported source has expired. Import it again.")
        if info["file_type"] == "structured":
            out.append((info["original_name"], Path(info["raw_path"]).read_bytes()))
        elif tables_only:
            raise HTTPException(status_code=400, detail=f"{info['original_name']} is a document; this needs a table.")
        else:
            out.append((f"{Path(info['original_name']).stem}.txt", (info.get("extracted_text") or "").encode("utf-8")))
    return out


class AgentApproveRequest(BaseModel):
    steps: Optional[List[str]] = None
    wide_items: Optional[List[str]] = None


def _agent_call(fn, *args):
    from features import agent, billing
    from config import LLMUnavailableError
    try:
        return fn(*args)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except billing.InsufficientTokens as e:
        raise HTTPException(status_code=402, detail=str(e))
    except agent.AgentError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except LLMUnavailableError as e:
        raise HTTPException(status_code=503, detail=f"Claude unavailable: {e}")


@app.post("/api/agent/tasks")
async def api_agent_create(req: AgentTaskRequest):
    """Create an Agent task: Claude drafts a plan (free) for you to review."""
    from features import agent
    attachments = _imported_payload(req.import_ids[:10])
    return await asyncio.to_thread(_agent_call, agent.create_task, req.goal, req.db_uri[:4000], req.db_schema[:128],
                                   attachments)


@app.get("/api/agent/tasks")
async def api_agent_list():
    from features import agent
    return agent.list_tasks()


@app.get("/api/agent/tasks/{tid}")
async def api_agent_get(tid: str):
    from features import agent
    return _agent_call(agent.get_task, tid)


@app.post("/api/agent/tasks/{tid}/approve")
async def api_agent_approve(tid: str, req: AgentApproveRequest):
    """Approve the (optionally edited) plan and start the autonomous run. Charges Agent credits."""
    from features import agent
    return _agent_call(agent.approve, tid, req.steps, req.wide_items)


@app.post("/api/agent/tasks/{tid}/cancel")
async def api_agent_cancel(tid: str):
    from features import agent
    return _agent_call(agent.cancel_task, tid)


@app.delete("/api/agent/tasks/{tid}")
async def api_agent_delete(tid: str):
    from features import agent
    _agent_call(agent.delete_task, tid)
    return {"deleted": tid}


@app.get("/api/agent/tasks/{tid}/files/{rel:path}")
async def api_agent_file(tid: str, rel: str):
    """Download a file from the task's private workspace."""
    from features import agent
    return FileResponse(str(_agent_call(agent.file_path, tid, rel)))


# ── Studio: editable deck + document from an Agent task's or an Analytics run's report (features/studio.py) ──
# Agent:      /api/agent/tasks/{tid}/studio/{kind}…            → ref "agent:<tid>"
# Analytics:  /api/runs/{run_id}/studio/{report}/{kind}…        → ref "run:<run_id>:<analytics|marketing>"

class StudioSave(BaseModel):
    data: dict
    base_version: Optional[int] = None


class StudioAI(BaseModel):
    instruction: str
    target_id: str = ""


class StudioRestore(BaseModel):
    version: int


def _studio_call(fn, *args):
    from features import studio
    from config import LLMUnavailableError
    try:
        return fn(*args)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except studio.Conflict as e:
        raise HTTPException(status_code=409, detail=str(e))
    except studio.StudioError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except LLMUnavailableError as e:
        raise HTTPException(status_code=503, detail=f"Claude unavailable: {e}")


async def _studio_get(ref: str, kind: str):
    """The editable deck or document (built from the report on first open) plus the images it may use."""
    from features import studio
    data = await asyncio.to_thread(_studio_call, studio.get, ref, kind)
    return {**data, "assets": await asyncio.to_thread(_studio_call, studio.assets, ref),
            "stale": await asyncio.to_thread(studio.is_stale, ref, data)}


async def _studio_save(ref: str, kind: str, req: StudioSave):
    from features import studio
    return await asyncio.to_thread(_studio_call, studio.save, ref, kind, req.data, req.base_version)


async def _studio_ai(ref: str, kind: str, req: StudioAI):
    """One AI edit (whole deck/document, or one slide/block). Charged per instruction; refunded if it fails."""
    from features import billing, studio
    await asyncio.to_thread(_studio_call, studio.get, ref, kind)          # 404 before charging
    try:
        charge_id = await asyncio.to_thread(billing.charge, "agent_ai_edit", ref, f"AI edit · {kind}")
    except billing.InsufficientTokens as e:
        raise HTTPException(status_code=402, detail=str(e))
    try:
        return await asyncio.to_thread(_studio_call, studio.ai_edit, ref, kind, req.instruction, req.target_id)
    except Exception:
        await asyncio.to_thread(billing.refund, charge_id, "AI edit failed")
        raise


async def _studio_export(ref: str, kind: str, fmt: str):
    """Download the current version as .pptx (deck), .docx or .pdf (document)."""
    from fastapi.responses import Response
    from features import studio
    name, data, media = await asyncio.to_thread(_studio_call, studio.export, ref, kind, fmt)
    return Response(content=data, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


class ShareCreate(BaseModel):
    expires_days: int = 0
    allow_comments: bool = True


class ShareComment(BaseModel):
    name: str
    text: str
    target: str = ""


def _share_call(fn, *args):
    from features import share
    try:
        return fn(*args)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except share.ShareError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _studio_routes(prefix: str, to_ref):
    """Register the same studio API under an Agent or an Analytics prefix."""
    from features import studio

    @app.get(prefix + "/{kind}")
    async def _get(kind: str, request: Request):
        return await _studio_get(to_ref(request.path_params), kind)

    @app.put(prefix + "/{kind}")
    async def _put(kind: str, req: StudioSave, request: Request):
        return await _studio_save(to_ref(request.path_params), kind, req)

    @app.post(prefix + "/{kind}/ai")
    async def _ai(kind: str, req: StudioAI, request: Request):
        return await _studio_ai(to_ref(request.path_params), kind, req)

    @app.get(prefix + "/{kind}/versions")
    async def _versions(kind: str, request: Request):
        return await asyncio.to_thread(_studio_call, studio.versions, to_ref(request.path_params), kind)

    @app.post(prefix + "/{kind}/restore")
    async def _restore(kind: str, req: StudioRestore, request: Request):
        return await asyncio.to_thread(_studio_call, studio.restore, to_ref(request.path_params), kind, req.version)

    @app.post(prefix + "/{kind}/rebuild")
    async def _rebuild(kind: str, request: Request):
        """Start over from the source report; the current version stays in the history."""
        return await asyncio.to_thread(_studio_call, studio.rebuild, to_ref(request.path_params), kind)

    @app.get(prefix + "/{kind}/export")
    async def _export(kind: str, request: Request, format: str = "pptx"):
        return await _studio_export(to_ref(request.path_params), kind, format)

    @app.post(prefix + "/{kind}/share")
    async def _share(kind: str, req: ShareCreate, request: Request):
        """A read-only link to the latest saved version (optionally expiring, optionally with comments)."""
        from features import share
        ref = to_ref(request.path_params)
        data = await asyncio.to_thread(_studio_call, studio.get, ref, kind)
        return await asyncio.to_thread(_share_call, share.create, {"type": kind, "ref": ref}, data.get("title", ""),
                                       req.expires_days, req.allow_comments)

    @app.get(prefix + "/{kind}/shares")
    async def _shares(kind: str, request: Request):
        from features import share
        return share.list_for({"type": kind, "ref": to_ref(request.path_params)})


_studio_routes("/api/agent/tasks/{tid}/studio", lambda p: f"agent:{p['tid']}")
_studio_routes("/api/runs/{run_id}/studio/{report}", lambda p: f"run:{p['run_id']}:{p['report']}")
_studio_routes("/api/datachat/sessions/{sid}/studio", lambda p: f"chat:{p['sid']}")


# ── Data chat extras: overview, glossary, exports, pinboard (features/data_chat.py) ──

def _dc_call(fn, *args):
    from features import data_chat
    try:
        return fn(*args)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except data_chat.DataChatError as e:
        raise HTTPException(status_code=400, detail=str(e))


class GlossarySave(BaseModel):
    terms: List[dict]


class PinRequest(BaseModel):
    turn: int
    kind: str
    index: int = 0


@app.get("/api/datachat/sessions/{sid}/overview")
async def api_dc_overview(sid: str, refresh: bool = False):
    """Data profile + AI summary, issues and suggested questions (built once per chat, free)."""
    from features import data_chat
    return await asyncio.to_thread(_dc_call, data_chat.overview, sid, refresh)


@app.get("/api/datachat/glossary")
async def api_dc_glossary():
    from features import data_chat
    return {"terms": data_chat.get_glossary()}


@app.put("/api/datachat/glossary")
async def api_dc_glossary_save(req: GlossarySave):
    from features import data_chat
    return {"terms": await asyncio.to_thread(_dc_call, data_chat.save_glossary, req.terms)}


@app.get("/api/datachat/sessions/{sid}/tables/{ref}")
async def api_dc_export_table(sid: str, ref: str, format: str = "xlsx"):
    """The full result table behind an answer, as Excel or CSV."""
    from fastapi.responses import Response
    from features import data_chat
    name, data, media = await asyncio.to_thread(_dc_call, data_chat.export_table, sid, ref, format)
    return Response(content=data, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/datachat/sessions/{sid}/charts/{name}.png")
async def api_dc_chart_png(sid: str, name: str):
    from features import data_chat
    p = await asyncio.to_thread(_dc_call, data_chat.chart_png, sid, name)
    return FileResponse(str(p), media_type="image/png", filename=f"chart-{name}.png")


@app.get("/api/datachat/pins")
async def api_dc_pins():
    from features import data_chat
    return data_chat.list_pins()


@app.post("/api/datachat/sessions/{sid}/pins")
async def api_dc_pin(sid: str, req: PinRequest):
    from features import data_chat
    return await asyncio.to_thread(_dc_call, data_chat.add_pin, sid, req.turn, req.kind, req.index)


@app.post("/api/datachat/pins/{pid}/refresh")
async def api_dc_pin_refresh(pid: str):
    """Re-run the steps behind a pinned chart or table against the current data (no AI call, free)."""
    from features import data_chat
    return await asyncio.to_thread(_dc_call, data_chat.refresh_pin, pid)


@app.delete("/api/datachat/pins/{pid}")
async def api_dc_pin_delete(pid: str):
    from features import data_chat
    await asyncio.to_thread(_dc_call, data_chat.delete_pin, pid)
    return {"deleted": pid}


# ── Sign in with Google / Slack for the connectors (features/oauth.py) ──

@app.get("/api/oauth/status")
async def api_oauth_status():
    from features import oauth
    return await asyncio.to_thread(oauth.status)


@app.get("/api/oauth/{provider}/start")
async def api_oauth_start(provider: str):
    """The consent URL; the web app opens it in a popup."""
    from features import oauth
    try:
        return {"url": oauth.start(provider)}
    except oauth.OAuthError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/oauth/{provider}/callback")
async def api_oauth_callback(provider: str, code: str = "", state: str = "", error: str = ""):
    """Where Google / Slack send the user back. Stores the tokens and tells the opener window."""
    import html as _html
    from fastapi.responses import HTMLResponse
    from features import oauth
    ok, msg = False, ""
    if error:
        msg = "Sign-in was cancelled." if error == "access_denied" else f"Sign-in failed: {error}"
    else:
        try:
            who = await asyncio.to_thread(oauth.finish, provider, code, state)
            ok, msg = True, f"Connected {oauth.PROVIDERS[provider]['name']} as {who['account']}. You can close this window."
        except (oauth.OAuthError, KeyError) as e:
            msg = str(e) or "Sign-in failed."
        except Exception as e:                                                   # noqa: BLE001
            msg = f"Sign-in failed: {str(e).splitlines()[0][:200]}"
    page = f"""<!doctype html><meta charset="utf-8"><title>Ouroboros</title>
<body style="font-family:Georgia,serif;background:#f3efe7;color:#181613;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px"><p style="color:{'#2e6650' if ok else '#ce401b'};font:600 12px system-ui;letter-spacing:.12em">
{'CONNECTED' if ok else 'NOT CONNECTED'}</p><h1 style="font-weight:400;font-size:22px">{_html.escape(msg)}</h1></div>
<script>try{{window.opener&&window.opener.postMessage({{type:"ouro-oauth",provider:{json.dumps(provider)},ok:{str(ok).lower()}}},"*")}}catch(e){{}}
{"setTimeout(function(){window.close()},1500)" if ok else ""}</script></body>"""
    return HTMLResponse(page)


@app.delete("/api/oauth/{provider}")
async def api_oauth_disconnect(provider: str):
    from features import oauth
    await asyncio.to_thread(oauth.disconnect, provider)
    return {"disconnected": provider}


# ── Share links (features/share.py): read-only views with optional comments ──

@app.post("/api/datachat/pins/share")
async def api_pins_share(req: ShareCreate):
    from features import share
    return await asyncio.to_thread(_share_call, share.create, {"type": "pinboard"}, "Pinboard", req.expires_days, req.allow_comments)


@app.get("/api/datachat/pins/shares")
async def api_pins_shares():
    from features import share
    return share.list_for({"type": "pinboard"})


@app.get("/api/share/{token}")
async def api_share_view(token: str):
    """Public: what a link shows (the token is the permission)."""
    from features import share
    return await asyncio.to_thread(_share_call, share.view, token)


@app.post("/api/share/{token}/comments")
async def api_share_comment(token: str, req: ShareComment):
    from features import share
    return await asyncio.to_thread(_share_call, share.comment, token, req.name, req.text, req.target)


@app.delete("/api/shares/{token}")
async def api_share_revoke(token: str):
    from features import share
    await asyncio.to_thread(share.revoke, token)
    return {"revoked": token}


@app.get("/api/shares/network")
async def api_share_network():
    """This computer's LAN addresses, for links that work for people on the same network."""
    from features import share
    return {"addresses": await asyncio.to_thread(share.network_addresses)}


# ── Brand kits for decks and documents (features/brand.py) ──

class BrandKitSave(BaseModel):
    id: str = ""
    name: str
    accent: str = ""
    dark: str = ""
    background: str = ""
    text: str = ""
    heading_font: str = ""
    body_font: str = ""
    footer: str = ""
    default: bool = False


def _brand_call(fn, *args):
    from features import brand
    try:
        return fn(*args)
    except brand.BrandError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/brand/kits")
async def api_brand_kits():
    from features import brand
    return {"kits": brand.list_kits(), "fonts": brand.FONTS}


@app.post("/api/brand/kits")
async def api_brand_save(req: BrandKitSave):
    """Create or update a kit (send `id` to update); `default: true` makes it the kit new decks start with."""
    from features import brand
    return await asyncio.to_thread(_brand_call, brand.save_kit, req.model_dump())


@app.delete("/api/brand/kits/{kit_id}")
async def api_brand_delete(kit_id: str):
    from features import brand
    await asyncio.to_thread(brand.delete_kit, kit_id)
    return {"deleted": kit_id}


@app.post("/api/brand/kits/{kit_id}/logo")
async def api_brand_logo(kit_id: str, file: UploadFile = File(...)):
    from features import brand
    data = await file.read()
    return await asyncio.to_thread(_brand_call, brand.set_logo, kit_id, file.filename or "logo.png", data)


# ── Sample data + guided first run (features/samples.py) ──
# "Kopi Nusantara", a fictional coffee chain, handed to each app so a new user sees results without connecting data.

@app.get("/api/samples")
async def api_samples():
    from features import samples
    return await asyncio.to_thread(samples.info)


# ── Industry kits (features/kits.py) ──
# Fictional sample companies per industry (F&B, retail, banking, marketing), each with metric definitions,
# suggested questions, a ready-made workflow and report starters. /api/samples/* is the F&B kit.

def _kit_call(fn, kit: str):
    from features.kits import KitError
    try:
        return fn(kit)
    except KitError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/kits")
async def api_kits():
    from features import kits
    return kits.catalog()


@app.post("/api/kits/{kit}/datachat")
async def api_kit_datachat(kit: str):
    """A Data chat on the kit's data, with its metric definitions and suggested questions (this chat only)."""
    from features import kits
    return await asyncio.to_thread(_kit_call, kits.start_datachat, kit)


@app.post("/api/kits/{kit}/analytics")
async def api_kit_analytics(kit: str):
    """The kit's data registered like uploads, plus a suggested brief, for an Analytics run."""
    from features import kits
    files, brief = await asyncio.to_thread(_kit_call, kits.analytics_payload, kit)
    infos = [await asyncio.to_thread(_ingest_file, n, b) for n, b in files]
    return {"files": [{**i, "size": len(b)} for i, (_, b) in zip(infos, files)], "brief": brief}


@app.post("/api/kits/{kit}/agent")
async def api_kit_agent(kit: str):
    """The kit's data as Agent attachments, plus a suggested goal."""
    from features import kits
    files, goal = await asyncio.to_thread(_kit_call, kits.agent_payload, kit)
    infos = [await asyncio.to_thread(_ingest_file, n, b) for n, b in files]
    return {"files": [{**i, "size": len(b), "source": "Sample data"} for i, (_, b) in zip(infos, files)], "goal": goal}


@app.post("/api/kits/{kit}/workflow")
async def api_kit_workflow(kit: str):
    """A ready-made workflow on the kit's data."""
    from features import kits
    return await asyncio.to_thread(_kit_call, kits.start_workflow, kit)


@app.post("/api/samples/datachat")
async def api_samples_datachat():
    return await api_kit_datachat("fnb")


@app.post("/api/samples/analytics")
async def api_samples_analytics():
    return await api_kit_analytics("fnb")


@app.post("/api/samples/agent")
async def api_samples_agent():
    return await api_kit_agent("fnb")


@app.post("/api/samples/workflow")
async def api_samples_workflow():
    return await api_kit_workflow("fnb")


class WorkflowSave(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    nodes: Optional[List[dict]] = None
    edges: Optional[List[dict]] = None
    schedule: Optional[dict] = None


class WorkflowGenerate(BaseModel):
    prompt: str
    workflow_id: str = ""


def _wf_call(fn, *args):
    from features import billing, workflow
    from config import LLMUnavailableError
    try:
        return fn(*args)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except billing.InsufficientTokens as e:
        raise HTTPException(status_code=402, detail=str(e))
    except workflow.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except LLMUnavailableError as e:
        raise HTTPException(status_code=503, detail=f"Claude unavailable: {e}")


@app.get("/api/workflows/catalog")
async def api_wf_catalog():
    from features import workflow
    return workflow.catalog()


@app.get("/api/workflows")
async def api_wf_list():
    from features import workflow
    return await asyncio.to_thread(workflow.list_workflows)


@app.post("/api/workflows")
async def api_wf_create(req: WorkflowSave):
    from features import workflow
    return await asyncio.to_thread(_wf_call, workflow.create, req.name or "", req.nodes or [], req.edges or [], req.description or "")


@app.post("/api/workflows/generate")
async def api_wf_generate(req: WorkflowGenerate):
    """Claude builds a workflow from a description (or edits the given one). Free."""
    from features import workflow
    return await asyncio.to_thread(_wf_call, workflow.generate, req.prompt, req.workflow_id)


@app.get("/api/workflows/{wid}")
async def api_wf_get(wid: str):
    from features import workflow
    return await asyncio.to_thread(_wf_call, workflow.get, wid)


@app.put("/api/workflows/{wid}")
async def api_wf_update(wid: str, req: WorkflowSave):
    from features import workflow
    return await asyncio.to_thread(_wf_call, workflow.update, wid, req.model_dump(exclude_none=True))


@app.delete("/api/workflows/{wid}")
async def api_wf_delete(wid: str):
    from features import workflow
    await asyncio.to_thread(_wf_call, workflow.delete, wid)
    return {"deleted": wid}


@app.post("/api/workflows/{wid}/files")
async def api_wf_upload(wid: str, file: UploadFile = File(...)):
    from features import workflow
    data = await file.read()
    return await asyncio.to_thread(_wf_call, workflow.add_file, wid, file.filename or "data.csv", data)


@app.post("/api/workflows/{wid}/import")
async def api_wf_import(wid: str, req: ConnectorImportRequest):
    """Import a table from an app (Sheets, Drive, Slack, Notion, Airtable, URL) into the workflow's files."""
    from features import connectors, workflow
    params = {k: str(v)[:4000] for k, v in (req.params or {}).items()}
    try:
        name, data = await asyncio.to_thread(connectors.fetch, req.connector, params)
    except connectors.ConnectorError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if Path(name).suffix.lower() not in (".csv", ".xlsx", ".xls"):
        raise HTTPException(status_code=400, detail=f"{name} is a document; workflows need a table.")
    info = await asyncio.to_thread(_wf_call, workflow.add_file, wid, name, data)
    return {"file_id": info["name"], "filename": info["name"], "type": "structured", "rows": info["rows"],
            "columns": info["columns"], "source": connectors.CONNECTORS[req.connector]["name"], "size": len(data)}


@app.post("/api/workflows/{wid}/run")
async def api_wf_run(wid: str):
    """Run the workflow now (paid steps are charged as they run)."""
    from features import workflow
    return await asyncio.to_thread(_wf_call, workflow.run, wid)


class PurchaseRequest(BaseModel):
    pack_id: str


class SubscribeRequest(BaseModel):
    plan_id: str
    interval: str = "month"


@app.get("/api/billing")
async def api_billing():
    """Credit balance by bucket, current plan, pricing.json (plans, packs, action costs) and recent ledger."""
    from features import billing
    return await asyncio.to_thread(billing.summary)


@app.get("/api/billing/plans")
async def api_billing_plans():
    from features import billing
    return billing.pricing()


@app.post("/api/billing/topup")
@app.post("/api/billing/purchase")
async def api_billing_topup(req: PurchaseRequest):
    """DEMO checkout: adds a top-up pack's credits without taking payment."""
    from features import billing
    try:
        return await asyncio.to_thread(billing.topup, req.pack_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/billing/subscribe")
async def api_billing_subscribe(req: SubscribeRequest):
    """DEMO checkout: switches plan and grants its monthly credits without taking payment."""
    from features import billing
    try:
        return await asyncio.to_thread(billing.subscribe, req.plan_id, req.interval)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class BillingSettingsRequest(BaseModel):
    spend_cap_usd: Optional[float] = None
    auto_topup: Optional[bool] = None


@app.put("/api/billing/settings")
async def api_billing_settings(req: BillingSettingsRequest):
    """Monthly top-up spend cap (send null to remove it) and auto top-up."""
    from features import billing
    try:
        return await asyncio.to_thread(
            billing.update_settings,
            req.spend_cap_usd if "spend_cap_usd" in req.model_fields_set else "keep",
            req.auto_topup)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/workflows/{wid}/estimate")
async def api_wf_estimate(wid: str):
    """Credits per run and per month on the saved schedule."""
    from features import workflow
    return await asyncio.to_thread(_wf_call, workflow.estimate, wid)


_METERED = {                                    # (method, path) -> pricing.json action, charged per call
    ("POST", "/api/dashboards"): ("dashboard_page", "Dashboard page design"),
    ("POST", "/api/predict"): ("model_lab", "Model lab · scoring"),
    ("POST", "/api/analyze/drivers"): ("model_lab", "Model lab · key drivers"),
    ("POST", "/api/analyze/whatif"): ("model_lab", "Model lab · what-if"),
    ("POST", "/api/explore"): ("model_lab", "Model lab · question to SQL"),
    ("POST", "/api/rag/query"): ("rag_question", "Document Q&A question"),
}


@app.middleware("http")
async def _meter_calls(request, call_next):
    """Charge the metered on-demand tools; refund automatically when the call fails."""
    meter = _METERED.get((request.method, request.url.path))
    if not meter:
        return await call_next(request)
    from fastapi.responses import JSONResponse
    from features import billing
    try:
        charge_id = await asyncio.to_thread(billing.charge, meter[0], "", meter[1])
    except billing.InsufficientCredits as e:
        return JSONResponse(status_code=402, content={"detail": str(e)})
    try:
        response = await call_next(request)
    except Exception:
        await asyncio.to_thread(billing.refund, charge_id, "call failed")
        raise
    if response.status_code >= 400:
        await asyncio.to_thread(billing.refund, charge_id, f"call failed ({response.status_code})")
    return response


def _charge_or_402(action: str, ref: str = "", note: str = "") -> str:
    from features import billing
    try:
        return billing.charge(action, ref=ref, note=note)
    except billing.InsufficientCredits as e:
        raise HTTPException(status_code=402, detail=str(e))


# ── Database connection test (features/db_connect.py) ─────────────────────────

class DbTestRequest(BaseModel):
    uri:    str
    schema: str = ""


@app.post("/api/db/test")
async def api_db_test(req: DbTestRequest):
    """Normalize any provider's connection string, connect, and list schemas/tables."""
    from features.db_connect import test_connection
    return await asyncio.to_thread(test_connection, req.uri[:4000], req.schema[:128])


# ── App connectors: Google Sheets, Drive, Slack, Notion, Airtable, file URL (features/connectors.py) ──

@app.get("/api/connectors")
async def api_connectors():
    """Available connectors and whether the server has credentials for each (never the secrets)."""
    from features import connectors
    return {"connectors": connectors.status()}


@app.post("/api/connectors/import")
async def api_connectors_import(req: ConnectorImportRequest):
    """Fetch data from an app and store it like an upload; the result is used like an /api/upload file."""
    from features import connectors
    params = {k: str(v)[:4000] for k, v in (req.params or {}).items()}
    try:
        name, data = await asyncio.to_thread(connectors.fetch, req.connector, params)
    except connectors.ConnectorError as e:
        raise HTTPException(status_code=400, detail=str(e))
    info = await asyncio.to_thread(_ingest_file, name, data)
    return {**info, "source": connectors.CONNECTORS[req.connector]["name"], "size": len(data)}


# ── dbt data models (tools/dbt_builder.py) ─────────────────────────────────────

class DbtBuildRequest(BaseModel):
    goal:   str = ""
    db_uri: str = ""


@app.get("/api/dbt/runs")
async def api_dbt_runs():
    from tools import dbt_builder
    try:
        dbt_builder.sync_external_results("airflow")   # results the Airflow container wrote
    except Exception:
        pass
    return dbt_builder.list_runs()


@app.get("/api/dbt/runs/{run_id}")
async def api_dbt_run(run_id: str):
    from tools import dbt_builder
    try:
        return dbt_builder.load_run(run_id)
    except (FileNotFoundError, dbt_builder.DbtBuildError) as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/dbt/models/{name}")
async def api_dbt_model(name: str):
    from tools import dbt_builder
    try:
        return dbt_builder.model_source(name)
    except (FileNotFoundError, dbt_builder.DbtBuildError) as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/api/dbt/build")
async def api_dbt_build(req: DbtBuildRequest):
    """Claude designs the dbt project and `dbt build` runs it (one design call + at most one repair)."""
    from tools import dbt_builder
    from config import LLMUnavailableError
    try:
        return await asyncio.to_thread(dbt_builder.build_dbt_project, req.goal[:500], req.db_uri)
    except LLMUnavailableError as e:
        raise HTTPException(status_code=503, detail=f"Claude unavailable: {e}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"dbt build failed: {e}")


class AirflowSetupRequest(BaseModel):
    schedule: Optional[str] = "@daily"


@app.post("/api/airflow/setup")
async def api_airflow_setup(req: AirflowSetupRequest):
    """Generate the Dockerised Airflow project + DAG (does not start Docker)."""
    from tools import airflow_builder
    try:
        return airflow_builder.write_setup(req.schedule)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/airflow/status")
async def api_airflow_status():
    from tools import airflow_builder
    return await asyncio.to_thread(airflow_builder.status)


@app.post("/api/airflow/trigger")
async def api_airflow_trigger():
    from tools import airflow_builder
    try:
        return await asyncio.to_thread(airflow_builder.trigger)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Airflow trigger failed: {e}")


@app.post("/api/dbt/rebuild")
async def api_dbt_rebuild():
    """Re-run the existing dbt project — no LLM call (same as the scheduled Airflow job)."""
    from tools import dbt_builder
    try:
        return await asyncio.to_thread(dbt_builder.rebuild)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"dbt rebuild failed: {e}")


@app.delete("/api/dashboards/{dash_id}")
async def api_dashboard_delete(dash_id: str):
    from features import dashboard
    try:
        dashboard.delete_dashboard(dash_id)
    except dashboard.DashboardError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"deleted": dash_id}


# ══════════════════════════════════════════════════════════════════════════════
# FEATURE 5 — RAG Q&A over uploaded documents
# ══════════════════════════════════════════════════════════════════════════════

class RagRequest(BaseModel):
    question: str
    file_ids: List[str] = []
    task_id:  Optional[str] = None
    k:        int = 5


@app.post("/api/rag/query")
async def api_rag_query(req: RagRequest):
    """Answer a question over uploaded documents with cited passages."""
    from features import rag

    docs = []
    if req.task_id and req.task_id in tasks:
        docs = tasks[req.task_id].get("documents") or []
    for fid in req.file_ids:
        info = _uploaded_files.get(fid.strip())
        if info and info.get("file_type") == "document" and info.get("extracted_text"):
            docs.append({"name": info["original_name"], "text": info["extracted_text"]})

    if not docs:
        raise HTTPException(status_code=400, detail="No documents found for the given task_id/file_ids.")

    try:
        return await asyncio.to_thread(rag.answer, docs, req.question, req.k)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"RAG query failed: {e}")


@app.on_event("startup")
async def _start_background_jobs():
    _load_saved_tasks()
    from features import monitor, workflow
    monitor.start_scheduler()
    workflow.start_scheduler()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8002, reload=False)
