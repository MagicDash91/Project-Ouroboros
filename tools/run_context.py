"""
tools/run_context.py – which database the current Analytics run is working on.

This used to live in os.environ["ACTIVE_DB_URI"], which is one value for the whole process: while
run A was going, any other code path (a second user's Model lab call, a monitor, another run) read
run A's database. Now it is a ContextVar, so the value belongs to the run's own thread and anything
it starts:

  with use_db(uri):            # set for this run; restored when the block ends
      ...
  set_db(mart_uri)             # change it inside the run (dbt marts built)
  current_db()                 # the run's database, else Ouroboros's own POSTGRES_URI

Python 3.12 threads do not inherit ContextVars (3.14 adds that), and CrewAI runs agents in its own
ThreadPoolExecutor when max_execution_time is set. install_thread_inheritance() (called on import)
makes new threads and executor submissions carry the caller's context, the same rule 3.14 uses.

last_run_db(owner) keeps the most recent run's database per account for screens used after a run
(Model lab key drivers, data monitors created from a run), never across accounts.
"""

import concurrent.futures
import contextvars
import threading
from contextlib import contextmanager

_active_db: contextvars.ContextVar = contextvars.ContextVar("ouro_active_db", default=None)
_last_by_owner: dict = {}
_lock = threading.Lock()


def _fallback() -> str:
    from config import POSTGRES_URI
    return POSTGRES_URI


def current_db(default: str = None) -> str:
    """The database of the run this code is part of, else default, else POSTGRES_URI."""
    return _active_db.get() or default or _fallback()


def run_db():
    """The run's database, or None outside a run."""
    return _active_db.get()


def set_db(uri, owner: str = ""):
    """Set the run's database (and remember it for after-run screens)."""
    _active_db.set(uri or None)
    if uri and owner is not None:
        remember(owner, uri)


@contextmanager
def use_db(uri, owner: str = None):
    token = _active_db.set(uri or None)
    if uri and owner is not None:
        remember(owner, uri)
    try:
        yield
    finally:
        _active_db.reset(token)


def remember(owner: str, uri: str):
    if uri:
        with _lock:
            _last_by_owner[owner or ""] = uri


def last_run_db(owner: str = None) -> str:
    """Most recent run database of this account (or of the single local user), else POSTGRES_URI."""
    with _lock:
        return _last_by_owner.get(owner or "") or _fallback()


# ── Threads inherit the caller's context (Python 3.14 semantics) ─────────────

_installed = False


def install_thread_inheritance():
    global _installed
    if _installed:
        return
    _installed = True

    orig_init = threading.Thread.__init__
    orig_run = threading.Thread.run

    def __init__(self, *a, **kw):
        orig_init(self, *a, **kw)
        self._ouro_ctx = contextvars.copy_context()

    def run(self):
        ctx = getattr(self, "_ouro_ctx", None)
        if ctx is None:
            return orig_run(self)
        return ctx.run(orig_run, self)

    threading.Thread.__init__ = __init__
    threading.Thread.run = run

    orig_submit = concurrent.futures.ThreadPoolExecutor.submit

    def submit(self, fn, /, *args, **kwargs):
        return orig_submit(self, contextvars.copy_context().run, fn, *args, **kwargs)

    concurrent.futures.ThreadPoolExecutor.submit = submit


install_thread_inheritance()
