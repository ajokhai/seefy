"""FastAPI app: REST API, WebSocket endpoint and the built web app."""

from __future__ import annotations

import asyncio
import io
import time
from contextlib import asynccontextmanager
from pathlib import Path

import qrcode
import qrcode.image.svg
from fastapi import Body, FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import DOCS, Config
from .hub import Hub
from .lens import LensStore
from .metrics import MetricsLog
from .recorder import Recorder
from . import resources
from .scan import ScanStore
from .spaces import Spaces
from .spacemap import SpaceMap
from .wifi import live as wifi_live
from .tagmap import TagMap

WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"


def create_app(data: Path, public_url: str = "") -> FastAPI:
    cfg = Config(data / "config.json")
    tagmap = TagMap(data / "tagmap", cfg)
    lens = LensStore(data / "devices", cfg)
    recorder = Recorder(data / "sessions")
    metrics = MetricsLog(data / "metrics")
    hub = Hub(cfg, tagmap, lens, recorder, metrics)
    scans = ScanStore(data / "scans")
    hub.scans = scans
    spaces = Spaces(data / "spaces.json", scans)
    hub.spaces = spaces
    def scan_cfg() -> dict:
        """Scan settings plus the Processing limits (cores, priority, photo size), read fresh each time."""
        return {**cfg["scan"], "processing": cfg["processing"]}

    space_maps: dict[str, SpaceMap] = {}
    joining = asyncio.Lock()  # one space join at a time; joins share the CPU with live mapping

    def space_map(space_id: str) -> SpaceMap:
        if space_id not in space_maps:
            space_maps[space_id] = SpaceMap(data / "spaces" / space_id, data / "scans", scan_cfg())
        space_maps[space_id].cfg = scan_cfg()  # pick up settings changes
        return space_maps[space_id]

    async def join_space(space_id: str, scan_id: str | None = None) -> None:
        """Rebuild the space's merged map with all its scans, joining the new one where it overlaps."""
        sp = spaces.get(space_id)
        if not sp or not sp.get("scans"):
            return
        spaces.set_map(space_id, "joining")
        await hub.broadcast({"type": "space_map", "space_id": space_id, "status": "joining", "scan_id": scan_id})
        async with joining:
            try:
                res = await asyncio.to_thread(space_map(space_id).build, list(sp["scans"]), cfg["coverage"],
                                              cfg["quality"], sp.get("measured_scale"))
            except Exception as exc:  # a failed join must never leave the space stuck on "joining"
                res = {"ok": False, "error": f"joining failed: {exc}", "pieces": sp.get("pieces", [])}
        pieces = res.get("pieces", [])
        spaces.set_map(space_id, "ready" if res.get("ok") else "none", pieces)
        joined = bool(res.get("joined", {}).get(scan_id)) if scan_id else None
        metrics.event("space_join", space_id=space_id, scan_id=scan_id, ok=res.get("ok"), joined=joined,
                      pieces=len(pieces), registered=res.get("registered"), total=res.get("total"),
                      timings_s=res.get("timings_s"), error=res.get("error"))
        await hub.broadcast({"type": "space_map", "space_id": space_id, "status": "ready" if res.get("ok") else "failed",
                             "scan_id": scan_id, "joined": joined, "pieces": pieces,
                             "quality": res.get("quality"), "error": res.get("error")})
        await hub.broadcast({"type": "space", "space": spaces.summary()})
    processing = asyncio.Lock()  # one reconstruction at a time

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        hub.start()
        wifi.start()
        # Scans interrupted by a restart (recording, queued or processing) are finished now,
        # from their saved frames, so nothing is left stuck "processing" forever.
        for m in scans.list():
            if m.get("status") in ("recording", "queued", "processing"):
                s = scans.get(m["id"])
                if s and s.count >= 10:
                    s.update_meta(status="queued", recovered=time.time())
                    metrics.event("scan_recovered", id=s.id, was=m.get("status"), frames=s.count)
                    asyncio.create_task(process_scan(s))
                elif s:
                    s.update_meta(status="failed", error="interrupted before enough video was saved")
        yield
        await wifi.stop()
        await hub.stop()

    app = FastAPI(title="Seefy", lifespan=lifespan)
    app.state.hub = hub
    wifi = wifi_live.attach(app, hub, cfg, data)  # the laptop's own WiFi signal: motion detection, /api/wifi

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await hub.connect(socket)

    @app.get("/api/state")
    def state():
        return hub.state() | {"url": public_url}

    @app.get("/api/config")
    def get_config():
        return {"values": cfg.values, "overrides": cfg.overrides, "docs": DOCS}

    @app.put("/api/config")
    async def put_config(changes: dict = Body(...)):
        cfg.update(changes)
        metrics.event("config_change", changes=changes)
        await hub.broadcast_config()
        return {"values": cfg.values, "overrides": cfg.overrides, "docs": DOCS}

    @app.post("/api/config/reset")
    async def reset_config():
        cfg.reset()
        metrics.event("config_change", changes="reset to defaults")
        await hub.broadcast_config()
        return {"values": cfg.values, "overrides": cfg.overrides, "docs": DOCS}

    @app.get("/api/tagmap")
    def get_tagmap():
        return tagmap.to_json()

    @app.post("/api/tagmap/solve")
    async def solve_tagmap():
        return await hub.solve_now()

    @app.post("/api/tagmap/reset")
    async def reset_tagmap():
        tagmap.reset()
        metrics.event("map_reset")
        await hub.broadcast_tagmap()
        return tagmap.to_json()

    @app.get("/api/lens/{device}")
    def get_lens(device: str):
        return lens.get(device) or {}

    @app.post("/api/lens/{device}/calibrate")
    async def calibrate_lens(device: str):
        result = await asyncio.to_thread(lens.calibrate, device)
        metrics.event("lens_calibration", device=device, **{k: v for k, v in result.items() if k not in ("K", "D")})
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
        metrics.event("session_start", **s.summary())
        await hub.broadcast_session()
        return s.summary()

    @app.post("/api/session/stop")
    async def stop_session():
        summary = recorder.stop()
        if summary:
            metrics.event("session_stop", **summary)
        await hub.broadcast_session()
        return summary or {}

    @app.get("/api/sessions")
    def sessions():
        return recorder.list()

    @app.post("/api/scans/start")
    async def scan_start(body: dict = Body(default={})):
        space_id, room_id = spaces.target(body.get("space_id"), body.get("room_id"))
        s = scans.start(str(body.get("device", ""))[:64])
        s.lens = lens.get(str(body.get("device", ""))[:64])
        mode = body.get("mode") or ("extend" if spaces.get(space_id).get("scans") else "new")
        s.update_meta(space_id=space_id, room_id=room_id, mode=mode)
        metrics.event("scan_start", id=s.id, device=body.get("device"), room_id=room_id)
        await hub.broadcast({"type": "scan", "id": s.id, "room_id": room_id, "status": "recording"})
        asyncio.create_task(live_mapping(s))
        return {"id": s.id, "room_id": room_id, "space_id": space_id, "mode": mode, "settings": cfg["scan"]}

    @app.post("/api/scans/{sid}/scale")
    async def scan_scale(sid: str, body: dict = Body(...)):
        """Fix the map's size from one measured length: a wall (index into layout.walls) or two points."""
        s = scans.get(sid)
        res = s.result() if s else None
        if not res or not res.get("ok"):
            raise HTTPException(404, "no finished scan")
        try:
            measured = float(body["measured_m"])
            if "wall" in body:
                current = float(res["layout"]["walls"][int(body["wall"])]["length_m"])
            else:
                a, b = body["a"], body["b"]
                current = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
        except (KeyError, IndexError, TypeError, ValueError):
            raise HTTPException(400, "send measured_m with a wall index or two points a and b")
        if not 0.2 <= measured <= 50:
            raise HTTPException(400, "that length doesn't look right")
        out = await asyncio.to_thread(s.set_scale, measured, current, cfg["quality"])
        if not out:
            raise HTTPException(400, "couldn't rescale")
        metrics.event("scan_scale", id=sid, measured_m=measured, previous_m=round(current, 3))
        await hub.broadcast({"type": "scan", "id": sid, "room_id": s.meta().get("room_id"), "status": "done",
                             "quality": out["quality"], "room_size_m": out["room_size_m"]})
        await hub.broadcast({"type": "space", "space": spaces.summary()})
        return {"quality": out["quality"], "layout": out["layout"], "scale_method": out["scale_method"]}

    @app.post("/api/scans/{sid}/resume")
    async def scan_resume(sid: str):
        """Scan more: keep adding frames to a finished scan, extending its map."""
        s = scans.get(sid)
        if not s or s.meta().get("status") in ("recording", "queued", "processing"):
            raise HTTPException(409, "scan is busy or missing")
        s.update_meta(status="recording", resumed=time.time())
        metrics.event("scan_resume", id=sid, frames=s.count)
        await hub.broadcast({"type": "scan", "id": sid, "room_id": s.meta().get("room_id"), "status": "recording"})
        asyncio.create_task(live_mapping(s))
        return {"id": sid, "frames": s.count, "settings": cfg["scan"]}

    @app.post("/api/scans/{sid}/frame")
    async def scan_frame(sid: str, request: Request, t: float):
        s = scans.get(sid)
        if not s:
            raise HTTPException(404, "no such scan")
        return {"frames": await asyncio.to_thread(s.add_frame, t, await request.body())}

    @app.post("/api/scans/{sid}/stop")
    async def scan_stop(sid: str):
        s = scans.get(sid)
        if not s:
            raise HTTPException(404, "no such scan")
        meta = s.update_meta(status="queued", stopped=time.time(), frames=s.count)
        metrics.event("scan_stop", id=sid, frames=s.count, duration_s=round(meta["stopped"] - meta["started"], 1))
        asyncio.create_task(process_scan(s))
        await hub.broadcast({"type": "scan", "id": sid, "status": "queued", "frames": s.count})
        return meta

    @app.post("/api/scans/{sid}/reprocess")
    async def scan_reprocess(sid: str):
        """Rebuild a scan's map from its saved frames, e.g. after changing settings."""
        s = scans.get(sid)
        if not s or s.meta().get("status") in ("recording", "queued", "processing"):
            raise HTTPException(409, "scan is busy or missing")
        s.mapper = None  # start the map from scratch with the current settings
        s.lens = lens.get(s.meta().get("device", ""))
        s.update_meta(status="queued")
        metrics.event("scan_reprocess", id=sid)
        asyncio.create_task(process_scan(s))
        await hub.broadcast({"type": "scan", "id": sid, "status": "queued", "frames": s.count})
        return s.meta()

    async def live_mapping(s) -> None:
        """Extend the map every few seconds while the phone is still recording."""
        while s.meta().get("status") == "recording":
            # The live map refreshes no more often than the Processing setting allows.
            await asyncio.sleep(max(cfg["scan"]["live_interval_s"], resources.plan(cfg["processing"])["live_every_s"]))
            if s.meta().get("status") != "recording":
                break
            async with processing:
                live = await asyncio.to_thread(s.live_update, scan_cfg(), cfg["coverage"], cfg["quality"])
            if live:
                metrics.event("scan_live", id=s.id, **{k: live.get(k) for k in ("registered", "frames", "update_s")},
                              level=(live.get("coverage") or {}).get("level"))
                await hub.broadcast({"type": "scan", "id": s.id, "status": "recording", "live": live})

    async def process_scan(s) -> None:
        loop = asyncio.get_running_loop()

        def progress(stage: str, frac: float) -> None:
            asyncio.run_coroutine_threadsafe(hub.broadcast(
                {"type": "scan", "id": s.id, "status": "processing", "stage": stage, "progress": frac}), loop)

        async with processing:
            result = await asyncio.to_thread(s.process, scan_cfg(), progress, cfg["coverage"], cfg["quality"])
        summary = {k: result.get(k) for k in ("ok", "error", "registered", "total", "scale_method", "up_method",
                                              "room_size_m", "timings_s", "coverage", "quality")}
        metrics.event("scan_processed", id=s.id, **summary)
        meta = s.meta()
        if result["ok"] and meta.get("space_id") and meta.get("room_id"):
            spaces.activate_scan(meta["space_id"], meta["room_id"], s.id)  # a good scan becomes the room's map
        if meta.get("space_id") and s.count >= 10:
            # Every scan goes into its space's map, even a weak one: it may still join through shared views.
            spaces.add_scan(meta["space_id"], s.id)
            asyncio.create_task(join_space(meta["space_id"], s.id))
        await hub.broadcast({"type": "scan", "id": s.id, "room_id": meta.get("room_id"),
                             "status": "done" if result["ok"] else "failed", **summary})
        await hub.broadcast({"type": "space", "space": spaces.summary()})

    @app.get("/api/scans")
    def scan_list():
        return scans.list()

    @app.get("/api/scans/latest")
    def scan_latest():
        return scans.latest_result() or {}

    @app.get("/api/scans/{sid}/frames/{name}")
    def scan_frame_image(sid: str, name: str):
        s = scans.get(sid)
        path = s.frame_path(name) if s else None
        if not path:
            raise HTTPException(404, "no such frame")
        return FileResponse(path, media_type="image/jpeg")

    @app.get("/api/scans/{sid}/live")
    def scan_live(sid: str):
        s = scans.get(sid)
        if not s:
            raise HTTPException(404, "no such scan")
        return s.live() or {}

    @app.get("/api/scans/{sid}")
    def scan_get(sid: str):
        s = scans.get(sid)
        if not s:
            raise HTTPException(404, "no such scan")
        return {"meta": s.meta(), "result": s.result()}

    # -- spaces and rooms ---------------------------------------------------

    async def space_changed() -> None:
        await hub.broadcast({"type": "space", "space": spaces.summary()})

    @app.get("/api/spaces")
    def spaces_list():
        return spaces.list()

    @app.post("/api/spaces")
    async def spaces_create(body: dict = Body(default={})):
        sp = spaces.create_space(str(body.get("name", "")))
        await space_changed()
        return spaces.space_view(sp)

    @app.patch("/api/spaces/{sid}")
    async def spaces_update(sid: str, body: dict = Body(default={})):
        sp = spaces.update_space(sid, body)
        if not sp:
            raise HTTPException(404, "no such space")
        await space_changed()
        return spaces.space_view(sp)

    @app.delete("/api/spaces/{sid}")
    async def spaces_delete(sid: str):
        if not spaces.delete_space(sid):
            raise HTTPException(404, "no such space")
        await space_changed()
        return {"ok": True}

    @app.get("/api/spaces/{sid}/map")
    def spaces_map(sid: str):
        m = spaces.map(sid)
        if not m:
            raise HTTPException(404, "no such space")
        merged = space_map(sid).result() if spaces.get(sid).get("scans") else None
        if not merged or not merged.get("ok"):
            # Not joined yet: fall back to the newest finished scan in the space.
            for r in reversed(m["rooms"]):
                if r.get("map"):
                    merged = r["map"]
                    break
        if merged:
            merged = dict(merged)
            merged["layout"] = dict(merged.get("layout") or {})
            spaces.name_rooms(sid, merged["layout"])
        m["map"] = merged
        m["status"] = spaces.get(sid).get("map_status", "none")
        m["pieces"] = spaces.get(sid).get("pieces", [])
        return m

    @app.post("/api/spaces/{sid}/join")
    async def spaces_join(sid: str):
        """Rebuild the space's merged map now (e.g. after settings change)."""
        if not spaces.get(sid):
            raise HTTPException(404, "no such space")
        asyncio.create_task(join_space(sid))
        return {"ok": True}

    @app.post("/api/spaces/{sid}/rooms")
    async def rooms_create(sid: str, body: dict = Body(default={})):
        r = spaces.create_room(sid, str(body.get("name", "")))
        if not r:
            raise HTTPException(404, "no such space")
        await space_changed()
        return spaces.room_view(r)

    @app.patch("/api/spaces/{sid}/rooms/{rid}")
    async def rooms_update(sid: str, rid: str, body: dict = Body(default={})):
        r = spaces.update_room(sid, rid, body)
        if not r:
            raise HTTPException(404, "no such room")
        await space_changed()
        return spaces.room_view(r)

    @app.delete("/api/spaces/{sid}/rooms/{rid}")
    async def rooms_delete(sid: str, rid: str):
        if not spaces.delete_room(sid, rid):
            raise HTTPException(404, "no such room")
        await space_changed()
        return {"ok": True}

    @app.post("/api/spaces/{sid}/rooms/{rid}/activate-scan")
    async def rooms_activate_scan(sid: str, rid: str, body: dict = Body(...)):
        r = spaces.activate_scan(sid, rid, str(body.get("scan_id", "")))
        if not r:
            raise HTTPException(404, "no such room or scan")
        await space_changed()
        return spaces.room_view(r)

    @app.post("/api/log")
    def client_log(body: dict = Body(default={})):
        """Errors reported by the browser (e.g. a scan that failed to start), so they show up in the results log."""
        metrics.event("client_error", where=str(body.get("where", ""))[:80], message=str(body.get("message", ""))[:500],
                      device=str(body.get("device", ""))[:64])
        return {"ok": True}

    @app.get("/api/qr.svg")
    def qr_svg():
        img = qrcode.make(public_url or "https://seefy.local:8443", image_factory=qrcode.image.svg.SvgPathImage,
                          box_size=10, border=2)
        buf = io.BytesIO()
        img.save(buf)
        return Response(buf.getvalue(), media_type="image/svg+xml")

    if WEB_DIST.exists():
        @app.middleware("http")
        async def no_stale_pages(request, call_next):
            response = await call_next(request)
            if request.url.path in ("/", "/index.html", "/print.html", "/tag-worker.js"):
                response.headers["Cache-Control"] = "no-cache"
            return response

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
