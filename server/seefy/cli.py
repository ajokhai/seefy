"""`seefy` command: start the host on the local network."""

from __future__ import annotations

import argparse
import asyncio
import io
from pathlib import Path

import qrcode
import uvicorn

from .app import WEB_DIST, create_app, create_http_helper
from .certs import ensure_certs
from .net import MdnsAdvertiser, lan_ip, local_hostname


def main() -> None:
    ap = argparse.ArgumentParser(prog="seefy", description="Seefy host: serves the web app on your LAN.")
    ap.add_argument("--port", type=int, default=8443, help="HTTPS port (default 8443)")
    ap.add_argument("--http-port", type=int, default=8080, help="plain-HTTP helper port, 0 to disable")
    ap.add_argument("--data", type=Path, default=Path("data"), help="data directory (one per space)")
    ap.add_argument("--no-mdns", action="store_true", help="don't advertise seefy.local")
    args = ap.parse_args()

    data = args.data.resolve()
    ip = lan_ip()
    names = ["seefy.local", local_hostname(), "localhost"]
    crt, key, ca = ensure_certs(data / "certs", names, [ip, "127.0.0.1"])
    url = f"https://{ip}:{args.port}"

    mdns = None
    if not args.no_mdns:
        try:
            mdns = MdnsAdvertiser(ip, args.port)
            mdns.start()
        except Exception as exc:
            print(f"mDNS unavailable ({exc}); use the IP address instead.")
            mdns = None

    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    buf = io.StringIO()
    qr.print_ascii(out=buf, invert=True)
    print(buf.getvalue())
    print(f"  Seefy is running. Open on any device on this WiFi:\n")
    print(f"    {url}")
    if mdns:
        print(f"    https://seefy.local:{args.port}")
    if args.http_port:
        print(f"\n  First time on a phone? http://{ip}:{args.http_port} explains how to trust this computer.")
    if not WEB_DIST.exists():
        print("\n  Note: the web app isn't built yet. Run `npm install && npm run build` in web/.")
    print(f"\n  Data: {data}\n")

    async def serve() -> None:
        servers = [uvicorn.Server(uvicorn.Config(
            create_app(data, url), host="0.0.0.0", port=args.port, ssl_certfile=str(crt), ssl_keyfile=str(key),
            log_level="warning", ws_ping_interval=10, ws_ping_timeout=10,
        ))]
        if args.http_port:
            servers.append(uvicorn.Server(uvicorn.Config(
                create_http_helper(url, ca), host="0.0.0.0", port=args.http_port, log_level="warning",
            )))
        await asyncio.gather(*(s.serve() for s in servers))

    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass
    finally:
        if mdns:
            mdns.stop()
