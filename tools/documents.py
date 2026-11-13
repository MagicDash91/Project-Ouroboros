"""
tools/documents.py – turn an uploaded document into text an agent can read, plus a short overview.

Used by the Agent when someone attaches their own files (features/agent.py). The original file stays in the
workspace; the extracted text goes next to it as <name>.txt so the agent's read_file tool can page through it.

  PDF         page by page ("[Page 3]"), with tables found by pdfplumber as pipe tables
  Word .docx  headings marked (#, ##), paragraphs, and tables, in document order
  PowerPoint  slide by slide ("[Slide 4] title"), every text box, tables, charts' data and the speaker notes
  .txt .md    as is;  .html .htm  visible text;  .rtf  control words stripped;  .json  pretty-printed

`overview(name, doc)` is the deterministic guide the agent reads before planning: pages / slides,
headings or slide titles, length, and whether the text looks empty (e.g. a scanned PDF).
"""

import json
import re
from pathlib import Path

DOCUMENT_EXTS = (".pdf", ".docx", ".pptx", ".txt", ".md", ".markdown", ".html", ".htm", ".rtf", ".json")
OLD_OFFICE = {".doc": ".docx", ".ppt": ".pptx"}
MAX_CHARS = 2_000_000


class DocumentError(ValueError):
    pass


def _table_md(rows: list) -> str:
    rows = [["" if c is None else re.sub(r"\s+", " ", str(c)).strip() for c in r] for r in rows if r]
    rows = [r for r in rows if any(r)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    out = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    out += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(out)


def _pdf(path: Path) -> tuple:
    parts, pages = [], 0
    try:
        import pdfplumber
        with pdfplumber.open(str(path)) as pdf:
            pages = len(pdf.pages)
            for i, page in enumerate(pdf.pages, 1):
                text = page.extract_text() or ""
                tables = []
                try:
                    tables = [t for t in (_table_md(tb) for tb in page.extract_tables()) if t]
                except Exception:
                    pass
                if text.strip() or tables:
                    parts.append(f"[Page {i}]\n{text.strip()}" + ("\n\n" + "\n\n".join(tables) if tables else ""))
    except Exception:
        parts = []
    if not parts:
        try:
            import pypdf
            r = pypdf.PdfReader(str(path))
            pages = len(r.pages)
            parts = [f"[Page {i}]\n{(p.extract_text() or '').strip()}" for i, p in enumerate(r.pages, 1)
                     if (p.extract_text() or "").strip()]
        except Exception as e:
            raise DocumentError(f"couldn't open the PDF ({str(e).splitlines()[0][:120]})")
    return "\n\n".join(parts), {"pages": pages}


def _docx(path: Path) -> tuple:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    doc = Document(str(path))
    parts, headings, tables = [], [], 0
    for block in doc.element.body.iterchildren():               # paragraphs and tables in document order
        tag = block.tag.rsplit("}", 1)[-1]
        if tag == "p":
            p = Paragraph(block, doc)
            text = p.text.strip()
            if not text:
                continue
            style = (p.style.name if p.style is not None else "") or ""
            m = re.match(r"Heading (\d)", style)
            if m or style == "Title":
                level = int(m.group(1)) if m else 1
                headings.append(text)
                parts.append("#" * min(level, 4) + " " + text)
            elif "List" in style:
                parts.append("- " + text)
            else:
                parts.append(text)
        elif tag == "tbl":
            t = Table(block, doc)
            md = _table_md([[c.text for c in row.cells] for row in t.rows])
            if md:
                tables += 1
                parts.append(md)
    return "\n\n".join(parts), {"headings": headings, "tables": tables}


def _pptx(path: Path) -> tuple:
    from pptx import Presentation
    prs = Presentation(str(path))
    parts, titles, notes_count, tables = [], [], 0, 0
    for i, slide in enumerate(prs.slides, 1):
        title = ""
        try:
            if slide.shapes.title is not None and slide.shapes.title.has_text_frame:
                title = slide.shapes.title.text_frame.text.strip()
        except Exception:
            pass
        body = []

        def walk(shapes):
            nonlocal tables
            for sh in shapes:
                if getattr(sh, "shape_type", None) == 6 and hasattr(sh, "shapes"):     # a group of shapes
                    walk(sh.shapes)
                    continue
                if getattr(sh, "has_table", False) and sh.has_table:
                    md = _table_md([[c.text for c in row.cells] for row in sh.table.rows])
                    if md:
                        tables += 1
                        body.append(md)
                elif getattr(sh, "has_chart", False) and sh.has_chart:
                    try:
                        ch = sh.chart
                        name = ch.chart_title.text_frame.text.strip() if ch.has_title else ""
                        plot = ch.plots[0]
                        series = "; ".join(f"{s.name}: {list(s.values)}" for s in plot.series)
                        body.append(f"[Chart{': ' + name if name else ''}] categories {list(plot.categories)}; {series}")
                    except Exception:
                        body.append("[Chart]")
                elif getattr(sh, "has_text_frame", False) and sh.has_text_frame:
                    txt = sh.text_frame.text.strip()
                    if txt and txt != title:
                        body.append(txt)

        walk(slide.shapes)
        note = ""
        try:
            if slide.has_notes_slide:
                note = slide.notes_slide.notes_text_frame.text.strip()
        except Exception:
            pass
        if note:
            notes_count += 1
        titles.append(title or f"(slide {i}, no title)")
        parts.append(f"[Slide {i}] {title}".rstrip() + ("\n" + "\n".join(body) if body else "")
                     + (f"\nSpeaker notes: {note}" if note else ""))
    return "\n\n".join(parts), {"slides": len(prs.slides), "titles": titles, "notes": notes_count, "tables": tables}


def _html(path: Path) -> tuple:
    raw = path.read_bytes().decode("utf-8", errors="replace")
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(raw, "html.parser")
        for tag in soup(["script", "style", "noscript"]):
            tag.decompose()
        title = soup.title.get_text(strip=True) if soup.title else ""
        headings = [h.get_text(" ", strip=True) for h in soup.find_all(["h1", "h2", "h3"])][:40]
        text = soup.get_text("\n")
    except Exception:
        title, headings, text = "", [], re.sub(r"<[^>]+>", " ", raw)
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    return text, {"title": title, "headings": headings}


def _rtf(path: Path) -> tuple:
    raw = path.read_bytes().decode("latin-1", errors="replace")
    raw = re.sub(r"\\par[d]?\b", "\n", raw)
    raw = re.sub(r"\{\\\*[^{}]*\}|\\[a-zA-Z]+-?\d* ?|\\'[0-9a-f]{2}|[{}]", "", raw)
    return re.sub(r"\n\s*\n+", "\n\n", raw).strip(), {}


def extract(path) -> dict:
    """{"kind": pdf|word|powerpoint|text|html|json|rtf, "text": str, "meta": {...}} for a document file."""
    p = Path(path)
    ext = p.suffix.lower()
    if ext in OLD_OFFICE:
        raise DocumentError(f"{p.name} is an old {ext} file: open it in Office, save it as {OLD_OFFICE[ext]} and attach it again")
    try:
        if ext == ".pdf":
            kind, (text, meta) = "pdf", _pdf(p)
        elif ext == ".docx":
            kind, (text, meta) = "word", _docx(p)
        elif ext == ".pptx":
            kind, (text, meta) = "powerpoint", _pptx(p)
        elif ext in (".html", ".htm"):
            kind, (text, meta) = "html", _html(p)
        elif ext == ".rtf":
            kind, (text, meta) = "rtf", _rtf(p)
        elif ext == ".json":
            raw = p.read_bytes().decode("utf-8-sig", errors="replace")
            try:
                text = json.dumps(json.loads(raw), indent=2, ensure_ascii=False)
            except ValueError:
                text = raw
            kind, meta = "json", {}
        elif ext in (".txt", ".md", ".markdown"):
            kind, text, meta = "text", p.read_bytes().decode("utf-8-sig", errors="replace"), {}
        else:
            raise DocumentError(f"{p.name}: {ext or 'this'} files can't be read as a document")
    except DocumentError:
        raise
    except Exception as e:
        raise DocumentError(f"couldn't read {p.name} ({str(e).splitlines()[0][:150]})")
    return {"kind": kind, "text": text[:MAX_CHARS], "meta": meta}


def overview(name: str, doc: dict) -> str:
    """What the agent is told about a document before planning (no AI call)."""
    kind, text, meta = doc["kind"], doc["text"], doc.get("meta") or {}
    words = len(text.split())
    label = {"pdf": "PDF", "word": "Word document", "powerpoint": "PowerPoint deck", "html": "web page",
             "json": "JSON file", "rtf": "RTF document"}.get(kind, "text file")
    size = []
    if meta.get("pages"):
        size.append(f"{meta['pages']} pages")
    if meta.get("slides"):
        size.append(f"{meta['slides']} slides")
    size.append(f"about {words:,} words")
    lines = [f"DOCUMENT {name}: {label}, {', '.join(size)}."]
    if meta.get("title"):
        lines.append(f"Title: {meta['title']}")
    if meta.get("titles"):
        lines.append("Slide titles: " + " | ".join(f"{i}. {t}" for i, t in enumerate(meta["titles"][:40], 1)))
    if meta.get("headings"):
        lines.append("Headings: " + " | ".join(meta["headings"][:40]))
    if meta.get("tables"):
        lines.append(f"Contains {meta['tables']} table(s), kept as pipe tables in the text.")
    if meta.get("notes"):
        lines.append(f"{meta['notes']} slide(s) have speaker notes (included).")
    if kind == "pdf" and meta.get("pages") and words < 6 * meta["pages"]:
        lines.append("Very little text could be extracted: it may be a scanned PDF (pictures of pages).")
    start = re.sub(r"\s+", " ", text[:700]).strip()
    if start:
        lines.append(f"Starts with: {start}{'…' if len(text) > 700 else ''}")
    return "\n".join(lines)
