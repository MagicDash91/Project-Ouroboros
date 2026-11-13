"""
tools/url_guard.py – one SSRF guard for every outbound request a user or the AI can aim.

Used by the Agent's browser, app connectors (file URL), Workflow alerts, data monitors' webhooks
and Scheduled Delivery. A URL passes only if it is http(s) on a host whose EVERY resolved address
is globally routable: loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16 –
cloud metadata), carrier-grade NAT (100.64/10), multicast, reserved and IPv4-mapped IPv6 forms of
those are refused, as are localhost / *.local / *.internal names.

post_json() never follows redirects (a public host could 302 to an internal one).
"""

import ipaddress
import socket
from urllib.parse import urlparse


class UnsafeURLError(ValueError):
    pass


_BLOCKED_SUFFIXES = (".local", ".internal", ".localhost", ".lan", ".home.arpa")


def _blocked_ip(ip) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return not ip.is_global or ip.is_multicast


def check_public_url(url: str, https_only: bool = False) -> str:
    """Return the host, or raise UnsafeURLError with a short reason a person can act on."""
    u = urlparse((url or "").strip())
    schemes = ("https",) if https_only else ("http", "https")
    if u.scheme not in schemes or not u.hostname:
        raise UnsafeURLError("the address must start with https://" if https_only
                             else "only public http(s) URLs can be opened")
    if u.username or u.password:
        raise UnsafeURLError("addresses with a user name or password in them are not allowed")
    host = u.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith(_BLOCKED_SUFFIXES):
        raise UnsafeURLError("local and internal addresses are blocked")
    try:
        infos = socket.getaddrinfo(host, u.port or (443 if u.scheme == "https" else 80))
    except (socket.gaierror, UnicodeError):
        raise UnsafeURLError(f"can't resolve {host}")
    if not infos:
        raise UnsafeURLError(f"can't resolve {host}")
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0].split("%")[0])
        except ValueError:
            raise UnsafeURLError(f"can't resolve {host}")
        if _blocked_ip(ip):
            raise UnsafeURLError("private, loopback and internal network addresses are blocked")
    return host


def post_json(url: str, body, timeout: float = 15, https_only: bool = True, headers: dict = None):
    """POST JSON to a public address, no redirects. Returns the httpx.Response."""
    import httpx
    check_public_url(url, https_only=https_only)
    return httpx.post(url, json=body, timeout=timeout, follow_redirects=False, headers=headers or {})
