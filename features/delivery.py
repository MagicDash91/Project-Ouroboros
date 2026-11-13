"""
features/delivery.py – Scheduled Delivery: send a dashboard, report or deck by email, Slack or webhook
every day, week or month.

What can be delivered
  * an Auto Dashboard – its saved queries are re-run (no AI, free), the message lists every KPI with the
    change since the previous delivery, and the dashboard can be attached as PowerPoint and/or Excel;
  * a report or deck from the Studio (Analytics runs and Agent tasks) – attached as PDF / Word / PowerPoint.
    Only items that already exist are offered, so a delivery never pays for building one.

Channels
  * email – SMTP from environment variables only (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD,
    SMTP_FROM; port 465 = SSL, otherwise STARTTLS). Up to 20 recipients, attachments up to 15 MB.
  * Slack / Microsoft Teams incoming webhook – the summary and a link (webhooks can't carry files).
  * webhook – JSON with the summary, KPIs and (under 5 MB) the files base64-encoded.
  Every URL passes the shared SSRF guard (tools/url_guard.py: public https only, no redirects), and
  webhook URLs are secrets: they are masked in every API response.

The scheduler thread checks every 30 seconds; a failed delivery is logged in the schedule's history
and retried at the next slot, not in a loop.
"""

import base64
import json
import os
import re
import smtplib
import ssl
import threading
import time
import uuid
from datetime import datetime, timedelta
from email.message import EmailMessage
from html import escape
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "data" / "delivery" / "schedules.json"
APP_URL = os.getenv("PUBLIC_APP_URL", "http://localhost:3010/app").rstrip("/")
MAX_RECIPIENTS = 20
MAX_ATTACH_BYTES = 15 * 1024 * 1024
MAX_WEBHOOK_FILES = 5 * 1024 * 1024
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_ID = re.compile(r"^[0-9a-f]{12}$")
FORMATS = {"dashboard": ("summary", "pptx", "xlsx"), "doc": ("pdf", "docx"), "deck": ("pptx",)}

_lock = threading.RLock()
_running: set = set()


class DeliveryError(Exception):
    pass


def _now() -> str:
    return datetime.now().isoformat(timespec="minutes")


# ── Storage ───────────────────────────────────────────────────────────────────

def _load_all() -> dict:
    try:
        return json.loads(STORE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_all(data: dict):
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, default=str), encoding="utf-8")
    tmp.replace(STORE)


def _get(sid: str) -> dict:
    if not _ID.match(sid or ""):
        raise DeliveryError("invalid schedule id")
    s = _load_all().get(sid)
    if not s:
        raise FileNotFoundError("schedule not found")
    return s


def _mask(url: str) -> str:
    m = re.match(r"^(https://[^/]+)/(.*)$", url or "")
    return f"{m.group(1)}/…{m.group(2)[-4:]}" if m else ""


def _public(s: dict) -> dict:
    out = {k: v for k, v in s.items() if k != "last_values"}
    ch = dict(s["channel"])
    if ch.get("url"):
        ch["url"] = _mask(ch["url"])
        ch["url_set"] = True
    out["channel"] = ch
    return out


def smtp_configured() -> bool:
    return bool(os.getenv("SMTP_HOST") and os.getenv("SMTP_FROM"))


# ── What can be delivered ─────────────────────────────────────────────────────

def _studio_items() -> list:
    from features import studio
    refs = []
    for p in (ROOT / "data" / "agent").glob("*/task.json"):
        refs.append(f"agent:{p.parent.name}")
    for p in (ROOT / "data" / "tasks").glob("*.json"):
        refs += [f"run:{p.stem}:analytics", f"run:{p.stem}:marketing"]
    out = []
    for ref in refs:
        for kind in ("doc", "deck"):
            try:
                path, _ = studio._paths(ref, kind)
                if not path.is_file():
                    continue
                data = json.loads(path.read_text(encoding="utf-8"))
                out.append({"ref": ref, "kind": kind, "title": studio.plain(data.get("title") or "")[:120] or ref,
                            "updated_at": data.get("updated_at"),
                            "source": "Agent task" if ref.startswith("agent:") else
                            ("Analytics report" if ref.endswith(":analytics") else "Marketing campaign")})
            except Exception:
                continue
    out.sort(key=lambda i: i.get("updated_at") or "", reverse=True)
    return out[:100]


def options() -> dict:
    from features import auto_dashboard
    boards = [{"id": d["id"], "title": d["title"], "updated_at": d.get("updated_at")}
              for d in auto_dashboard.list_dashboards() if d.get("status") == "ready"]
    return {"dashboards": boards, "studio": _studio_items(), "email_configured": smtp_configured(),
            "formats": {k: list(v) for k, v in FORMATS.items()}}


# ── Cadence ───────────────────────────────────────────────────────────────────

def _cadence(c: dict) -> dict:
    every = c.get("every") if c.get("every") in ("day", "week", "month") else "week"
    at = str(c.get("at") or "08:00")
    if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", at):
        raise DeliveryError("Time must be HH:MM, e.g. 08:00.")
    return {"every": every, "at": at, "weekday": int(c.get("weekday") or 0) % 7,
            "monthday": min(max(int(c.get("monthday") or 1), 1), 28)}


def next_run(c: dict, after: Optional[datetime] = None) -> datetime:
    now = after or datetime.now()
    hh, mm = map(int, c["at"].split(":"))
    nxt = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if c["every"] == "day":
        return nxt if nxt > now else nxt + timedelta(days=1)
    if c["every"] == "week":
        nxt += timedelta(days=(c["weekday"] - nxt.weekday()) % 7)
        return nxt if nxt > now else nxt + timedelta(days=7)
    nxt = nxt.replace(day=c["monthday"])
    if nxt <= now:
        nxt = (nxt.replace(day=1) + timedelta(days=32)).replace(day=c["monthday"])
    return nxt


# ── Validation ────────────────────────────────────────────────────────────────

def _item(raw: dict) -> dict:
    kind = raw.get("kind")
    if kind == "dashboard":
        from features import auto_dashboard
        did = str(raw.get("ref") or "")
        if not any(d["id"] == did for d in auto_dashboard.list_dashboards()):
            raise DeliveryError("That dashboard doesn't exist any more.")
        fmts = [f for f in raw.get("formats") or ["summary"] if f in FORMATS["dashboard"]] or ["summary"]
        return {"kind": "dashboard", "ref": did, "formats": fmts}
    if kind == "studio":
        ref, sk = str(raw.get("ref") or ""), raw.get("studio_kind")
        if sk not in ("doc", "deck") or not any(i["ref"] == ref and i["kind"] == sk for i in _studio_items()):
            raise DeliveryError("That report or deck doesn't exist yet – open it once in the editor first.")
        fmts = [f for f in raw.get("formats") or [] if f in FORMATS[sk]] or [FORMATS[sk][0]]
        return {"kind": "studio", "ref": ref, "studio_kind": sk, "formats": fmts}
    raise DeliveryError("Choose a dashboard, report or deck to deliver.")


def _channel(raw: dict, old: Optional[dict] = None) -> dict:
    from tools.url_guard import UnsafeURLError, check_public_url
    t = raw.get("type")
    if t == "email":
        to = raw.get("to") or []
        if isinstance(to, str):
            to = re.split(r"[,;\s]+", to)
        to = sorted({a.strip().lower() for a in to if a and a.strip()})
        if not to:
            raise DeliveryError("Add at least one email address.")
        if len(to) > MAX_RECIPIENTS:
            raise DeliveryError(f"At most {MAX_RECIPIENTS} recipients.")
        bad = [a for a in to if not _EMAIL.match(a)]
        if bad:
            raise DeliveryError(f"Not an email address: {', '.join(bad[:3])}")
        return {"type": "email", "to": to}
    if t in ("slack", "teams", "webhook"):
        url = str(raw.get("url") or "").strip()
        if not url or "…" in url:                       # unchanged masked value → keep the stored one
            if old and old.get("type") == t and old.get("url"):
                return {"type": t, "url": old["url"]}
            raise DeliveryError("Paste the webhook URL.")
        try:
            check_public_url(url, https_only=True)
        except UnsafeURLError as e:
            raise DeliveryError(f"Webhook URL refused: {e}.")
        return {"type": t, "url": url}
    raise DeliveryError("Choose email, Slack, Teams or webhook.")


# ── CRUD ──────────────────────────────────────────────────────────────────────

def list_schedules() -> list:
    return [_public(s) for s in sorted(_load_all().values(), key=lambda s: s.get("created_at", ""), reverse=True)]


def create_schedule(body: dict) -> dict:
    item = _item(body.get("item") or {})
    channel = _channel(body.get("channel") or {})
    cad = _cadence(body.get("cadence") or {})
    sid = uuid.uuid4().hex[:12]
    enabled = bool(body.get("enabled", True))
    s = {"id": sid, "name": (str(body.get("name") or "").strip() or "Scheduled delivery")[:80], "item": item,
         "channel": channel, "cadence": cad, "enabled": enabled, "created_at": _now(),
         "next_run": next_run(cad).isoformat(timespec="minutes") if enabled else None,
         "last_run": None, "last_status": None, "history": [], "last_values": {}}
    with _lock:
        data = _load_all()
        data[sid] = s
        _save_all(data)
    return _public(s)


def update_schedule(sid: str, body: dict) -> dict:
    with _lock:
        data = _load_all()
        s = data.get(sid) if _ID.match(sid or "") else None
        if not s:
            raise FileNotFoundError("schedule not found")
        if "name" in body:
            s["name"] = (str(body["name"]).strip() or s["name"])[:80]
        if "item" in body:
            s["item"] = _item(body["item"])
        if "channel" in body:
            s["channel"] = _channel(body["channel"], s["channel"])
        if "cadence" in body:
            s["cadence"] = _cadence(body["cadence"])
        if "enabled" in body:
            s["enabled"] = bool(body["enabled"])
        s["next_run"] = next_run(s["cadence"]).isoformat(timespec="minutes") if s["enabled"] else None
        _save_all(data)
        return _public(s)


def delete_schedule(sid: str) -> None:
    with _lock:
        data = _load_all()
        if not data.pop(sid, None):
            raise FileNotFoundError("schedule not found")
        _save_all(data)


# ── Building the delivery ─────────────────────────────────────────────────────

def _fmt(v, fmt: str, currency: str = "") -> str:
    if v is None:
        return "–"
    try:
        x = float(v)
    except (TypeError, ValueError):
        return str(v)
    if fmt == "percent":
        return f"{x * 100:.1f}%" if abs(x) <= 1.5 else f"{x:.1f}%"
    s = f"{x:,.0f}" if abs(x) >= 100 else f"{x:,.2f}"
    return f"{currency} {s}".strip() if fmt == "currency" else s


def _build(s: dict) -> dict:
    """{title, subtitle, summary, lines[], kpis[], files[(name, bytes, mime)], link, values{}}"""
    item = s["item"]
    if item["kind"] == "dashboard":
        from features import auto_dashboard
        dash = auto_dashboard.render(item["ref"])
        prev = s.get("last_values") or {}
        kpis, values = [], {}
        for k in dash["kpis"]:
            v = k.get("value")
            values[k["id"]] = v
            change = None
            try:
                if v is not None and prev.get(k["id"]) not in (None, 0):
                    change = (float(v) - float(prev[k["id"]])) / abs(float(prev[k["id"]]))
            except (TypeError, ValueError):
                change = None
            kpis.append({"title": k["title"], "value": v,
                         "display": _fmt(v, k.get("format", ""), dash.get("currency", "")),
                         "change": None if change is None else round(change, 4), "error": k.get("error")})
        files = []
        if "pptx" in item["formats"]:
            data, name = auto_dashboard.export_pptx(item["ref"])
            files.append((name, data, "application/vnd.openxmlformats-officedocument.presentationml.presentation"))
        if "xlsx" in item["formats"]:
            data, name = auto_dashboard.export_xlsx(item["ref"])
            files.append((name, data, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
        lines = []
        for k in kpis:
            since = f" ({k['change']:+.1%} since last time)" if k["change"] is not None else ""
            lines.append(f"{k['title']}: {k['display']}{since}")
        return {"title": dash["title"], "subtitle": dash.get("subtitle", ""), "summary": dash.get("summary", ""),
                "lines": lines, "kpis": kpis, "files": files, "link": f"{APP_URL}?board={item['ref']}", "values": values}
    from features import studio
    files = []
    title = item["ref"]
    for fmt in item["formats"]:
        name, data, mime = studio.export(item["ref"], item["studio_kind"], fmt)
        files.append((name, data, mime))
        title = Path(name).stem.replace("-", " ")
    what = "report" if item["studio_kind"] == "doc" else "deck"
    return {"title": title, "subtitle": "", "summary": f"The latest version of the {what} is attached.",
            "lines": [f"Attached: {n} ({len(b) / 1024:,.0f} KB)" for n, b, _ in files], "kpis": [],
            "files": files, "link": APP_URL, "values": {}}


def _stamp(s: dict) -> str:
    return f"{s['name']} · {datetime.now():%A %d %B %Y, %H:%M}"


def _text(s: dict, c: dict) -> str:
    head = c["title"] + (f" – {c['subtitle']}" if c.get("subtitle") else "")
    out = [head, _stamp(s), ""]
    if c.get("summary"):
        out += [c["summary"], ""]
    out += [f"• {line}" for line in c["lines"]]
    out += ["", f"Open in Ouroboros: {c['link']}"]
    return "\n".join(out)


def _html(s: dict, c: dict) -> str:
    cell = "padding:6px 12px;border-bottom:1px solid #ddd"
    if c["kpis"]:
        rows = []
        for k in c["kpis"]:
            ch = k["change"]
            color = "#1a7f37" if (ch or 0) > 0 else "#b42318" if (ch or 0) < 0 else "#666"
            since = "" if ch is None else f"{ch:+.1%}"
            rows.append(f"<tr><td style='{cell}'>{escape(k['title'])}</td>"
                        f"<td style='{cell};text-align:right;font-weight:600'>{escape(k['display'])}</td>"
                        f"<td style='{cell};text-align:right;color:{color}'>{since}</td></tr>")
        body = ("<table style='border-collapse:collapse;margin:12px 0'>"
                "<tr><th align='left' style='padding:6px 12px'>KPI</th><th align='right' style='padding:6px 12px'>Now</th>"
                "<th align='right' style='padding:6px 12px'>Since last</th></tr>" + "".join(rows) + "</table>")
    else:
        body = "".join(f"<p>{escape(line)}</p>" for line in c["lines"])
    summary = f"<p>{escape(c['summary'])}</p>" if c.get("summary") else ""
    return (f"<div style='font:14px Arial,sans-serif;color:#111'><h2 style='margin:0 0 4px'>{escape(c['title'])}</h2>"
            f"<div style='color:#666'>{escape(_stamp(s))}</div>{summary}{body}"
            f"<p><a href='{escape(c['link'])}'>Open in Ouroboros</a></p></div>")


def _send_email(s: dict, c: dict):
    if not smtp_configured():
        raise DeliveryError("Email isn't set up on this server: add SMTP_HOST, SMTP_PORT, SMTP_USER, "
                            "SMTP_PASSWORD and SMTP_FROM to .env, or deliver to Slack / a webhook.")
    msg = EmailMessage()
    msg["Subject"] = f"{c['title']} · {s['name']}"[:200]
    msg["From"] = os.getenv("SMTP_FROM")
    msg["To"] = ", ".join(s["channel"]["to"])
    msg.set_content(_text(s, c))
    msg.add_alternative(_html(s, c), subtype="html")
    total = 0
    for name, data, mime in c["files"]:
        total += len(data)
        if total > MAX_ATTACH_BYTES:
            raise DeliveryError("The attachments are larger than 15 MB – deliver fewer formats.")
        main, _, sub = mime.partition("/")
        msg.add_attachment(data, maintype=main, subtype=sub, filename=name)
    host, port = os.getenv("SMTP_HOST"), int(os.getenv("SMTP_PORT") or 587)
    user, pw = os.getenv("SMTP_USER"), os.getenv("SMTP_PASSWORD")
    ctx = ssl.create_default_context()
    if port == 465:
        server = smtplib.SMTP_SSL(host, port, context=ctx, timeout=30)
    else:
        server = smtplib.SMTP(host, port, timeout=30)
        if os.getenv("SMTP_STARTTLS", "1") != "0":
            server.starttls(context=ctx)
    try:
        if user:
            server.login(user, pw or "")
        server.send_message(msg)
    finally:
        try:
            server.quit()
        except Exception:
            pass


def _send_hook(s: dict, c: dict):
    from tools.llm_guard import redact_text
    from tools.url_guard import UnsafeURLError, post_json
    ch = s["channel"]
    text, _ = redact_text(_text(s, c)[:3800])
    if ch["type"] in ("slack", "teams"):
        if c["files"]:
            text += "\n\n(Files can't travel through a chat webhook – choose email to get them attached.)"
        body = {"text": text}
    else:
        size = sum(len(b) for _, b, _ in c["files"])
        files = []
        for n, b, m in c["files"]:
            f = {"name": n, "media_type": m, "bytes": len(b)}
            if size <= MAX_WEBHOOK_FILES:
                f["base64"] = base64.b64encode(b).decode()
            files.append(f)
        body = {"schedule": s["name"], "title": c["title"], "generated_at": datetime.now().isoformat(timespec="seconds"),
                "summary": c.get("summary", ""), "message": text, "link": c["link"],
                "kpis": [{k: v for k, v in kpi.items() if k != "error"} for kpi in c["kpis"]], "files": files}
    try:
        r = post_json(ch["url"], body, timeout=30)
    except UnsafeURLError as e:
        raise DeliveryError(f"Webhook URL refused: {e}.")
    except Exception as e:
        raise DeliveryError(f"Couldn't reach the webhook: {str(e).splitlines()[0][:200]}")
    if r.status_code >= 300:
        snippet = re.sub(r"<[^>]+>|\s+", " ", r.text)[:160].strip()
        raise DeliveryError(f"The webhook answered HTTP {r.status_code}: {snippet}")


def _deliver(sid: str, trigger: str) -> dict:
    s = _get(sid)
    t0 = time.time()
    try:
        c = _build(s)
        (_send_email if s["channel"]["type"] == "email" else _send_hook)(s, c)
        where = ", ".join(s["channel"]["to"]) if s["channel"]["type"] == "email" else s["channel"]["type"].title()
        entry = {"at": _now(), "status": "sent", "trigger": trigger, "seconds": round(time.time() - t0, 1),
                 "detail": f"Sent to {where}" + (f" with {len(c['files'])} file(s)" if c["files"] else "")}
        values = c["values"]
    except Exception as e:                                           # noqa: BLE001
        detail = str(e)[:300] if isinstance(e, DeliveryError) else f"{type(e).__name__}: {str(e)[:250]}"
        entry = {"at": _now(), "status": "failed", "trigger": trigger, "seconds": round(time.time() - t0, 1),
                 "detail": detail}
        values = None
    with _lock:
        data = _load_all()
        cur = data.get(sid)
        if cur:
            cur["history"] = ([entry] + cur.get("history", []))[:20]
            cur["last_run"], cur["last_status"] = entry["at"], entry["status"]
            if values is not None:
                cur["last_values"] = values
            _save_all(data)
    return entry


def send_now(sid: str) -> dict:
    _get(sid)
    if sid in _running:
        raise DeliveryError("This delivery is being sent right now.")
    _running.add(sid)
    try:
        return _deliver(sid, "manual")
    finally:
        _running.discard(sid)


# ── Scheduler ─────────────────────────────────────────────────────────────────

_started = False


def start_scheduler():
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, daemon=True, name="delivery-scheduler").start()


def _due_now() -> list:
    due = []
    with _lock:
        data = _load_all()
        now = datetime.now()
        for s in data.values():
            if s.get("enabled") and s.get("next_run") and s["id"] not in _running \
                    and datetime.fromisoformat(s["next_run"]) <= now:
                s["next_run"] = next_run(s["cadence"], now).isoformat(timespec="minutes")
                due.append(s["id"])
        if due:
            _save_all(data)
    return due


def _loop():
    while True:
        time.sleep(30)
        try:
            for sid in _due_now():
                _running.add(sid)
                try:
                    _deliver(sid, "schedule")
                finally:
                    _running.discard(sid)
        except Exception:                                            # noqa: BLE001 – keep the loop alive
            continue
