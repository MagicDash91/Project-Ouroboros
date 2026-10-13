"""
features/oauth.py – "Connect Google" / "Connect Slack" for the app connectors (OAuth 2.0).

Instead of pasting tokens or setting up a Google service account, the user signs in once in a
popup. The connectors (features/connectors.py) then use that account: Google Sheets and Drive
read the user's own files; Slack reads the channels the app's bot is in.

Setup (once, by whoever runs the server) — register an OAuth app and put its credentials in .env:
  Google  GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
          redirect URI  {OAUTH_REDIRECT_BASE}/api/oauth/google/callback
  Slack   SLACK_CLIENT_ID / SLACK_CLIENT_SECRET
          redirect URL  {OAUTH_REDIRECT_BASE}/api/oauth/slack/callback   (Slack requires https,
          except for localhost during development)
  OAUTH_REDIRECT_BASE defaults to http://localhost:8002.

Tokens are encrypted at rest (Fernet) in data/oauth/tokens.json; the key comes from
OAUTH_ENCRYPTION_KEY or is generated once into data/oauth/key. There are no user accounts yet,
so a connection is shared by everyone using this server.
"""

import json
import os
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx

ROOT = Path(__file__).resolve().parent.parent
OAUTH_DIR = ROOT / "data" / "oauth"
TOKENS = OAUTH_DIR / "tokens.json"
KEY_FILE = OAUTH_DIR / "key"
_lock = threading.RLock()
_states: dict = {}                       # state -> (provider, expires)

PROVIDERS = {
    "google": {
        "name": "Google", "env": ("GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"),
        "auth": "https://accounts.google.com/o/oauth2/v2/auth", "token": "https://oauth2.googleapis.com/token",
        "scopes": "openid email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly",
    },
    "slack": {
        "name": "Slack", "env": ("SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"),
        "auth": "https://slack.com/oauth/v2/authorize", "token": "https://slack.com/api/oauth.v2.access",
        "scopes": "channels:history,channels:read,groups:history,groups:read,users:read",
    },
}


class OAuthError(ValueError):
    pass


def _redirect(provider: str) -> str:
    base = (os.getenv("OAUTH_REDIRECT_BASE") or "http://localhost:8002").rstrip("/")
    return f"{base}/api/oauth/{provider}/callback"


def _creds(provider: str) -> tuple:
    return tuple(os.getenv(k, "").strip() for k in PROVIDERS[provider]["env"])


def configured(provider: str) -> bool:
    return all(_creds(provider))


# ── Encrypted token store ────────────────────────────────────────────────────

def _fernet():
    from cryptography.fernet import Fernet
    key = os.getenv("OAUTH_ENCRYPTION_KEY", "").strip().encode()
    if not key:
        OAUTH_DIR.mkdir(parents=True, exist_ok=True)
        if not KEY_FILE.is_file():
            KEY_FILE.write_bytes(Fernet.generate_key())
        key = KEY_FILE.read_bytes().strip()
    return Fernet(key)


def _load() -> dict:
    try:
        return json.loads(_fernet().decrypt(TOKENS.read_bytes()).decode("utf-8"))
    except Exception:
        return {}


def _save(data: dict):
    from features.agent import _replace
    OAUTH_DIR.mkdir(parents=True, exist_ok=True)
    tmp = TOKENS.with_suffix(".tmp")
    tmp.write_bytes(_fernet().encrypt(json.dumps(data).encode("utf-8")))
    _replace(tmp, TOKENS)


# ── Flow ─────────────────────────────────────────────────────────────────────

def start(provider: str) -> str:
    """The consent URL to open in a popup."""
    if provider not in PROVIDERS:
        raise OAuthError("Unknown provider.")
    if not configured(provider):
        a, b = PROVIDERS[provider]["env"]
        raise OAuthError(f"{PROVIDERS[provider]['name']} sign-in isn't set up on this server: add {a} and {b} to .env.")
    state = secrets.token_urlsafe(24)
    now = time.time()
    for s, (_, exp) in list(_states.items()):
        if exp < now:
            _states.pop(s, None)
    _states[state] = (provider, now + 600)
    p, (cid, _) = PROVIDERS[provider], _creds(provider)
    params = {"client_id": cid, "redirect_uri": _redirect(provider), "state": state}
    if provider == "google":
        params.update(response_type="code", scope=p["scopes"], access_type="offline", prompt="consent",
                      include_granted_scopes="true")
    else:
        params.update(scope=p["scopes"])
    return f"{p['auth']}?{urlencode(params)}"


def finish(provider: str, code: str, state: str) -> dict:
    """Exchange the code from the callback for tokens and store them. Returns who connected."""
    entry = _states.pop(state or "", None)
    if not entry or entry[0] != provider or entry[1] < time.time():
        raise OAuthError("This sign-in link expired or was already used. Start again from the app.")
    cid, secret = _creds(provider)
    p = PROVIDERS[provider]
    with httpx.Client(timeout=20) as c:
        r = c.post(p["token"], data={"code": code, "client_id": cid, "client_secret": secret,
                                     "redirect_uri": _redirect(provider), "grant_type": "authorization_code"})
        data = r.json()
        if provider == "google":
            if "access_token" not in data:
                raise OAuthError(f"Google refused the sign-in: {data.get('error_description') or data.get('error') or r.status_code}")
            info = c.get("https://openidconnect.googleapis.com/v1/userinfo",
                         headers={"Authorization": f"Bearer {data['access_token']}"}).json()
            record = {"access_token": data["access_token"], "refresh_token": data.get("refresh_token", ""),
                      "expires_at": time.time() + int(data.get("expires_in", 3600)) - 60,
                      "account": info.get("email", "Google account")}
        else:
            if not data.get("ok"):
                raise OAuthError(f"Slack refused the sign-in: {data.get('error', r.status_code)}")
            record = {"access_token": data["access_token"],
                      "account": (data.get("team") or {}).get("name", "Slack workspace"), "bot_user": data.get("bot_user_id", "")}
    with _lock:
        tokens = _load()
        old = tokens.get(provider, {})
        if provider == "google" and not record["refresh_token"]:
            record["refresh_token"] = old.get("refresh_token", "")       # Google only sends it on first consent
        tokens[provider] = {**record, "connected_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        _save(tokens)
    return {"provider": provider, "account": record["account"]}


def token(provider: str):
    """A valid access token for a connected provider, refreshing Google's when needed; None if not connected."""
    with _lock:
        tokens = _load()
        rec = tokens.get(provider)
        if not rec:
            return None
        if provider == "google" and rec.get("expires_at", 0) < time.time():
            if not rec.get("refresh_token"):
                return None
            cid, secret = _creds("google")
            try:
                data = httpx.post(PROVIDERS["google"]["token"], timeout=20,
                                  data={"client_id": cid, "client_secret": secret, "refresh_token": rec["refresh_token"],
                                        "grant_type": "refresh_token"}).json()
            except httpx.HTTPError:
                return None
            if "access_token" not in data:
                return None
            rec.update(access_token=data["access_token"], expires_at=time.time() + int(data.get("expires_in", 3600)) - 60)
            tokens["google"] = rec
            _save(tokens)
        return rec["access_token"]


def account(provider: str) -> str:
    return _load().get(provider, {}).get("account", "")


def disconnect(provider: str):
    with _lock:
        tokens = _load()
        rec = tokens.pop(provider, None)
        _save(tokens)
    if rec and provider == "google":
        try:
            httpx.post("https://oauth2.googleapis.com/revoke", params={"token": rec.get("refresh_token") or rec["access_token"]},
                       timeout=10)
        except httpx.HTTPError:
            pass


def status() -> dict:
    tokens = _load()
    return {p: {"name": PROVIDERS[p]["name"], "configured": configured(p), "connected": p in tokens,
                "account": tokens.get(p, {}).get("account", ""), "redirect_uri": _redirect(p)}
            for p in PROVIDERS}
