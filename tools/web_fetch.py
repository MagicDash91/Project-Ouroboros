"""
tools/web_fetch.py – open ONE web page in a headless browser and print its text as JSON.

Run as a short-lived subprocess by features/agent.py, which kills it after a hard timeout:
pages can hang a browser indefinitely (busy scripts, dialogs, redirect loops) and Playwright
has no timeout for reading page text, so isolating each fetch keeps the agent responsive.

    python -I tools/web_fetch.py <project_root> <url>
    → {"ok": true, "title": str, "text": str, "url": final_url} | {"ok": false, "error": str}

Navigations (including redirects) to private, loopback or link-local hosts are refused (SSRF).
"""

import json
import re
import sys

MAX_TEXT = 200_000


def main(root: str, url: str) -> dict:
    sys.path.insert(0, root)
    from features.agent import AgentError, _public_host
    from playwright.sync_api import sync_playwright

    _public_host(url)
    with sync_playwright() as pw:
        browser, last = None, None
        # Playwright's own Chromium if it's downloaded, else the system's Chrome or Edge.
        for channel in (None, "chrome", "msedge"):
            try:
                browser = pw.chromium.launch(headless=True, **({"channel": channel} if channel else {}))
                break
            except Exception as e:                                           # noqa: BLE001
                last = e
        if browser is None:
            raise RuntimeError(f"no browser available ({str(last).splitlines()[0][:160]}); "
                               "run `python -m playwright install chromium`")
        ctx = browser.new_context(accept_downloads=False,
                                  user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                             "(KHTML, like Gecko) Chrome/126 Safari/537.36")
        ctx.set_default_timeout(12_000)

        def guard(route):
            req = route.request
            if req.is_navigation_request():
                try:
                    _public_host(req.url)
                except AgentError:
                    return route.abort()
            if req.resource_type in ("image", "media", "font"):
                return route.abort()
            return route.continue_()

        ctx.route("**/*", guard)
        page = ctx.new_page()
        page.on("dialog", lambda d: d.dismiss())
        page.goto(url, timeout=25_000, wait_until="domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=4_000)
        except Exception:
            pass
        try:
            title = page.locator("title").first.text_content(timeout=3_000) or ""
        except Exception:
            title = ""
        text = page.locator("body").inner_text(timeout=10_000) or ""
        final = page.url
        browser.close()
    text = re.sub(r"\n{3,}", "\n\n", text).strip()[:MAX_TEXT]
    return {"ok": True, "title": title.strip()[:300], "text": text, "url": final}


if __name__ == "__main__":
    try:
        out = main(sys.argv[1], sys.argv[2])
    except Exception as e:                                                   # noqa: BLE001
        msg = str(e).splitlines()[0][:300] if str(e) else type(e).__name__
        out = {"ok": False, "error": msg}
    sys.stdout.write(json.dumps(out))
