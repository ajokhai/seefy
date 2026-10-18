"""FastAPI app: REST API, WebSocket endpoint and the built web app."""

from __future__ import annotations

import io
from contextlib import asynccontextmanager
from pathlib import Path

import qrcode
import qrcode.image.svg
from fastapi import Body, FastAPI, HTTPException, WebSocket
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import Config
from .hub import Hub
from .lens import LensStore
from .recorder import Recorder
from .tagmap import TagMap

WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"


def create_app(data: Path, public_url: str = "") -> FastAPI:
    cfg = Config(data / "config.json")
    tagmap = TagMap(data / "tagmap", cfg)
    lens = LensStore(data / "devices", cfg)
    recorder = Recorder(data / "sessions")
    hub = Hub(cfg, tagmap, lens, recorder)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        hub.start()
        yield
        await hub.stop()

    app = FastAPI(title="Seefy", lifespan=lifespan)
    app.state.hub = hub

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await hub.connect(socket)

    @app.get("/api/state")
    def state():
        return hub.state() | {"url": public_url}

    @app.get("/api/config")
    def get_config():
        return {"values": cfg.values, "overrides": cfg.overrides}

    @app.put("/api/config")
    async def put_config(changes: dict = Body(...)):
        cfg.update(changes)
        await hub.broadcast_config()
        return {"values": cfg.values, "overrides": cfg.overrides}

    @app.post("/api/config/reset")
    async def reset_config():
        cfg.reset()
        await hub.broadcast_config()
        return {"values": cfg.values, "overrides": cfg.overrides}

    @app.get("/api/tagmap")
    def get_tagmap():
        return tagmap.to_json()

    @app.post("/api/tagmap/solve")
    async def solve_tagmap():
        return await hub.solve_now()

    @app.post("/api/tagmap/reset")
    async def reset_tagmap():
        tagmap.reset()
        await hub.broadcast_tagmap()
        return tagmap.to_json()

    @app.get("/api/lens/{device}")
    def get_lens(device: str):
        return lens.get(device) or {}

    @app.post("/api/lens/{device}/calibrate")
    async def calibrate_lens(device: str):
        import asyncio

        result = await asyncio.to_thread(lens.calibrate, device)
        if result.get("ok"):
            await hub.send_lens(device)
        return result

    @app.post("/api/lens/{device}/reset")
    async def reset_lens(device: str):
        lens.reset(device)
        await hub.send_lens(device)
        return {"ok": True}

    @app.post("/api/session/start")
    async def start_session(body: dict = Body(...)):
        try:
            s = recorder.start(body.get("kind", "walk"), str(body.get("notes", ""))[:500], {
                "config": cfg.snapshot(),
                "tagmap": tagmap.to_json(),
                "devices": [d.summary() for d in hub.devices.values()],
                "lens": {d.id: lens.get(d.id) for d in hub.devices.values() if d.role == "phone"},
            })
        except ValueError as e:
            raise HTTPException(400, str(e))
        await hub.broadcast_session()
        return s.summary()

    @app.post("/api/session/stop")
    async def stop_session():
        summary = recorder.stop()
        await hub.broadcast_session()
        return summary or {}

    @app.get("/api/sessions")
    def sessions():
        return recorder.list()

    @app.get("/api/qr.svg")
    def qr_svg():
        img = qrcode.make(public_url or "https://seefy.local:8443", image_factory=qrcode.image.svg.SvgPathImage,
                          box_size=10, border=2)
        buf = io.BytesIO()
        img.save(buf)
        return Response(buf.getvalue(), media_type="image/svg+xml")

    if WEB_DIST.exists():
        app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
    else:
        @app.get("/")
        def not_built():
            return HTMLResponse("<h1>Seefy</h1><p>The web app isn't built yet. Run <code>npm run build</code> in "
                                "<code>web/</code>, then reload.</p>")

    return app


def create_http_helper(https_url: str, ca_path: Path) -> FastAPI:
    """Plain-HTTP helper on the LAN: redirects to HTTPS and serves the local CA certificate."""
    helper = FastAPI()

    @helper.get("/ca.crt")
    def ca():
        return Response(ca_path.read_bytes(), media_type="application/x-x509-ca-cert",
                        headers={"Content-Disposition": "attachment; filename=seefy-ca.crt"})

    @helper.get("/")
    def index():
        return HTMLResponse(f"""<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Seefy</title><body style="font:16px system-ui;max-width:36rem;margin:2rem auto;padding:0 1rem">
<h1>Seefy</h1><p><a href="{https_url}" style="font-size:1.2em">Open Seefy &rarr;</a></p>
<h2>Trust this computer (optional, one time)</h2>
<p>Without this, your browser shows a warning the first time. You can accept it and carry on.</p>
<p><b>iPhone:</b> <a href="/ca.crt">download the certificate</a>, then Settings &rarr; Profile Downloaded
&rarr; Install. Then Settings &rarr; General &rarr; About &rarr; Certificate Trust Settings &rarr; turn on
&ldquo;Seefy local CA&rdquo;.</p>
<p><b>Android:</b> <a href="/ca.crt">download the certificate</a>, then Settings &rarr; Security &rarr;
Encryption &amp; credentials &rarr; Install a certificate &rarr; CA certificate.</p></body>""")

    return helper
