"""
features/billing.py – credit wallet, plans and top-ups for the desk.

Everything is priced in CREDITS (1 credit = $0.01 / Rp 159 at top-up price). Prices, plans and
packs live in ONE file, pricing.json (PRICING_FILE), which /api/billing serves to the frontend
so the two never disagree.

  * Plans (Free · Starter · Pro · Team · Enterprise) grant monthly credits; up to 50% of a plan's
    allowance rolls over one month. Free gets signup credits once plus a small monthly grant.
  * Top-up packs never expire.
  * Credits live in buckets and are spent soonest-expiring first:
    rollover → plan → free_monthly → free_signup → topup.
  * charge() draws from buckets and records which ones; refund() puts credits back where they
    came from (expired buckets refund into top-up credits).

There are no user accounts yet, so the desk has ONE wallet (data/billing/wallet.json). Checkout and
subscriptions are a DEMO: subscribe()/topup() grant credits immediately. Real payments must grant
credits only from a verified Stripe / Xendit webhook.
"""

import calendar
import json
import os
import threading
import uuid
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_PATH = ROOT / "data" / "billing" / "wallet.json"
PRICING_FILE = Path(os.getenv("PRICING_FILE", str(ROOT / "pricing.json")))
ENFORCE = os.getenv("BILLING_ENFORCE", "true").lower() != "false"
LEDGER_KEEP = 300
_lock = threading.RLock()


class InsufficientCredits(Exception):
    pass


InsufficientTokens = InsufficientCredits          # older callers


def pricing() -> dict:
    return json.loads(PRICING_FILE.read_text(encoding="utf-8"))


def cost(action: str) -> int:
    return int(pricing()["actions"][action]["credits"])


def _now() -> datetime:
    return datetime.now()


def _iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def _month_end(start: datetime) -> datetime:
    """Same day next month (clamped), the end of a monthly credit period."""
    y, m = (start.year + 1, 1) if start.month == 12 else (start.year, start.month + 1)
    return start.replace(year=y, month=m, day=min(start.day, calendar.monthrange(y, m)[1]))


def _plan(pid: str) -> dict:
    return next(p for p in pricing()["plans"] if p["id"] == pid)


# ── Wallet storage ────────────────────────────────────────────────────────────

def _new_wallet() -> dict:
    now = _now()
    free = _plan("free")
    w = {"version": 2, "plan": {"id": "free", "interval": "month", "period_start": _iso(now),
                                "period_end": _iso(_month_end(now)), "since": _iso(now)},
         "buckets": [], "ledger": [], "settings": {"spend_cap_usd": free["spend_cap_usd"], "auto_topup": False}}
    _grant(w, "free_signup", free["signup_credits"], None, "Free plan signup credits")
    _grant(w, "free_monthly", free["credits_month"], w["plan"]["period_end"], "Free plan monthly credits")
    return w


def _load() -> dict:
    if not _PATH.exists():
        return _new_wallet()
    w = json.loads(_PATH.read_text(encoding="utf-8"))
    if w.get("version") != 2:
        # Token wallet (demo): archive it read-only and start on Free (the demo balance is not converted).
        archive = _PATH.with_name("wallet_tokens_archive.json")
        if not archive.exists():
            archive.write_text(json.dumps(w, indent=1), encoding="utf-8")
        w = _new_wallet()
        w["ledger"].append(_entry_only("migrate", 0, "Moved from tokens to credits: the demo token balance was archived "
                                                     "(data/billing/wallet_tokens_archive.json) and the desk starts on Free."))
    _roll_period(w)
    return w


def _save(w: dict) -> None:
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    w["ledger"] = w["ledger"][-LEDGER_KEEP:]
    tmp = _PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(w, indent=1), encoding="utf-8")
    os.replace(tmp, _PATH)


def _entry_only(kind: str, credits: int, note: str, ref: str = "", action: str = "", **extra) -> dict:
    return {"id": uuid.uuid4().hex[:12], "ts": _iso(_now()), "kind": kind, "action": action, "credits": credits,
            "note": note, "ref": ref, **extra}


def _grant(w: dict, kind: str, credits: int, expires_at, note: str, ledger_kind: str = "grant") -> dict:
    b = {"id": uuid.uuid4().hex[:10], "kind": kind, "credits": int(credits), "granted": int(credits),
         "expires_at": expires_at, "created_at": _iso(_now())}
    if credits > 0:
        w["buckets"].append(b)
        w["ledger"].append(_entry_only(ledger_kind, int(credits), note, bucket=kind))
    return b


def _roll_period(w: dict) -> None:
    """Close finished monthly periods: expire buckets, roll over up to 50% of the allowance, grant the new month."""
    rules = pricing()["rules"]
    while datetime.fromisoformat(w["plan"]["period_end"]) <= _now():
        end = w["plan"]["period_end"]
        plan = _plan(w["plan"]["id"])
        unused_plan = sum(b["credits"] for b in w["buckets"] if b["kind"] == "plan" and b["expires_at"] == end)
        for b in w["buckets"]:
            if b["expires_at"] and b["expires_at"] <= end and b["credits"] > 0:
                w["ledger"].append(_entry_only("expire", -b["credits"], f"{b['kind'].replace('_', ' ')} credits expired",
                                               bucket=b["kind"]))
                b["credits"] = 0
        start = datetime.fromisoformat(end)
        new_end = _iso(_month_end(start))
        w["plan"].update(period_start=end, period_end=new_end)
        allowance = plan.get("credits_month") or 0
        carry = min(unused_plan, allowance * rules["rollover_pct_of_allowance"] // 100)
        if w["plan"]["id"] != "free" and carry:
            _grant(w, "rollover", carry, new_end, f"Rolled over from last month (max {rules['rollover_pct_of_allowance']}% of the plan)")
        if w["plan"]["id"] == "free":
            _grant(w, "free_monthly", allowance, new_end, "Free plan monthly credits")
        elif allowance:
            _grant(w, "plan", allowance, new_end, f"{plan['name']} plan · monthly credits")
    # Keep empty buckets until they expire, so a refund can return credits to where they came from.
    now = _iso(_now())
    w["buckets"] = [b for b in w["buckets"]
                    if b["credits"] > 0 or not b["expires_at"] or b["expires_at"] > now][-200:]


def _ordered(w: dict) -> list:
    order = {k: i for i, k in enumerate(pricing()["rules"]["spend_order"])}
    return sorted((b for b in w["buckets"] if b["credits"] > 0),
                  key=lambda b: (order.get(b["kind"], 99), b["expires_at"] or "9999"))


def _balance(w: dict) -> int:
    return sum(b["credits"] for b in w["buckets"] if b["credits"] > 0)


def _topup_spend_usd(w: dict) -> float:
    """Money spent on top-ups (manual + automatic) in the current period; the spend cap limits this."""
    start = w["plan"]["period_start"]
    return sum(e.get("usd", 0) for e in w["ledger"] if e["kind"] == "topup" and e["ts"] >= start)


def _add_pack(w: dict, pack: dict, auto: bool = False) -> None:
    """Grant a pack's credits if the period's top-up spend stays within the spend cap (ValueError otherwise)."""
    cap = w["settings"].get("spend_cap_usd")
    spent = _topup_spend_usd(w)
    if cap is not None and spent + pack["usd"] > cap:
        raise ValueError(f"Spend cap reached: ${spent:g} of ${cap:g} already spent on top-ups this period "
                         f"(this pack is ${pack['usd']}). Raise or remove the cap on the Pricing page.")
    _grant(w, "topup", pack["credits"], None,
           f"{'Auto top-up' if auto else pack['name'] + ' top-up'} · {pack['credits']:,} credits · "
           f"${pack['usd']} / Rp {pack['idr']:,} (demo)".replace(",", "."), ledger_kind="topup")
    w["ledger"][-1]["usd"] = pack["usd"]


def _auto_topup(w: dict, need: int) -> None:
    """With auto top-up on, buy the smallest pack until the balance covers `need` and stays above the
    low-balance line, as far as the spend cap allows. Stops quietly at the cap (charge then 402s)."""
    if not w["settings"].get("auto_topup"):
        return
    p = pricing()
    pack = min(p["packs"], key=lambda k: k["usd"])
    floor = p["rules"]["auto_topup_below"]
    for _ in range(20):                                 # bounded; one charge never needs more
        if _balance(w) - need >= floor:
            return
        try:
            _add_pack(w, pack, auto=True)
        except ValueError:
            return


# ── Charging ──────────────────────────────────────────────────────────────────

def charge(action: str, ref: str = "", note: str = "", credits=None) -> str:
    """Spend credits for one action. Returns the ledger id (pass it to `refund`).
    Raises InsufficientCredits (HTTP 402) without charging when the balance is short."""
    need = int(credits if credits is not None else cost(action))
    label = pricing()["actions"].get(action, {}).get("label", action)
    with _lock:
        w = _load()
        _auto_topup(w, need)
        bal = _balance(w)
        if ENFORCE and bal < need:
            _save(w)                                    # keep any auto top-up that did happen
            raise InsufficientCredits(
                f"Not enough credits: this needs {need:,}, your balance is {bal:,}. "
                "Top up or change plan on the Pricing page.")
        draws, left = [], need
        for b in _ordered(w):
            if not left:
                break
            take = min(b["credits"], left)
            b["credits"] -= take
            left -= take
            draws.append({"bucket": b["id"], "kind": b["kind"], "credits": take})
        e = _entry_only("charge", -need, note or label, ref, action, draws=draws)
        w["ledger"].append(e)
        _save(w)
        return e["id"]


def refund(charge_id: str, reason: str) -> None:
    """Reverse a charge once (idempotent); credits return to the buckets they came from."""
    if not charge_id:
        return
    with _lock:
        w = _load()
        if any(e["kind"] == "refund" and e.get("ref") == charge_id for e in w["ledger"]):
            return
        orig = next((e for e in w["ledger"] if e["id"] == charge_id and e["kind"] == "charge"), None)
        if not orig:
            return
        buckets = {b["id"]: b for b in w["buckets"]}
        for d in orig.get("draws", []):
            b = buckets.get(d["bucket"])
            if b and (not b["expires_at"] or datetime.fromisoformat(b["expires_at"]) > _now()):
                b["credits"] += d["credits"]
            else:                                           # its bucket expired meanwhile
                _grant(w, "topup", d["credits"], None, "Refund of expired credits", ledger_kind="refund_grant")
        w["ledger"].append(_entry_only("refund", -orig["credits"], f"Refund: {reason}", charge_id, orig.get("action", "")))
        _save(w)


# ── Plans and top-ups (demo checkout) ─────────────────────────────────────────

def subscribe(plan_id: str, interval: str = "month") -> dict:
    """DEMO: switch plan now and grant its monthly credits (no payment taken)."""
    plan = next((p for p in pricing()["plans"] if p["id"] == plan_id), None)
    if not plan:
        raise ValueError(f"Unknown plan: {plan_id}")
    if plan.get("contact"):
        raise ValueError("Enterprise is sold by contract: contact sales.")
    if interval not in ("month", "year"):
        raise ValueError("interval must be month or year")
    with _lock:
        w = _load()
        now = _now()
        old = w["plan"]["id"]
        # Unused credits of the old plan's month stay until their period ends.
        w["plan"] = {"id": plan_id, "interval": interval, "period_start": _iso(now),
                     "period_end": _iso(_month_end(now)), "since": _iso(now)}
        w["settings"]["spend_cap_usd"] = plan["spend_cap_usd"]
        price = plan["usd_year"] if interval == "year" else plan["usd_month"]
        w["ledger"].append(_entry_only("subscribe", 0, f"Plan changed {old} → {plan_id} "
                                                       f"({'annual' if interval == 'year' else 'monthly'}, ${price}) · demo, no payment"))
        if plan_id == "free":
            _grant(w, "free_monthly", plan["credits_month"], w["plan"]["period_end"], "Free plan monthly credits")
        else:
            _grant(w, "plan", plan["credits_month"], w["plan"]["period_end"], f"{plan['name']} plan · monthly credits")
        _save(w)
    return summary()


def topup(pack_id: str) -> dict:
    """DEMO: add a pack's credits now (no payment taken). Top-up credits never expire."""
    pack = next((p for p in pricing()["packs"] if p["id"] == pack_id), None)
    if not pack:
        raise ValueError(f"Unknown pack: {pack_id}")
    with _lock:
        w = _load()
        _add_pack(w, pack)
        _save(w)
    return summary()


purchase = topup                                    # older callers


def update_settings(spend_cap_usd="keep", auto_topup=None) -> dict:
    """Change the monthly top-up spend cap (None = no cap) and/or auto top-up."""
    with _lock:
        w = _load()
        if spend_cap_usd != "keep":
            if spend_cap_usd is not None and (not isinstance(spend_cap_usd, (int, float)) or spend_cap_usd < 0):
                raise ValueError("spend_cap_usd must be a non-negative number or null")
            w["settings"]["spend_cap_usd"] = spend_cap_usd
        if auto_topup is not None:
            w["settings"]["auto_topup"] = bool(auto_topup)
        _save(w)
    return summary()


def summary() -> dict:
    with _lock:
        w = _load()
        _save(w)                                        # persists a migration or a period roll
    p = pricing()
    by_kind: dict = {}
    for b in w["buckets"]:
        if b["credits"] > 0:
            k = by_kind.setdefault(b["kind"], {"credits": 0, "expires_at": b["expires_at"]})
            k["credits"] += b["credits"]
            if b["expires_at"] and (not k["expires_at"] or b["expires_at"] < k["expires_at"]):
                k["expires_at"] = b["expires_at"]
    month_start = w["plan"]["period_start"]
    used = -sum(e["credits"] for e in w["ledger"] if e["kind"] in ("charge", "refund") and e["ts"] >= month_start)
    return {
        "balance": _balance(w),
        "buckets": by_kind,
        "plan": {**w["plan"], "name": _plan(w["plan"]["id"])["name"]},
        "used_this_period": max(0, used),
        "settings": w["settings"],
        "enforced": ENFORCE,
        "demo_checkout": True,
        "pricing": p,
        "ledger": list(reversed(w["ledger"][-60:])),
    }
