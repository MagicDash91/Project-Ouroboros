"""
features/connectors.py – pull data in from the apps a team already uses.

Each connector fetches one thing (a Google Sheet tab, a Drive file, a Slack channel's
history, a Notion database, an Airtable table, or a file at a public URL) and returns it
as a file: `(filename, bytes)`. Tabular data comes back as CSV, documents in their own
format. app.py stores the result exactly like an upload, so Analytics runs and Data chat
use it with no other changes.

Credentials: a token typed in the form wins, otherwise the env var below. Tokens are
used for the one request and never stored.

  Google Sheets / Drive  link-shared files need nothing; private ones need a service
                         account key in GOOGLE_APPLICATION_CREDENTIALS, with the file
                         shared to that account's email
  Slack                  SLACK_BOT_TOKEN (xoxb-…, scopes channels:history, channels:read,
                         groups:history, groups:read, users:read; invite the bot to the channel)
  Notion                 NOTION_TOKEN (internal integration, connected to the database)
  Airtable               AIRTABLE_TOKEN (personal access token, data.records:read)
  Public URL             nothing; private and internal addresses are refused (SSRF)
"""

import io
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urljoin, urlparse

import httpx
import pandas as pd

MAX_BYTES = 100 * 1024 * 1024        # per imported file
MAX_ROWS = 200_000                   # per API-built table (Slack, Notion, Airtable)
TIMEOUT = httpx.Timeout(30.0, connect=15.0)
_UA = "Ouroboros-connector/1.0"

TABULAR = {".csv", ".tsv", ".txt", ".xlsx", ".xls", ".json", ".jsonl", ".ndjson", ".parquet"}
DOCUMENT = {".pdf", ".docx", ".doc", ".pptx", ".ppt"}


class ConnectorError(ValueError):
    pass


# ── Shared helpers ────────────────────────────────────────────────────────────

def _slug(s: str, fallback: str = "data") -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", (s or "").strip()).strip("_").lower()
    return s[:50] or fallback


def _csv(df: pd.DataFrame, name: str) -> tuple:
    if df.empty:
        raise ConnectorError("That source has no rows to import.")
    return f"{_slug(name)}.csv", df.to_csv(index=False).encode("utf-8")


def _read_capped(resp: httpx.Response) -> bytes:
    buf = bytearray()
    for chunk in resp.iter_bytes():
        buf += chunk
        if len(buf) > MAX_BYTES:
            raise ConnectorError(f"The file is larger than {MAX_BYTES // (1024 * 1024)} MB.")
    return bytes(buf)


def _filename_from(resp: httpx.Response, fallback: str) -> str:
    cd = resp.headers.get("content-disposition", "")
    m = re.search(r"filename\*=UTF-8''([^;]+)", cd, re.I) or re.search(r'filename="?([^";]+)"?', cd, re.I)
    return Path(unquote(m.group(1))).name if m else fallback


def _is_html(resp: httpx.Response, body: bytes) -> bool:
    return ("text/html" in resp.headers.get("content-type", "")
            or body[:200].lstrip().lower().startswith((b"<!doctype html", b"<html")))


def _tabular_to_csv(name: str, data: bytes) -> tuple:
    """CSV and Excel stay as they are; TSV, JSON and Parquet become CSV so every app can read them."""
    ext = Path(name).suffix.lower()
    if ext in (".csv", ".xlsx", ".xls"):
        return name, data
    try:
        if ext in (".tsv", ".txt"):
            df = pd.read_csv(io.BytesIO(data), sep=None, engine="python")
        elif ext == ".parquet":
            df = pd.read_parquet(io.BytesIO(data))
        elif ext in (".jsonl", ".ndjson"):
            df = pd.read_json(io.BytesIO(data), lines=True)
        else:
            obj = json.loads(data.decode("utf-8-sig"))
            if isinstance(obj, dict):                # {"data": [...]} / {"results": [...]} wrappers
                obj = next((v for v in obj.values() if isinstance(v, list)), [obj])
            df = pd.json_normalize(obj)
    except Exception as e:
        raise ConnectorError(f"Couldn't read {name} as a table: {str(e).splitlines()[0][:200]}")
    return _csv(df, Path(name).stem)


def _finish(fname: str, body: bytes) -> tuple:
    ext = Path(fname).suffix.lower()
    if ext not in TABULAR | DOCUMENT:
        raise ConnectorError(f"'{fname}' isn't a supported file type. Use CSV, Excel, JSON, Parquet, PDF, Word or PowerPoint.")
    return _tabular_to_csv(fname, body) if ext in TABULAR else (fname, body)


# ── Google Sheets & Drive ─────────────────────────────────────────────────────

def _google_token() -> tuple:
    """(access token, account) from "Connect Google" (features/oauth.py), else from the service account in
    GOOGLE_APPLICATION_CREDENTIALS, else (None, None)."""
    try:
        from features import oauth
        tok = oauth.token("google")
        if tok:
            return tok, oauth.account("google")
    except Exception:
        pass
    key = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if not key or not Path(key).is_file():
        return None, None
    try:
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
        creds = service_account.Credentials.from_service_account_file(
            key, scopes=["https://www.googleapis.com/auth/drive.readonly"])
        creds.refresh(Request())
        return creds.token, creds.service_account_email
    except Exception:
        return None, None


def _google_id(url: str) -> str:
    url = url.strip()
    m = (re.search(r"/(?:spreadsheets|document|presentation|file)/d/([A-Za-z0-9_-]{20,})", url)
         or re.search(r"[?&]id=([A-Za-z0-9_-]{20,})", url))
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{20,}", url):
        return url
    raise ConnectorError("Paste the file's Google link (the one from Share → Copy link).")


def _google_denied(email: Optional[str]) -> ConnectorError:
    if email:
        return ConnectorError(f"Google refused access. Share the file with {email} (Viewer is enough).")
    return ConnectorError("Google refused access. Set the file to 'Anyone with the link can view', or set "
                          "GOOGLE_APPLICATION_CREDENTIALS to a service-account key and share the file with that account.")


def _google_get(c: httpx.Client, url: str, token: Optional[str], email: Optional[str], params=None) -> tuple:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with c.stream("GET", url, headers=headers, params=params) as r:
        if r.status_code in (401, 403, 404):
            raise _google_denied(email)
        if r.status_code >= 400:
            raise ConnectorError(f"Google returned HTTP {r.status_code}.")
        body = _read_capped(r)
        if _is_html(r, body):                    # a sign-in page: the file isn't shared with us
            raise _google_denied(email)
        return r, body


def _drive_meta(c: httpx.Client, fid: str, token: str, email: str) -> dict:
    r = c.get(f"https://www.googleapis.com/drive/v3/files/{fid}", headers={"Authorization": f"Bearer {token}"},
              params={"fields": "name,mimeType", "supportsAllDrives": "true"})
    if r.status_code != 200:
        raise _google_denied(email)
    return r.json()


def import_gsheets(url: str, name: str = "") -> tuple:
    if "/spreadsheets/" not in url and not re.fullmatch(r"[A-Za-z0-9_-]{20,}", url.strip()):
        raise ConnectorError("That isn't a Google Sheets link (expected docs.google.com/spreadsheets/d/…).")
    sid = _google_id(url)
    gid = (re.search(r"[#&?]gid=(\d+)", url) or [None, "0"])[1]
    token, email = _google_token()
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": _UA}) as c:
        if token and not name:
            name = _drive_meta(c, sid, token, email).get("name", "")
        _, body = _google_get(c, f"https://docs.google.com/spreadsheets/d/{sid}/export", token, email,
                              {"format": "csv", "gid": gid})
    try:
        df = pd.read_csv(io.BytesIO(body))
    except Exception as e:
        raise ConnectorError(f"Couldn't read that sheet: {str(e).splitlines()[0][:200]}")
    return _csv(df, name or f"sheet_{sid[:8]}")


_GOOGLE_EXPORT = {                       # native Google type → (export MIME, extension)
    "application/vnd.google-apps.document": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"),
    "application/vnd.google-apps.presentation": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"),
}


def import_gdrive(url: str) -> tuple:
    if "/folders/" in url:
        raise ConnectorError("That's a folder. Open the file you want and copy its link.")
    if "/spreadsheets/" in url:
        return import_gsheets(url)
    fid = _google_id(url)
    token, email = _google_token()
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": _UA}) as c:
        if token:
            meta = _drive_meta(c, fid, token, email)
            mime, fname = meta.get("mimeType", ""), meta.get("name", "file")
            if mime == "application/vnd.google-apps.folder":
                raise ConnectorError("That's a folder. Open the file you want and copy its link.")
            if mime == "application/vnd.google-apps.spreadsheet":
                return import_gsheets(fid, fname)
            if mime.startswith("application/vnd.google-apps."):
                if mime not in _GOOGLE_EXPORT:
                    raise ConnectorError("Only Google Docs, Sheets and Slides can be exported from Drive.")
                exp, ext = _GOOGLE_EXPORT[mime]
                _, body = _google_get(c, f"https://www.googleapis.com/drive/v3/files/{fid}/export", token, email, {"mimeType": exp})
                fname = Path(fname).stem + ext
            else:
                _, body = _google_get(c, f"https://www.googleapis.com/drive/v3/files/{fid}", token, email,
                                      {"alt": "media", "supportsAllDrives": "true"})
        elif "/document/" in url:
            r, body = _google_get(c, f"https://docs.google.com/document/d/{fid}/export", None, None, {"format": "docx"})
            fname = _filename_from(r, f"doc_{fid[:8]}.docx")
        elif "/presentation/" in url:
            r, body = _google_get(c, f"https://docs.google.com/presentation/d/{fid}/export/pptx", None, None)
            fname = _filename_from(r, f"slides_{fid[:8]}.pptx")
        else:
            r, body = _google_get(c, "https://drive.usercontent.google.com/download", None, None,
                                  {"id": fid, "export": "download", "confirm": "t"})
            fname = _filename_from(r, "")
            if not fname:
                raise ConnectorError("Drive didn't say what kind of file this is. Share it as 'Anyone with the link' and try again.")
    return _finish(fname, body)


# ── Slack ─────────────────────────────────────────────────────────────────────

_SLACK_HINTS = {
    "not_in_channel": "The bot isn't in that channel. In Slack, type /invite @your-bot in the channel.",
    "channel_not_found": "Channel not found. Use the channel name, or its ID from the channel's About tab.",
    "missing_scope": "The bot token is missing a scope. It needs channels:history, channels:read, groups:history, groups:read and users:read.",
    "invalid_auth": "Slack rejected the token. Use the Bot User OAuth Token (xoxb-…).",
    "not_authed": "No Slack token. Paste a bot token or set SLACK_BOT_TOKEN.",
    "token_revoked": "That Slack token has been revoked.",
}


def _slack(c: httpx.Client, token: str, method: str, **params) -> dict:
    for _ in range(4):
        r = c.get(f"https://slack.com/api/{method}", params=params, headers={"Authorization": f"Bearer {token}"})
        if r.status_code == 429:
            time.sleep(min(int(r.headers.get("retry-after", "2")), 10))
            continue
        data = r.json()
        if not data.get("ok"):
            err = data.get("error", "unknown_error")
            raise ConnectorError(_SLACK_HINTS.get(err, f"Slack error: {err}"))
        return data
    raise ConnectorError("Slack is rate-limiting requests. Try again in a minute.")


def _slack_channel(c: httpx.Client, token: str, channel: str) -> tuple:
    m = re.search(r"/archives/([CG][A-Z0-9]+)", channel)
    if m or re.fullmatch(r"[CG][A-Z0-9]{6,}", channel):
        cid = m.group(1) if m else channel
        return cid, _slack(c, token, "conversations.info", channel=cid)["channel"].get("name", cid)
    want, cursor = channel.lstrip("#").lower(), ""
    while True:
        page = _slack(c, token, "conversations.list", types="public_channel,private_channel",
                      exclude_archived="true", limit=1000, **({"cursor": cursor} if cursor else {}))
        for ch in page.get("channels", []):
            if ch.get("name", "").lower() == want:
                return ch["id"], ch["name"]
        cursor = page.get("response_metadata", {}).get("next_cursor", "")
        if not cursor:
            raise ConnectorError(f"No channel named #{want} that the bot can see. Invite the bot to it first.")


def import_slack(channel: str, days: int = 30, token: str = "") -> tuple:
    if not token:
        try:
            from features import oauth
            token = oauth.token("slack") or ""
        except Exception:
            token = ""
    token = token or os.getenv("SLACK_BOT_TOKEN", "").strip()
    if not token:
        raise ConnectorError(_SLACK_HINTS["not_authed"])
    if not channel:
        raise ConnectorError("Name the channel to import, e.g. #sales.")
    days = max(1, min(int(days or 30), 365))
    oldest = (datetime.now(timezone.utc) - timedelta(days=days)).timestamp()
    with httpx.Client(timeout=TIMEOUT, headers={"User-Agent": _UA}) as c:
        cid, cname = _slack_channel(c, token, channel)
        msgs, cursor = [], ""
        while len(msgs) < MAX_ROWS:
            page = _slack(c, token, "conversations.history", channel=cid, oldest=f"{oldest:.6f}", limit=200,
                          **({"cursor": cursor} if cursor else {}))
            msgs += page.get("messages", [])
            cursor = page.get("response_metadata", {}).get("next_cursor", "")
            if not cursor or not page.get("has_more"):
                break
        names: dict = {}
        for uid in {m.get("user") for m in msgs if m.get("user")}:
            try:
                u = _slack(c, token, "users.info", user=uid)["user"]
                names[uid] = u.get("profile", {}).get("display_name") or u.get("real_name") or u.get("name") or uid
            except ConnectorError:
                names[uid] = uid
    if not msgs:
        raise ConnectorError(f"#{cname} has no messages in the last {days} days.")
    rows = []
    for m in msgs:
        when = datetime.fromtimestamp(float(m.get("ts", 0)), timezone.utc)
        rows.append({
            "timestamp": when.isoformat(timespec="seconds"),
            "date": when.date().isoformat(),
            "user_id": m.get("user") or m.get("bot_id") or "",
            "user_name": names.get(m.get("user"), m.get("username") or ""),
            "text": m.get("text", ""),
            "type": m.get("subtype") or "message",
            "is_thread_parent": bool(m.get("reply_count")),
            "reply_count": m.get("reply_count", 0),
            "reply_users": m.get("reply_users_count", 0),
            "reactions": sum(r.get("count", 0) for r in m.get("reactions", [])),
            "files": len(m.get("files", [])),
        })
    return _csv(pd.DataFrame(rows).sort_values("timestamp"), f"slack_{cname}")


# ── Notion ────────────────────────────────────────────────────────────────────

def _notion_value(p: dict):
    t = p.get("type")
    v = p.get(t)
    if v is None:
        return None
    if t in ("title", "rich_text"):
        return "".join(x.get("plain_text", "") for x in v)
    if t in ("select", "status"):
        return v.get("name")
    if t in ("multi_select", "files"):
        return ", ".join(x.get("name", "") for x in v)
    if t == "date":
        return v.get("start")
    if t == "people":
        return ", ".join(x.get("name") or x.get("id", "") for x in v)
    if t == "relation":
        return len(v)
    if t == "unique_id":
        return f"{v['prefix']}-{v.get('number')}" if v.get("prefix") else v.get("number")
    if t in ("created_by", "last_edited_by"):
        return v.get("name") or v.get("id")
    if t in ("formula", "rollup"):
        inner = v.get(v.get("type"))
        if v.get("type") == "array":
            return len(inner or [])
        return (inner or {}).get("start") if v.get("type") == "date" else inner
    return v if isinstance(v, (str, int, float, bool)) else json.dumps(v)[:500]


def import_notion(url: str, token: str = "") -> tuple:
    token = token or os.getenv("NOTION_TOKEN", "").strip()
    if not token:
        raise ConnectorError("No Notion token. Paste an integration secret or set NOTION_TOKEN.")
    m = re.search(r"([0-9a-f]{32})", urlparse(url).path.replace("-", "") or url.replace("-", ""))
    if not m:
        raise ConnectorError("Paste the database's Notion link (open it as a full page, then Share → Copy link).")
    dbid = m.group(1)
    h = {"Authorization": f"Bearer {token}", "Notion-Version": "2022-06-28", "User-Agent": _UA}
    with httpx.Client(timeout=TIMEOUT, headers=h) as c:
        meta = c.get(f"https://api.notion.com/v1/databases/{dbid}")
        if meta.status_code == 401:
            raise ConnectorError("Notion rejected the token.")
        if meta.status_code in (400, 404):
            raise ConnectorError("Notion can't see that database. Open it → ••• → Connections → add your integration. "
                                 "(Ordinary pages can't be imported as tables; it has to be a database.)")
        if meta.status_code >= 400:
            raise ConnectorError(f"Notion error: {meta.json().get('message', meta.status_code)}")
        title = "".join(x.get("plain_text", "") for x in meta.json().get("title", [])) or f"notion_{dbid[:8]}"
        rows, cursor = [], None
        while len(rows) < MAX_ROWS:
            r = c.post(f"https://api.notion.com/v1/databases/{dbid}/query",
                       json={"page_size": 100, **({"start_cursor": cursor} if cursor else {})})
            if r.status_code == 429:
                time.sleep(min(int(r.headers.get("retry-after", "1")), 10))
                continue
            if r.status_code >= 400:
                raise ConnectorError(f"Notion error: {r.json().get('message', r.status_code)}")
            data = r.json()
            for page in data.get("results", []):
                row = {"page_id": page.get("id"), "created_time": page.get("created_time"),
                       "last_edited_time": page.get("last_edited_time")}
                row.update({k: _notion_value(p) for k, p in page.get("properties", {}).items()})
                rows.append(row)
            if not data.get("has_more"):
                break
            cursor = data.get("next_cursor")
    return _csv(pd.DataFrame(rows), title)


# ── Airtable ──────────────────────────────────────────────────────────────────

def _airtable_value(v):
    if isinstance(v, list):
        return ", ".join(str(_airtable_value(x)) for x in v)
    if isinstance(v, dict):                     # collaborators, attachments, buttons, AI text
        return v.get("name") or v.get("email") or v.get("filename") or v.get("label") or v.get("value") or json.dumps(v)[:300]
    return v


def import_airtable(url: str, table: str = "", token: str = "") -> tuple:
    token = token or os.getenv("AIRTABLE_TOKEN", "").strip()
    if not token:
        raise ConnectorError("No Airtable token. Paste a personal access token or set AIRTABLE_TOKEN.")
    base = re.search(r"(app[A-Za-z0-9]{14})", url)
    if not base:
        raise ConnectorError("Paste the table's Airtable link (airtable.com/app…/tbl…).")
    tbl = re.search(r"(tbl[A-Za-z0-9]{14})", url)
    view = re.search(r"(viw[A-Za-z0-9]{14})", url)
    table_ref = tbl.group(1) if tbl else table
    if not table_ref:
        raise ConnectorError("The link doesn't include a table. Open the table in Airtable and copy that link, or type its name.")
    rows, offset, waits = [], None, 0
    with httpx.Client(timeout=TIMEOUT, headers={"Authorization": f"Bearer {token}", "User-Agent": _UA}) as c:
        while len(rows) < MAX_ROWS:
            params = {"pageSize": 100, **({"offset": offset} if offset else {}), **({"view": view.group(1)} if view else {})}
            r = c.get(f"https://api.airtable.com/v0/{base.group(1)}/{table_ref}", params=params)
            if r.status_code == 429 and waits < 2:
                waits += 1
                time.sleep(30)                   # Airtable's documented back-off
                continue
            if r.status_code in (401, 403):
                raise ConnectorError("Airtable refused access. The token needs the data.records:read scope and access to this base.")
            if r.status_code == 404:
                raise ConnectorError("Airtable couldn't find that base or table.")
            if r.status_code >= 400:
                raise ConnectorError(f"Airtable error: {r.json().get('error', r.status_code)}")
            data = r.json()
            for rec in data.get("records", []):
                rows.append({"record_id": rec.get("id"), "created_time": rec.get("createdTime"),
                             **{k: _airtable_value(v) for k, v in rec.get("fields", {}).items()}})
            offset = data.get("offset")
            if not offset:
                break
    return _csv(pd.DataFrame(rows), f"airtable_{table or table_ref}")


# ── File at a public URL ──────────────────────────────────────────────────────

def import_url(url: str) -> tuple:
    from features.agent import AgentError, _public_host
    with httpx.Client(timeout=TIMEOUT, follow_redirects=False, headers={"User-Agent": _UA}) as c:
        for _ in range(6):                      # follow redirects by hand so every hop passes the SSRF check
            try:
                _public_host(url)
            except AgentError as e:
                raise ConnectorError(f"Can't open that URL: {e}.")
            with c.stream("GET", url) as r:
                if r.is_redirect:
                    url = urljoin(url, r.headers.get("location", ""))
                    continue
                if r.status_code >= 400:
                    raise ConnectorError(f"The server returned HTTP {r.status_code}.")
                body = _read_capped(r)
                fname = _filename_from(r, Path(urlparse(url).path).name or "download")
                ctype = r.headers.get("content-type", "")
                html = _is_html(r, body)
                break
        else:
            raise ConnectorError("Too many redirects.")
    if not Path(fname).suffix:
        fname += next((ext for key, ext in (("csv", ".csv"), ("json", ".json"), ("pdf", ".pdf"),
                                             ("spreadsheetml", ".xlsx"), ("parquet", ".parquet")) if key in ctype), "")
    if html:
        raise ConnectorError("That URL is a web page, not a file. Link straight to a CSV, Excel, JSON, Parquet, PDF or Word file.")
    return _finish(fname, body)


# ── Registry ──────────────────────────────────────────────────────────────────

CONNECTORS = {
    "gsheets":  {"name": "Google Sheets", "env": "GOOGLE_APPLICATION_CREDENTIALS", "token": False},
    "gdrive":   {"name": "Google Drive", "env": "GOOGLE_APPLICATION_CREDENTIALS", "token": False},
    "slack":    {"name": "Slack", "env": "SLACK_BOT_TOKEN", "token": True},
    "notion":   {"name": "Notion", "env": "NOTION_TOKEN", "token": True},
    "airtable": {"name": "Airtable", "env": "AIRTABLE_TOKEN", "token": True},
    "url":      {"name": "File URL", "env": "", "token": False},
}


def status() -> list:
    """Which connectors have credentials configured on the server (never the secrets themselves)."""
    try:
        from features import oauth
        signed_in = {p for p, v in oauth.status().items() if v["connected"]}
    except Exception:
        signed_in = set()
    out = []
    for key, c in CONNECTORS.items():
        val = os.getenv(c["env"], "").strip() if c["env"] else ""
        configured = bool(val) and (Path(val).is_file() if c["env"] == "GOOGLE_APPLICATION_CREDENTIALS" else True)
        configured = configured or (key in ("gsheets", "gdrive") and "google" in signed_in) or (key == "slack" and "slack" in signed_in)
        out.append({"key": key, "name": c["name"], "env": c["env"], "configured": configured, "needs_token": c["token"]})
    return out


def fetch(connector: str, params: dict) -> tuple:
    """Run one connector. Returns (filename, bytes); raises ConnectorError with a plain-language reason."""
    if connector not in CONNECTORS:
        raise ConnectorError(f"Unknown connector '{connector}'.")
    p = {k: (v.strip() if isinstance(v, str) else v) for k, v in (params or {}).items()}
    name = CONNECTORS[connector]["name"]
    try:
        if connector == "gsheets":
            return import_gsheets(p.get("url", ""), p.get("name", ""))
        if connector == "gdrive":
            return import_gdrive(p.get("url", ""))
        if connector == "slack":
            return import_slack(p.get("channel", ""), int(p.get("days") or 30), p.get("token", ""))
        if connector == "notion":
            return import_notion(p.get("url", ""), p.get("token", ""))
        if connector == "airtable":
            return import_airtable(p.get("url", ""), p.get("table", ""), p.get("token", ""))
        return import_url(p.get("url", ""))
    except httpx.TimeoutException:
        raise ConnectorError(f"{name} took too long to answer. Try again.")
    except httpx.HTTPError as e:
        raise ConnectorError(f"Couldn't reach {name}: {str(e).splitlines()[0][:200]}")
    except (ValueError, json.JSONDecodeError) as e:
        if isinstance(e, ConnectorError):
            raise
        raise ConnectorError(f"{name} sent back something unexpected: {str(e).splitlines()[0][:200]}")
