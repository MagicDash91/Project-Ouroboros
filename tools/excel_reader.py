"""
tools/excel_reader.py – read every sheet of an Excel workbook correctly, and explain it to Claude.

Every feature that accepts Excel (Analytics runs, Data chat, Agent, Workflow, Auto Dashboard, Model lab,
app connectors) uses this instead of `pd.read_excel(path)`, which only reads the FIRST sheet and assumes the
header is row 1. For each sheet it:

  - finds the real header row (title / logo / notes rows above it are kept as the sheet's title),
    joins two-row headers ("Q1" over "Sales" → "Q1 Sales") and fills merged header cells across
  - drops "Total" / "Grand total" / "Jumlah" rows so they aren't double counted (and says so)
  - turns numbers stored as text ("Rp 1.250.000", "45%", "1,234.5") into numbers
  - notes hidden sheets, text-only sheets (instructions / notes), and data after a gap (a second table)

`relationships(sheets)` finds columns that link sheets (same or similar name, overlapping values).
`understand(src, filename)` = read + one Claude Haiku call that writes a WORKBOOK GUIDE: what each sheet is,
what one row means, keys, measures, units/currency, caveats, how the sheets connect, and which sheet answers
what. Cached per file content (data/excel_guides/<sha>.json). Without Claude a deterministic guide is used.

Only pandas + openpyxl are needed at read time, so the sandboxed Python kernel (tools/py_kernel.py) can
import `read_workbook` too.
"""

import hashlib
import io
import json
import re
from pathlib import Path
from typing import Optional, Union

EXCEL_EXTS = (".xlsx", ".xlsm", ".xls")
MAX_SHEETS = 30
MAX_ROWS = 1_000_000
HEADER_SCAN = 25
_TOTAL = re.compile(r"^\s*(grand\s+)?(sub\s*-?\s*)?totals?\b|^\s*jumlah\b|^\s*total\s+keseluruhan", re.I)
_NUMERIC_TEXT = re.compile(r"^\s*\(?\s*[-+]?\s*(rp\.?|idr|usd|\$|€|£|s\$|rm)?\s*[-+]?\d[\d.,\s]*\s*(%|k|m|bn|jt|rb)?\s*\)?\s*$", re.I)
ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "excel_guides"


def is_excel(name: str) -> bool:
    return str(name).lower().endswith(EXCEL_EXTS)


# ── Reading ──────────────────────────────────────────────────────────────────

def _blank(v) -> bool:
    return v is None or (isinstance(v, str) and not v.strip()) or (isinstance(v, float) and v != v)


def _is_text(v) -> bool:
    return isinstance(v, str) and bool(v.strip()) and not _NUMERIC_TEXT.match(v)


def _row_width(row) -> int:
    return sum(0 if _blank(v) else 1 for v in row)


def _header_row(rows: list) -> int:
    """Index of the header row among the first rows: wide, mostly text, followed by data-looking rows."""
    scan = rows[:HEADER_SCAN]
    if not scan:
        return 0
    widest = max(_row_width(r) for r in scan) or 1
    for i, r in enumerate(scan):
        w = _row_width(r)
        if w < max(2, 0.5 * widest):
            continue
        filled = [v for v in r if not _blank(v)]
        if sum(_is_text(v) for v in filled) / len(filled) < 0.7:
            continue
        nxt = [x for x in rows[i + 1:i + 6] if _row_width(x)]
        if not nxt:
            return i
        # Data below: most following rows hold a number / date, or they're about as wide.
        datay = sum(1 for x in nxt if any(not _blank(v) and not _is_text(v) for v in x))
        if datay >= max(1, len(nxt) // 2) or all(_row_width(x) >= 0.5 * w for x in nxt):
            return i
    return 0


def _clean_name(v, k: int) -> str:
    if isinstance(v, float) and v == v and v.is_integer():
        return str(int(v))
    s = re.sub(r"\s+", " ", str(v)).strip() if not _blank(v) else ""
    return s or f"Column {k + 1}"


def _to_number(v):
    """'Rp 1.250.000' → 1250000, '45%' → 45, '1,234.5' → 1234.5, '(200)' → -200; anything else unchanged."""
    if not isinstance(v, str) or not _NUMERIC_TEXT.match(v):
        return v
    raw = v.strip().lower()
    neg = (raw.startswith("(") and raw.endswith(")")) or raw.lstrip("( ").startswith("-")
    s, mult = raw.strip("() "), 1.0
    for suf, m in (("bn", 1e9), ("jt", 1e6), ("rb", 1e3), ("k", 1e3), ("m", 1e6)):
        if s.rstrip("% ").endswith(suf):
            mult, s = m, s.rstrip("% ")[: -len(suf)]
            break
    s = re.sub(r"(rp\.?|idr|usd|s\$|\$|€|£|rm|%|[+\-\s])", "", s)
    if not s or not re.search(r"\d", s):
        return v
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif s.count(".") > 1 or (s.count(".") == 1 and len(s.split(".")[1]) == 3 and "rp" in raw):
        s = s.replace(".", "")                                   # Indonesian thousands: 1.250.000
    elif s.count(",") > 1 or (s.count(",") == 1 and len(s.split(",")[1]) == 3):
        s = s.replace(",", "")                                   # 1,250,000
    else:
        s = s.replace(",", ".")                                  # 63,5 → 63.5
    try:
        n = float(s) * mult
    except ValueError:
        return v
    return -n if neg else n


def _join_header(a, b) -> str:
    """Top label + sub label of a two-row header, without saying the same word twice:
    'Amount'/'Net' → 'Amount Net', 'Order'/'Order ID' → 'Order ID', 'Store'/'Store' → 'Store'."""
    a = "" if _blank(a) else re.sub(r"\s+", " ", str(a)).strip()
    b = "" if _blank(b) else re.sub(r"\s+", " ", str(b)).strip()
    if not a or not b:
        return a or b
    la, lb = a.lower(), b.lower()
    if la == lb or lb.startswith(la + " ") or lb.startswith(la) and len(lb) > len(la) and not lb[len(la)].isalnum():
        return b
    if la.endswith(" " + lb):
        return a
    return f"{a} {b}"


_DATE_TEXT = re.compile(r"^\s*(\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})\s*$")


def _blocks(rows: list, start: int) -> list:
    """Split rows from `start` into blocks separated by 2+ blank rows: [(first_row_index, [rows])]."""
    out, cur, cur_start, gap = [], [], start, 0
    for k in range(start, len(rows)):
        r = rows[k]
        if not _row_width(r):
            gap += 1
            continue
        if gap >= 2 and cur:
            out.append((cur_start, cur))
            cur, cur_start = [], k
        if not cur:
            cur_start = k
        gap = 0
        cur.append(r)
    if cur:
        out.append((cur_start, cur))
    return out


def _sheet_from_rows(name: str, rows: list, hidden: bool = False, merged_header: Optional[dict] = None) -> dict:
    import pandas as pd
    notes = ["hidden sheet"] if hidden else []
    rows = [list(r) for r in rows[:MAX_ROWS + HEADER_SCAN]]
    width = max((len(r) for r in rows), default=0)
    rows = [r + [None] * (width - len(r)) for r in rows]
    if merged_header:                                            # merged header cells: value across the span
        for ri, cols in merged_header.items():
            if ri < len(rows):
                for j, v in cols.items():
                    if j < width and _blank(rows[ri][j]):
                        rows[ri][j] = v
    keep = [j for j in range(width) if any(not _blank(r[j]) for r in rows[:5000])]
    rows = [[r[j] for j in keep] for r in rows]
    nonempty = [r for r in rows if _row_width(r)]
    if not nonempty:
        return {"sheet": name, "kind": "empty", "df": None, "notes": notes + ["empty sheet"], "title": "", "header_row": 0}
    # Text-only sheets (instructions, notes, a cover page)
    if max(_row_width(r) for r in nonempty) <= 2 and all(all(_blank(v) or _is_text(v) for v in r) for r in nonempty[:50]):
        text = "\n".join(" ".join(str(v) for v in r if not _blank(v)) for r in nonempty[:80])
        return {"sheet": name, "kind": "text", "df": None, "text": text[:3000], "notes": notes, "title": "", "header_row": 0}

    first = next(i for i, r in enumerate(rows) if _row_width(r))
    h = first + _header_row(rows[first:])
    title = " · ".join(" ".join(str(v) for v in r if not _blank(v)) for r in rows[first:h] if _row_width(r))[:300]
    header = list(rows[h])
    data_start = h + 1
    # Two-row header: a second all-text row right below, above the data ("Q1" / "Sales").
    if data_start < len(rows):
        sub = rows[data_start]
        filled = [v for v in sub if not _blank(v)]
        below = [x for x in rows[data_start + 1:data_start + 4] if _row_width(x)]
        # Columns under a merged / repeated top label ("Sales" over "Net" | "Gross").
        spanned = {j for j in range(len(header)) if not _blank(header[j]) and
                   ((j + 1 < len(header) and header[j + 1] == header[j]) or (j > 0 and header[j - 1] == header[j]))}
        under_span = any(not _blank(sub[j]) for j in spanned)
        if filled and all(_is_text(v) for v in filled) and (under_span or len(filled) >= 0.5 * _row_width(rows[h])) and \
                below and any(any(not _blank(v) and not _is_text(v) for v in x) for x in below):
            last = None
            for j in range(len(header)):                         # a top label spans the blank cells to its right
                if not _blank(header[j]):
                    last = header[j]
                elif last is not None and not _blank(sub[j]):
                    header[j] = last
            header = [_join_header(a, b) for a, b in zip(header, sub)]
            data_start += 1
            notes.append("two-row header combined")
    cols, seen = [], {}
    for k, v in enumerate(header):
        c = _clean_name(v, k)
        seen[c] = seen.get(c, 0) + 1
        cols.append(c if seen[c] == 1 else f"{c} ({seen[c]})")
    if h > first:
        notes.append(f"header is on row {h + 1} (rows above it are a title)")

    # The first block is this table; anything after 2+ blank rows is a further table (or notes) on the same sheet,
    # read on its own by read_workbook so nothing in the file is skipped.
    parts = _blocks(rows, data_start)
    body = parts[0][1] if parts else []
    more = [(k, block) for k, block in parts[1:]]
    if more:
        notes.append(f"{len(more)} more block(s) after a gap on this sheet, read as their own table(s)")
    totals = [r for r in body if any(isinstance(v, str) and _TOTAL.match(v) for v in r[:2])]
    if totals:
        tid = {id(r) for r in totals}
        body = [r for r in body if id(r) not in tid]
        notes.append(f"{len(totals)} total/subtotal row(s) removed so sums aren't counted twice")

    df = pd.DataFrame(body, columns=cols)
    converted = []
    for c in df.columns:
        s = df[c]
        if s.dtype != object:
            continue
        vals = s.dropna()
        is_str = vals.map(lambda v: isinstance(v, str))
        if not len(vals) or not is_str.any():
            continue
        conv = vals.map(_to_number)
        if conv.map(lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)).mean() >= 0.9:
            df[c] = pd.to_numeric(s.map(_to_number), errors="coerce")
            if is_str.mean() > 0.3:
                converted.append(str(c))
    if converted:
        notes.append("numbers stored as text converted: " + ", ".join(converted[:8]))
    # Dates typed as text ("2025-03-14", "14/03/2025"): real dates, so periods and trends work.
    dated = []
    for c in df.columns:
        s = df[c]
        if s.dtype != object:
            continue
        vals = s.dropna()
        if len(vals) < 2 or not vals.map(lambda v: isinstance(v, str) and bool(_DATE_TEXT.match(v))).mean() >= 0.9:
            continue
        iso = vals.astype(str).str.match(r"^\s*\d{4}-").mean() >= 0.9
        parsed = pd.to_datetime(s.where(s.map(lambda v: isinstance(v, str))), errors="coerce", dayfirst=not iso)
        if parsed.notna().sum() >= 0.9 * len(vals):
            df[c] = parsed
            dated.append(str(c))
    if dated:
        notes.append("dates stored as text converted: " + ", ".join(dated[:8]))
    df = df.dropna(axis=1, how="all")
    return {"sheet": name, "kind": "table" if len(df) else "empty", "df": df, "notes": notes, "title": title,
            "header_row": h + 1, "more": more}


def read_workbook(src: Union[str, Path, bytes], max_sheets: int = MAX_SHEETS) -> list:
    """Every sheet → {sheet, kind: table|text|empty, df, title, header_row, notes, [text]}."""
    data = bytes(src) if isinstance(src, (bytes, bytearray)) else Path(src).read_bytes()
    try:
        from openpyxl import load_workbook
        big = len(data) > 15 * 1024 * 1024                       # read-only mode: fast, but no merged-cell info
        wb = load_workbook(io.BytesIO(data), data_only=True, read_only=big)
        out = []
        for ws in wb.worksheets[:max_sheets]:
            merged = {}
            if not big:
                for rng in ws.merged_cells.ranges:
                    if rng.max_row - rng.min_row > 2:            # only header-like (short) merges
                        continue
                    tl = ws.cell(rng.min_row, rng.min_col).value
                    for c in range(rng.min_col, rng.max_col + 1):
                        merged.setdefault(rng.min_row - 1, {})[c - 1] = tl
            rows = [list(r) for r in ws.iter_rows(values_only=True)]
            out += _with_more(_sheet_from_rows(ws.title, rows, hidden=ws.sheet_state != "visible", merged_header=merged))
        if len(wb.worksheets) > max_sheets:
            out.append({"sheet": f"(+{len(wb.worksheets) - max_sheets} more sheets)", "kind": "empty", "df": None,
                        "notes": [f"only the first {max_sheets} sheets were read"], "title": "", "header_row": 0})
        return out
    except Exception:
        pass
    import pandas as pd                                          # .xls (xlrd) or anything openpyxl can't open
    out = []
    for name, raw in list(pd.read_excel(io.BytesIO(data), sheet_name=None, header=None).items())[:max_sheets]:
        out += _with_more(_sheet_from_rows(str(name), raw.astype(object).where(raw.notna(), None).values.tolist()))
    return out


def _with_more(sheet: dict) -> list:
    """A sheet plus the further tables / note blocks found below it after a gap ("Staff (table 2)")."""
    out = [sheet]
    for n, (k, block) in enumerate(sheet.pop("more", None) or [], start=2):
        extra = _sheet_from_rows(f"{sheet['sheet']} (table {n})", block)
        extra.pop("more", None)
        extra["notes"] = [f"found below the first table on sheet '{sheet['sheet']}', starting at row {k + 1}"] + extra["notes"]
        out.append(extra)
    return out


def tables(sheets: list) -> list:
    return [s for s in sheets if s["kind"] == "table" and s.get("df") is not None and len(s["df"].columns)]


def main_table(sheets: list):
    """The biggest data sheet (for features that take one table, e.g. Model lab scoring)."""
    ts = tables(sheets)
    return max(ts, key=lambda s: s["df"].size) if ts else None


# ── Understanding ────────────────────────────────────────────────────────────

def _norm(c) -> str:
    return re.sub(r"[^a-z0-9]", "", str(c).lower())


def relationships(sheets: list) -> list:
    """Columns that link two sheets: same/similar name and ≥ 60% of the smaller side's values in the other."""
    ts = tables(sheets)
    out = []
    for i, a in enumerate(ts):
        for b in ts[i + 1:]:
            for ca in a["df"].columns:
                for cb in b["df"].columns:
                    na, nb = _norm(ca), _norm(cb)
                    if not na or not (na == nb or (len(na) > 3 and len(nb) > 3 and (na in nb or nb in na))):
                        continue
                    va = set(map(str, a["df"][ca].dropna().unique()[:5000]))
                    vb = set(map(str, b["df"][cb].dropna().unique()[:5000]))
                    small = min(len(va), len(vb))
                    if small < 2:
                        continue
                    match = len(va & vb) / small
                    if match >= 0.6:
                        out.append({"a": a["sheet"], "a_col": str(ca), "b": b["sheet"], "b_col": str(cb),
                                    "match": round(match * 100), "a_unique": len(va), "b_unique": len(vb)})
    return out[:30]


def _col_line(df, c) -> str:
    import pandas as pd
    s = df[c]
    nn = s.dropna()
    miss = f"{s.isna().mean() * 100:.0f}% blank" if s.isna().any() else "no blanks"
    if pd.api.types.is_numeric_dtype(s) and len(nn):
        return f"{c}: number {nn.min():,.4g}…{nn.max():,.4g}, sum {nn.sum():,.6g}, {nn.nunique()} distinct, {miss}"
    if pd.api.types.is_datetime64_any_dtype(s) and len(nn):
        return f"{c}: date {nn.min():%Y-%m-%d}…{nn.max():%Y-%m-%d}, {miss}"
    top = ", ".join(str(v)[:30] for v in nn.astype(str).value_counts().head(5).index)
    return f"{c}: text, {nn.nunique()} distinct, {miss}; e.g. {top}"


def profile(sheets: list, filename: str = "") -> str:
    """Deterministic description of the workbook (also the fallback guide)."""
    lines = [f"Workbook {filename}: {len(sheets)} sheet(s)."]
    for s in sheets:
        if s["kind"] == "table":
            df = s["df"]
            lines.append(f"\nSheet '{s['sheet']}': {len(df):,} rows × {len(df.columns)} columns"
                         + (f"; title: {s['title']}" if s.get("title") else "")
                         + (f"; notes: {'; '.join(s['notes'])}" if s["notes"] else ""))
            lines += [f"  - {_col_line(df, c)}" for c in list(df.columns)[:40]]
            if len(df.columns) > 40:
                lines.append(f"  - … {len(df.columns) - 40} more columns")
        elif s["kind"] == "text":
            lines.append(f"\nSheet '{s['sheet']}' (text, no table): {s.get('text', '')[:600]}")
        else:
            lines.append(f"\nSheet '{s['sheet']}': {'; '.join(s['notes']) or 'empty'}")
    rel = relationships(sheets)
    if rel:
        lines.append("\nLinks between sheets:")
        lines += [f"  - '{r['a']}'.{r['a_col']} ↔ '{r['b']}'.{r['b_col']} ({r['match']}% of values match)" for r in rel]
    return "\n".join(lines)


_TOOL = {"name": "workbook_guide", "description": "Explain the workbook for the analyst who will use it.",
         "input_schema": {"type": "object", "properties": {
             "sheets": {"type": "array", "items": {"type": "object", "properties": {
                 "sheet": {"type": "string"},
                 "purpose": {"type": "string", "description": "What this sheet is (e.g. 'order lines, one per product per order')."},
                 "grain": {"type": "string", "description": "What ONE row means."},
                 "keys": {"type": "array", "items": {"type": "string"}, "description": "Identifier / join columns."},
                 "measures": {"type": "array", "items": {"type": "string"},
                              "description": "Numeric columns to sum/average, with units/currency."},
                 "caveats": {"type": "string", "description": "Anything that would make an analysis wrong: totals rows, "
                             "units, mixed periods, codes needing a lookup sheet, duplicates, blanks."}},
                 "required": ["sheet", "purpose", "grain"]}},
             "relationships": {"type": "array", "items": {"type": "string"},
                               "description": "How sheets join, e.g. \"Sales.store_id → Stores.store_id (many-to-one)\"."},
             "how_to_use": {"type": "string", "description": "Which sheet(s) answer which kind of question, and pitfalls."}},
             "required": ["sheets", "how_to_use"]}}


def _guide_text(g: dict, filename: str) -> str:
    lines = [f"WORKBOOK GUIDE for {filename} (read before analysing):"]
    for s in g.get("sheets", []):
        grain = re.sub(r"^\s*(one\s+row\s*(=|is|means)?\s*)", "", str(s.get("grain") or "?"), flags=re.I).rstrip(". ")
        purpose = str(s.get("purpose") or "").strip()
        purpose = purpose if not purpose or purpose.endswith(".") else purpose + "."
        lines.append(f"- Sheet '{s.get('sheet')}': {purpose} One row = {grain}."
                     + (f" Keys: {', '.join(s['keys'])}." if s.get("keys") else "")
                     + (f" Measures: {', '.join(s['measures'])}." if s.get("measures") else "")
                     + (f" Caveats: {s['caveats']}" if s.get("caveats") else ""))
    if g.get("relationships"):
        lines.append("- Joins: " + "; ".join(g["relationships"]))
    if g.get("how_to_use"):
        lines.append("- How to use: " + g["how_to_use"])
    return "\n".join(lines)


def understand(src: Union[str, Path, bytes], filename: str = "workbook.xlsx", sheets: Optional[list] = None) -> dict:
    """{"guide": text for Claude prompts, "profile": deterministic description, "sheets": [{sheet, kind, rows,
    columns, header_row, title, notes}], "relationships": [...]} — cached per file content."""
    data = bytes(src) if isinstance(src, (bytes, bytearray)) else Path(src).read_bytes()
    sha = hashlib.sha256(data).hexdigest()[:24]
    cache = CACHE / f"{sha}-v2.json"          # v2: further tables on a sheet, cleaner two-row headers, text dates
    if cache.is_file():
        try:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            cached["guide"] = cached["guide"].replace(cached.get("filename", filename), filename)
            return cached
        except Exception:
            pass
    sheets = sheets if sheets is not None else read_workbook(data)
    prof = profile(sheets, filename)
    guide = ""
    try:
        from config import ANTHROPIC_MODEL, CLAUDE_THINKING, anthropic_client
        from tools.llm_guard import redact_text
        from tools.llm_security import FENCE_RULE, clean_output, fence
        if anthropic_client is None:
            raise RuntimeError("no Claude client")
        samples = [f"Sheet '{s['sheet']}' first rows: " + json.dumps(s["df"].head(4).astype(str).values.tolist(),
                                                                       ensure_ascii=False)[:800]
                   for s in tables(sheets)[:MAX_SHEETS]]
        resp = anthropic_client.messages.create(
            model=ANTHROPIC_MODEL, max_tokens=4000, thinking=CLAUDE_THINKING,
            system=("You are a senior data analyst onboarding a new Excel workbook. Explain every sheet so another "
                    "analyst can use the workbook WITHOUT mistakes: what each sheet is, what one row means, keys, "
                    "measures (with units/currency), caveats (totals rows, codes that need a lookup sheet, mixed "
                    "periods, duplicates), how sheets join, and which sheet answers which question. Be concise and "
                    "factual; never invent columns or numbers. " + FENCE_RULE),
            tools=[_TOOL], tool_choice={"type": "tool", "name": "workbook_guide"},
            messages=[{"role": "user", "content": fence(redact_text(prof + "\n\n" + "\n".join(samples))[0][:30000], "workbook")}])
        block = next((b for b in resp.content if getattr(b, "type", "") == "tool_use"), None)
        if block:
            guide = clean_output(_guide_text(dict(block.input), filename))[:6000]
    except Exception:
        guide = ""
    result = {
        "filename": filename,
        "guide": guide or ("WORKBOOK STRUCTURE (read every sheet before analysing):\n" + prof[:6000]),
        "profile": prof[:12000],
        "sheets": [{"sheet": s["sheet"], "kind": s["kind"], "rows": int(len(s["df"])) if s.get("df") is not None else 0,
                    "columns": [str(c) for c in s["df"].columns][:200] if s.get("df") is not None else [],
                    "header_row": s.get("header_row", 0), "title": s.get("title", ""), "notes": s["notes"]}
                   for s in sheets],
        "relationships": relationships(sheets),
    }
    if guide:                                                    # don't cache the fallback: retry Claude next time
        try:
            CACHE.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(result, ensure_ascii=False, default=str), encoding="utf-8")
        except Exception:
            pass
    return result
