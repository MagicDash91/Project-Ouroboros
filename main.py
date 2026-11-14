"""
main.py – Entry point for the combined Bank Analytics + Digital Marketing system.

Usage:
    python main.py
    # Then open http://localhost:8002
"""
import sys

import uvicorn

# On Windows, output redirected to a file or pipe defaults to cp1252, and one print() of "→" or "—"
# in a run's progress messages raised UnicodeEncodeError and failed the whole run. Always UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host="127.0.0.1",
        port=8002,
        reload=False,
        log_level="info",
    )
