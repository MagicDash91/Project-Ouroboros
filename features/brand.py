"""
features/brand.py – brand kits for decks and documents (Studio).

A kit has a name, four colours (accent, dark, background, text), a heading and a body font, an
optional logo and footer text. One kit can be the default for new decks and documents. The
Studio applies a kit on screen (CSS variables) and in every export (.pptx / .docx / .pdf).

Kits live in data/brand/kits.json; logos in outputs/brand/ (served, so slides can show them).
"""

import io
import json
import re
import threading
import uuid
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
KITS_FILE = ROOT / "data" / "brand" / "kits.json"
LOGO_DIR = ROOT / "outputs" / "brand"
FONTS = ["Georgia", "Garamond", "Times New Roman", "Palatino Linotype", "Calibri", "Arial", "Helvetica",
         "Segoe UI", "Trebuchet MS", "Verdana", "Tahoma", "Century Gothic", "Franklin Gothic Medium"]
DEFAULT = {"id": "ouroboros", "name": "Ouroboros", "accent": "#ce401b", "dark": "#181613", "background": "#f3efe7",
           "text": "#181613", "heading_font": "Georgia", "body_font": "Calibri", "logo": "", "footer": "",
           "default": False, "builtin": True}
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_ID = re.compile(r"^[a-f0-9]{10}$")
_lock = threading.Lock()


class BrandError(ValueError):
    pass


def _read() -> list:
    try:
        return json.loads(KITS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _write(kits: list):
    from features.agent import _replace
    KITS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = KITS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(kits, ensure_ascii=False), encoding="utf-8")
    _replace(tmp, KITS_FILE)


def list_kits() -> list:
    kits = _read()
    return [{**DEFAULT, "default": not any(k.get("default") for k in kits)}] + kits


def get(kit_id: Optional[str]) -> dict:
    """The kit with this id, else the default kit, else Ouroboros."""
    kits = list_kits()
    return next((k for k in kits if k["id"] == kit_id), None) or next(k for k in kits if k["default"])


def default_id() -> str:
    return get(None)["id"]


def save_kit(data: dict) -> dict:
    name = str(data.get("name") or "").strip()[:60]
    if not name:
        raise BrandError("Give the brand kit a name.")
    kit = {"name": name}
    for k in ("accent", "dark", "background", "text"):
        v = str(data.get(k) or DEFAULT[k]).strip()
        if not _HEX.match(v):
            raise BrandError(f"{k.title()} must be a colour like #1a2b3c.")
        kit[k] = v.lower()
    for k in ("heading_font", "body_font"):
        v = str(data.get(k) or DEFAULT[k])
        if v not in FONTS:
            raise BrandError(f"Pick a font from the list ({', '.join(FONTS)}).")
        kit[k] = v
    kit["footer"] = str(data.get("footer") or "").strip()[:80]
    with _lock:
        kits = _read()
        kid = str(data.get("id") or "")
        old = next((k for k in kits if k["id"] == kid), None) if _ID.match(kid) else None
        kit["id"] = old["id"] if old else uuid.uuid4().hex[:10]
        kit["logo"] = old.get("logo", "") if old else ""
        kit["default"] = bool(data.get("default"))
        if kit["default"]:
            for k in kits:
                k["default"] = False
        kits = [kit if k["id"] == kit["id"] else k for k in kits] if old else kits + [kit]
        _write(kits)
    return kit


def delete_kit(kit_id: str):
    with _lock:
        kits = _read()
        kit = next((k for k in kits if k["id"] == kit_id), None)
        if kit and kit.get("logo"):
            (ROOT / kit["logo"].lstrip("/")).unlink(missing_ok=True)
        _write([k for k in kits if k["id"] != kit_id])


def set_logo(kit_id: str, filename: str, data: bytes) -> dict:
    ext = Path(filename or "").suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg"):
        raise BrandError("The logo must be a PNG or JPG.")
    if len(data) > 2 * 1024 * 1024:
        raise BrandError("The logo must be under 2 MB.")
    from PIL import Image
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
    except Exception:
        raise BrandError("That file isn't a valid image.")
    with _lock:
        kits = _read()
        kit = next((k for k in kits if k["id"] == kit_id), None)
        if not kit:
            raise BrandError("Save the kit before adding a logo.")
        LOGO_DIR.mkdir(parents=True, exist_ok=True)
        if kit.get("logo"):
            (ROOT / kit["logo"].lstrip("/")).unlink(missing_ok=True)
        name = f"{kit_id}_{uuid.uuid4().hex[:6]}{'.jpg' if ext == '.jpeg' else ext}"
        (LOGO_DIR / name).write_bytes(data)
        kit["logo"] = f"/outputs/brand/{name}"
        _write(kits)
    return kit


# ── Colours for exports ──────────────────────────────────────────────────────

def _rgb(h: str) -> tuple:
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def _mix(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def palette(kit: dict) -> dict:
    """RGB tuples for every role the exports use, derived from the kit's four colours."""
    text, bg = _rgb(kit["text"]), _rgb(kit["background"])
    accent, dark = _rgb(kit["accent"]), _rgb(kit["dark"])
    return {"ink": text, "paper": bg, "sheet": _mix(bg, (255, 255, 255), 0.5), "signal": accent, "dark": dark,
            "graphite": _mix(text, bg, 0.25), "mute": _mix(text, bg, 0.5), "rule": _mix(text, bg, 0.8),
            "series": [accent, _mix(dark, bg, 0.25), _mix(accent, bg, 0.45), _mix(text, bg, 0.35),
                       (120, 140, 160), (180, 150, 120)]}


def logo_path(kit: dict) -> Optional[Path]:
    if not kit.get("logo"):
        return None
    p = (ROOT / kit["logo"].lstrip("/")).resolve()
    return p if LOGO_DIR.resolve() in p.parents and p.is_file() else None
