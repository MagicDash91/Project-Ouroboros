"""
features/auth.py – user accounts: sign up, log in, log out, who am I.

Accounts are email + password. Passwords are hashed with scrypt (salt per user); sessions are random
tokens kept only as SHA-256 hashes, sent to the browser in an HttpOnly cookie (SameSite=Lax) and valid
for SESSION_DAYS. Failed log-ins are throttled per email and per client address.

Storage: data/auth/users.json and data/auth/sessions.json (atomic writes, one lock).
Turn the sign-in requirement off for local scripts with AUTH_REQUIRED=0 (see app.py's middleware).
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUTH_DIR = ROOT / "data" / "auth"
USERS = AUTH_DIR / "users.json"
SESSIONS = AUTH_DIR / "sessions.json"
COOKIE = "ouro_session"
SESSION_DAYS = 30
MIN_PASSWORD = 8
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,}$")
_lock = threading.RLock()
_fails: dict = {}                     # key -> [timestamps of recent failures]
FAIL_WINDOW, FAIL_LIMIT = 15 * 60, 8


class AuthError(Exception):
    def __init__(self, msg: str, status: int = 400):
        super().__init__(msg)
        self.status = status


def required() -> bool:
    return os.getenv("AUTH_REQUIRED", "1").strip().lower() not in ("0", "false", "no", "off")


def _read(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def _write(p: Path, data: dict):
    AUTH_DIR.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def _hash_pw(password: str, salt: bytes) -> str:
    return hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32).hex()


def _token_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _public(u: dict) -> dict:
    return {"id": u["id"], "email": u["email"], "name": u.get("name", ""), "created_at": u.get("created_at", "")}


def _throttle(keys: list):
    now = time.time()
    with _lock:
        for k in keys:
            recent = [t for t in _fails.get(k, []) if now - t < FAIL_WINDOW]
            _fails[k] = recent
            if len(recent) >= FAIL_LIMIT:
                raise AuthError("Too many attempts. Wait a few minutes and try again.", 429)


def _failed(keys: list):
    with _lock:
        for k in keys:
            _fails.setdefault(k, []).append(time.time())


def _new_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    with _lock:
        sessions = _read(SESSIONS)
        now = time.time()
        sessions = {k: v for k, v in sessions.items() if v.get("expires", 0) > now}     # drop expired ones
        sessions[_token_key(token)] = {"user": user_id, "expires": now + SESSION_DAYS * 86400}
        _write(SESSIONS, sessions)
    return token


def signup(email: str, password: str, name: str = "") -> tuple:
    """Create an account and sign it in. Returns (user, session token)."""
    email = (email or "").strip().lower()
    name = re.sub(r"\s+", " ", (name or "").strip())[:80]
    if not _EMAIL.match(email):
        raise AuthError("Enter a valid email address.")
    if len(password or "") < MIN_PASSWORD:
        raise AuthError(f"Use at least {MIN_PASSWORD} characters for the password.")
    if len(password) > 256:
        raise AuthError("That password is too long.")
    with _lock:
        users = _read(USERS)
        if any(u["email"] == email for u in users.values()):
            raise AuthError("An account with this email already exists. Log in instead.", 409)
        salt = secrets.token_bytes(16)
        uid = uuid.uuid4().hex[:12]
        users[uid] = {"id": uid, "email": email, "name": name, "salt": salt.hex(), "hash": _hash_pw(password, salt),
                      "created_at": datetime.now().isoformat(timespec="seconds")}
        _write(USERS, users)
    return _public(users[uid]), _new_session(uid)


def login(email: str, password: str, client: str = "") -> tuple:
    email = (email or "").strip().lower()
    keys = [f"e:{email}", f"c:{client}"]
    _throttle(keys)
    with _lock:
        user = next((u for u in _read(USERS).values() if u["email"] == email), None)
    # always hash, so a missing account takes as long as a wrong password
    salt = bytes.fromhex(user["salt"]) if user else b"\0" * 16
    ok = hmac.compare_digest(_hash_pw(password or "", salt), user["hash"] if user else "0" * 64)
    if not (user and ok):
        _failed(keys)
        raise AuthError("Email or password is incorrect.", 401)
    with _lock:
        _fails.pop(f"e:{email}", None)
    return _public(user), _new_session(user["id"])


def user_for(token: str):
    """The signed-in user for a session token, or None."""
    if not token:
        return None
    with _lock:
        s = _read(SESSIONS).get(_token_key(token))
        if not s or s.get("expires", 0) < time.time():
            return None
        u = _read(USERS).get(s["user"])
    return _public(u) if u else None


def logout(token: str):
    if not token:
        return
    with _lock:
        sessions = _read(SESSIONS)
        if sessions.pop(_token_key(token), None) is not None:
            _write(SESSIONS, sessions)
