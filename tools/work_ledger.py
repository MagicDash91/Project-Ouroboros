"""
tools/work_ledger.py – proof that agents actually used their tools.

LLM agents sometimes answer without calling any tool and invent the results. The crew
wraps its modelling/charting tools so every *successful* call is recorded here, and task
guardrails reject an answer when the matching kind of work never happened.
"""

import json
import threading
import time

_lock = threading.Lock()
_calls: list = []          # (timestamp, kind, tool_name)


def reset() -> None:
    with _lock:
        _calls.clear()
        unverified.clear()


def record(kind: str, tool_name: str) -> None:
    with _lock:
        _calls.append((time.time(), kind, tool_name))


def done(kind: str) -> list:
    """Tool names of successful calls of this kind since the last reset."""
    with _lock:
        return [name for _, k, name in _calls if k == kind]


def _succeeded(result) -> bool:
    try:
        return json.loads(result).get("status") in ("success", "partial")
    except Exception:
        return False


_wrapped: set = set()


def track(tool_obj, kind: str):
    """Wrap a CrewAI tool so successful calls are recorded under `kind` (idempotent —
    the crew is rebuilt for every run but the tool objects are module-level singletons)."""
    if id(tool_obj) in _wrapped:
        return tool_obj
    _wrapped.add(id(tool_obj))
    original = tool_obj.func

    def run(*args, **kwargs):
        result = original(*args, **kwargs)
        if _succeeded(result):
            record(kind, tool_obj.name)
        return result

    tool_obj.func = run
    return tool_obj


unverified: list = []      # task kinds whose answers were accepted without tool backing


def require(kind: str, instruction: str, max_rejections: int = 2):
    """CrewAI guardrail: pass only if at least one `kind` tool call succeeded.

    After `max_rejections` retries the answer is accepted but stamped UNVERIFIED, so one
    stubborn agent can't fail the whole run (CrewAI raises once retries are exhausted).
    """
    state = {"rejections": 0}

    def guardrail(output):
        if done(kind):
            return True, output
        if state["rejections"] >= max_rejections:
            unverified.append(kind)
            raw = getattr(output, "raw", str(output))
            return True, (f"[UNVERIFIED — no successful {kind} tool result backed this answer; "
                          f"treat its numbers as unconfirmed]\n\n{raw}")
        state["rejections"] += 1
        return False, ("Rejected: your answer is not backed by any successful tool result. "
                       + instruction + " Then answer using only the numbers the tools returned.")
    return guardrail
