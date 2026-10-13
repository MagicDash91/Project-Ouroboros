"""
features/share.py – read-only share links (with optional comments) for decks, documents and the Pinboard.

A link is an unguessable token (/share/<token> in the web app). Anyone who has it can view the
latest saved version — the token IS the permission, so links can expire and can be revoked.
Viewers may leave comments when the owner allowed it (name + text, rate-limited; comments are
never sent to an AI). The app runs on the owner's computer, so a link works for people who can
reach that computer (same network, or once the app is deployed).

Storage: data/shares/shares.json (links) and data/shares/comments/<token>.json.
"""

import json
import re
import secrets
import socket
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARE_DIR = ROOT / "data" / "shares"
LINKS = SHARE_DIR / "shares.json"
COMMENTS = SHARE_DIR / "comments"
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{20,40}$")
_lock = threading.Lock()
_recent: dict = {}                      # token -> [timestamps] for comment rate limiting


class ShareError(ValueError):
    pass


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _read(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write(path: Path, data):
    from features.agent import _replace
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    _replace(tmp, path)


def create(source: dict, title: str, expires_days: int = 0, allow_comments: bool = True) -> dict:
    """source: {"type": "deck"|"doc", "ref": studio ref} or {"type": "pinboard"}."""
    if source.get("type") not in ("deck", "doc", "pinboard"):
        raise ShareError("Unknown thing to share.")
    days = int(expires_days or 0)
    if days not in (0, 1, 7, 30, 90):
        raise ShareError("Links can last 1, 7, 30 or 90 days, or not expire.")
    link = {"token": secrets.token_urlsafe(18), "source": source, "title": str(title or "Shared")[:200],
            "created_at": _now(),
            "expires_at": (datetime.now() + timedelta(days=days)).isoformat(timespec="seconds") if days else None,
            "allow_comments": bool(allow_comments), "revoked": False, "views": 0}
    with _lock:
        _write(LINKS, _read(LINKS, []) + [link])
    return link


def list_for(source: dict) -> list:
    """Links for one deck / document / the pinboard, newest first, with their comments."""
    return [{**link, "comment_list": _read(COMMENTS / f"{link['token']}.json", [])}
            for link in reversed(_read(LINKS, [])) if link["source"] == source]


def revoke(token: str) -> None:
    with _lock:
        links = _read(LINKS, [])
        for link in links:
            if link["token"] == token:
                link["revoked"] = True
        _write(LINKS, links)


def _live(token: str) -> dict:
    if not _TOKEN.match(token or ""):
        raise FileNotFoundError("This link isn't valid.")
    link = next((x for x in _read(LINKS, []) if x["token"] == token), None)
    if not link or link.get("revoked"):
        raise FileNotFoundError("This link has been turned off by its owner.")
    if link.get("expires_at") and datetime.fromisoformat(link["expires_at"]) < datetime.now():
        raise FileNotFoundError("This link has expired.")
    return link


def view(token: str) -> dict:
    """What a viewer sees: the latest saved deck / document (with its brand kit) or the pinboard."""
    from features import brand
    link = _live(token)
    src = link["source"]
    out = {"type": src["type"], "title": link["title"], "allow_comments": link["allow_comments"],
           "comments": _read(COMMENTS / f"{token}.json", []), "expires_at": link.get("expires_at")}
    if src["type"] in ("deck", "doc"):
        from features import studio
        data = studio.get(src["ref"], src["type"])
        data = {k: v for k, v in data.items() if k not in ("source_sig", "note")}
        out.update(data=data, brand=brand.get(data.get("brand_id")), title=data.get("title") or link["title"])
    else:
        from features import data_chat
        out["pins"] = [{k: p.get(k) for k in ("id", "question", "chat", "kind", "chart", "table", "refreshed_at", "created_at")}
                       for p in data_chat.list_pins()]
    with _lock:
        links = _read(LINKS, [])
        for x in links:
            if x["token"] == token:
                x["views"] = x.get("views", 0) + 1
        _write(LINKS, links)
    return out


def comment(token: str, name: str, text: str, target: str = "") -> dict:
    link = _live(token)
    if not link.get("allow_comments"):
        raise ShareError("Comments are turned off for this link.")
    name, text = str(name or "").strip()[:60], str(text or "").strip()[:1000]
    if not name or not text:
        raise ShareError("Add your name and a comment.")
    now = time.time()
    hits = [t for t in _recent.get(token, []) if now - t < 60]
    if len(hits) >= 20:
        raise ShareError("Too many comments in a minute; try again shortly.")
    _recent[token] = hits + [now]
    c = {"id": uuid.uuid4().hex[:10], "name": name, "text": text, "target": str(target or "")[:20], "created_at": _now()}
    with _lock:
        path = COMMENTS / f"{token}.json"
        _write(path, (_read(path, []) + [c])[-500:])
    return c


def network_addresses() -> list:
    """This computer's LAN addresses, so the owner can give a link that works for people on the same network."""
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))                  # no packet is sent; picks the outbound interface
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith(("127.", "169.254.")))
