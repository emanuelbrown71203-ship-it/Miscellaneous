"""Phone access: let a phone on the same Wi-Fi use Clutch, paired by a key carried in a QR code."""
from __future__ import annotations

import os
import secrets
import socket

from . import config

COOKIE = "clutch_key"
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def enabled() -> bool:
    return os.environ.get("CLUTCH_PHONE") == "1"


def port() -> int:
    return int(os.environ.get("CLUTCH_PORT", "8765"))


def key() -> str:
    """Pairing key, kept on disk so a paired phone stays paired across restarts."""
    config.ensure_dirs()
    f = config.DATA_DIR / "phone.key"
    if f.exists():
        k = f.read_text(encoding="utf-8").strip()
        if len(k) >= 16:
            return k
    k = secrets.token_urlsafe(18)
    f.write_text(k, encoding="utf-8")
    try:
        f.chmod(0o600)
    except OSError:
        pass
    return k


def lan_ip() -> str:
    """This PC's address on the local network (no packets are sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def url() -> str:
    return f"http://{lan_ip()}:{port()}/?key={key()}"


def qr_svg(text: str) -> str:
    import io

    import segno
    buf = io.BytesIO()
    segno.make(text, error="m").save(buf, kind="svg", scale=6, border=2, dark="#12142a", light="#ffffff",
                                     xmldecl=False, svgns=True, nl=False)
    return buf.getvalue().decode("utf-8")


def allowed(client_host: str, cookie: str) -> bool:
    if client_host in LOOPBACK:
        return True
    return bool(cookie) and secrets.compare_digest(cookie, key())
