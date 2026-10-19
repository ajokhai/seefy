// The scan experience on the phone, end to end, on its own full-screen layer:
//   Before you scan (prep cards) -> camera (mini-map, one instruction, progress ring)
//   -> finishing -> review (plan, size, honest verdict) -> optional "check the size".
//
// Call startScan() from onboarding, Rooms -> Rescan, or "Add a room"; it resolves when the user
// saves or cancels. "Scan more" loops back into the camera inside the same promise.

import { openCameraSheet, requestMotionPermission, type CameraSheet } from "./camera";
import { conn } from "./conn";
import { drawPlan } from "./plan2d";
import { ScanRecorder, type ScanStats } from "./scan";
import { h, toast } from "./ui";

export interface Quality {
  verdict: "good" | "weak";
  reasons: { code: string; text: string }[];
  missing_heading_deg: number | null;
  size_m: number[] | null;
  size_source: "estimated" | "measured";
}

export interface ScanOutcome {
  action: "saved" | "cancelled";
  scanId: string | null;
  roomId: string | null;
  quality: Quality | null;
}

const icon = (path: string) => {
  const span = h("span", { class: "ico" });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  return span;
};
const ICONS = {
  light: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  steady: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  across: '<path d="M3 21l7-7"/><circle cx="14" cy="10" r="3"/><path d="M21 3l-4.5 4.5"/><path d="M3 3h6M3 3v6"/>',
};

function roomName(roomId: string | null): string | null {
  const sp = conn.state?.space;
  return sp?.rooms?.find((r: any) => r.id === (roomId ?? sp.active_room))?.name ?? null;
}

/** Draw a scan's floor plan into a canvas; returns screen<->world helpers for tapping walls. */
function drawRoom(canvas: HTMLCanvasElement, result: any, opts: { wall?: number; missing?: number | null } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 320;
  const H = canvas.clientHeight || 320;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const lay = result?.layout;
  const pts: number[][] = (result?.points ?? []).filter((q: number[]) => q[2] > 0.15 && q[2] < 2.3);
  const extent: number[][] = lay?.ok && lay.outline?.length ? lay.outline : pts.map((q) => [q[0], q[1]]);
  if (!extent.length) return null;
  const xs = extent.map((q) => q[0]).sort((a, b) => a - b);
  const ys = extent.map((q) => q[1]).sort((a, b) => a - b);
  const k = lay?.ok ? 0 : Math.floor(xs.length * 0.03);
  const [x0, x1, y0, y1] = [xs[k], xs[xs.length - 1 - k], ys[k], ys[ys.length - 1 - k]];
  const pad = 36;
  const s = Math.min((W - 2 * pad) / Math.max(x1 - x0, 0.5), (H - 2 * pad) / Math.max(y1 - y0, 0.5));
  const ox = (W - s * (x1 - x0)) / 2;
  const oy = (H - s * (y1 - y0)) / 2;
  const X = (x: number) => ox + (x - x0) * s;
  const Y = (y: number) => H - (oy + (y - y0) * s);

  if (lay?.ok) drawPlan(g, lay, X, Y, s);
  else {
    g.fillStyle = "rgba(128, 128, 140, 0.55)";
    for (const q of pts) g.fillRect(X(q[0]) - 1, Y(q[1]) - 1, 2, 2);
  }
  // The side that's missing, shaded from the middle of the room toward it.
  if (opts.missing != null) {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const r = Math.max(x1 - x0, y1 - y0) * 0.75;
    const a = (opts.missing * Math.PI) / 180;
    g.fillStyle = "rgba(255, 159, 10, 0.22)";
    g.beginPath();
    g.moveTo(X(cx), Y(cy));
    for (let t = -0.7; t <= 0.71; t += 0.1) g.lineTo(X(cx + r * Math.cos(a + t)), Y(cy + r * Math.sin(a + t)));
    g.closePath();
    g.fill();
  }
  if (opts.wall != null && lay?.walls?.[opts.wall]) {
    const w = lay.walls[opts.wall];
    g.strokeStyle = "#0a84ff";
    g.lineWidth = 6;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(X(w.a[0]), Y(w.a[1]));
    g.lineTo(X(w.b[0]), Y(w.b[1]));
    g.stroke();
  }
  return { toWorld: (px: number, py: number) => [x0 + (px - ox) / s, y0 + (H - py - oy) / s] };
}

function nearestWall(walls: any[], p: number[]): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  walls.forEach((w, i) => {
    const [ax, ay] = w.a;
    const [bx, by] = w.b;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
    if (d < bestD) [best, bestD] = [i, d];
  });
  return best;
}

export function startScan(opts: { spaceId?: string; mode?: "extend" | "new"; roomId?: string; roomName?: string;
  resumeScanId?: string; skipPrep?: boolean } = {}): Promise<ScanOutcome> {
  return new Promise((resolve) => {
    const layer = h("div", { class: "flow" });
    document.body.append(layer);
    document.body.classList.add("cam-open");
    let scanId: string | null = opts.resumeScanId ?? null;
    const roomId: string | null = opts.roomId ?? conn.state?.space?.active_room ?? null;
    const name = () => opts.roomName ?? roomName(roomId) ?? conn.state?.space?.name ?? null;
    // Extending: the space already has a map, so this scan should start where it overlaps.
    const extending = () => !opts.resumeScanId && (opts.mode ?? ((conn.state?.space?.scans ?? 0) > 0 ? "extend" : "new")) === "extend";
    let join: { status: string; joined?: boolean | null } | null = null;
    let result: any = null;
    const offs: (() => void)[] = [];

    const done = (action: ScanOutcome["action"]) => {
      offs.forEach((off) => off());
      layer.remove();
      document.body.classList.remove("cam-open");
      resolve({ action, scanId, roomId, quality: result?.quality ?? null });
    };
    const screen = (...children: (Node | string | null)[]) => {
      layer.hidden = false;
      layer.replaceChildren(h("div", { class: "flow-inner" }, ...children.filter((c): c is Node | string => c != null)));
      layer.scrollTop = 0;
    };

    // ---- 1. before you scan ------------------------------------------------

    function prep() {
      screen(
        h("h1", {}, "Before you scan"),
        name() ? h("p", { class: "lede" }, `Mapping: ${name()}`) : null,
        h("div", { class: "prep-card" }, icon(ICONS.light), h("div", {}, h("b", {}, "Lights on"), h("span", {}, "The camera needs to see clearly."))),
        h("div", { class: "prep-card" }, icon(ICONS.steady), h("div", {}, h("b", {}, "Move slowly, phone steady"), h("span", {}, "Hold it upright at chest height."))),
        h("div", { class: "prep-card" }, icon(ICONS.across), h("div", {}, h("b", {}, "Point across the room"), h("span", {}, "At furniture, corners and doors. Walk around the room once."))),
        extending() ? h("div", { class: "prep-card" }, icon(ICONS.across), h("div", {}, h("b", {}, "Start where you've already scanned"),
          h("span", {}, "Begin in a part of your home that's on the map, then walk into the new area. Seefy joins them automatically."))) : null,
        h("div", { class: "flow-actions" },
          h("button", { class: "primary", onclick: () => camera() }, "Start scanning"),
          h("button", { class: "link-btn", onclick: () => done("cancelled") }, "Not now")),
      );
    }

    // ---- 2. camera -------------------------------------------------------------

    async function camera(resumeId?: string) {
      const motionAllowed = requestMotionPermission(); // must start inside the tap on iOS
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
      } catch (e: any) {
        toast(`The camera isn't available: ${e.message ?? e}`);
        conn.api("/api/log", "POST", { where: "scan camera", message: String(e?.message ?? e), device: conn.id }).catch(() => {});
        return;
      }
      let wake: any = null;
      try {
        wake = await (navigator as any).wakeLock?.request("screen");
      } catch {
        /* fine without */
      }
      layer.hidden = true;
      let rec: ScanRecorder | null = null;
      let live: any = null;
      let lastPlaced = -1;
      let stalls = 0;
      let mapFetch = 0;

      const release = () => {
        stream.getTracks().forEach((t) => t.stop());
        wake?.release?.();
        offLive();
      };
      const stopAndReview = async () => {
        if (!rec) return;
        sheet.setShutter("busy");
        sheet.setHint("Finishing…");
        try {
          await rec.stop();
        } catch (e: any) {
          toast(e.message);
        }
        release();
        sheet.close();
        finishing();
      };

      const sheet: CameraSheet = openCameraSheet({
        minimap: true,
        shutterLabel: "Start scanning",
        onShutter: async () => {
          if (rec) return stopAndReview();
          rec = new ScanRecorder(sheet.video);
          rec.onStats = (s) => coach(s);
          sheet.setShutter("recording");
          try {
            await rec.start(resumeId, { space_id: opts.spaceId, room_id: opts.roomId, mode: opts.mode });
          } catch (e: any) {
            const message = e?.message ?? String(e);
            rec = null;
            sheet.setShutter("idle");
            sheet.setHint(`Couldn't start: ${message}`);
            conn.api("/api/log", "POST", { where: "scan start", message, device: conn.id }).catch(() => {});
            return;
          }
          scanId = rec.id;
          sheet.setRing(0.02, conn.config?.coverage?.enough ?? 0.7, "short");
          if (!(await motionAllowed)) toast("Motion access is off, so sizes will be less accurate.");
        },
        onClose: () => {
          if (rec?.running) {
            // Don't throw the walk away: finish it and show what we have.
            const r = rec;
            r.stop().catch(() => {}).finally(() => finishing());
            release();
            return;
          }
          release();
          if (resumeId && result) review();
          else if (opts.skipPrep || resumeId) done("cancelled");
          else prep();
        },
      });
      sheet.el.classList.add("minimal");
      sheet.video.srcObject = stream;
      sheet.video.play().catch(() => {});
      sheet.setStatus(name() ?? "");
      sheet.setHint(resumeId ? "Start where you stopped, then cover what's missing."
        : extending() ? "Start somewhere you've already scanned, then walk into the new area."
        : "Tap the button and walk slowly around the room.");

      const offLive = conn.on("scan", (m) => {
        if (!rec || m.id !== rec.id || !m.live) return;
        live = m.live;
        const placed = live.registered ?? 0;
        stalls = placed === lastPlaced && (live.frames ?? 0) > placed ? stalls + 1 : 0;
        lastPlaced = placed;
        const cov = live.coverage && !live.coverage.error ? live.coverage : null;
        if (cov) sheet.setRing(cov.score, conn.config?.coverage?.enough ?? 0.7, cov.level);
        if (Date.now() - mapFetch > 1800) {
          mapFetch = Date.now();
          conn.api(`/api/scans/${m.id}/live`).then(drawMinimap).catch(() => {});
        }
        coach(rec.stats);
      });

      function coach(s: ScanStats) {
        const cfg = conn.config?.scan ?? {};
        const limit = (cfg.max_turn_deg_per_frame ?? 5) * (cfg.capture_fps ?? 8);
        const cov = live?.coverage && !live.coverage.error ? live.coverage : null;
        let text: string;
        if (s.brightness < 35) text = "Too dark. Turn on the lights.";
        else if (s.motion && s.turnRate > limit) text = "Slow down.";
        else if (s.blurry > 0.5) text = "Hold the phone steadier.";
        else if (stalls >= 2) text = "Lost your place. Go back to where you were a moment ago.";
        else if (cov?.level === "extra") text = "Extra sure ✓ Tap to finish.";
        else if (cov?.level === "enough") text = "You can stop now ✓";
        else if (cov?.hints?.length) text = cov.hints[0];
        else if (s.seconds < 6) text = "Walk slowly around the room.";
        else text = "Point across the room at furniture and corners.";
        sheet.setHint(text);
        const sec = Math.floor(s.seconds);
        sheet.setStatus(`${name() ? `${name()} · ` : ""}${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`,
          cov?.level === "enough" || cov?.level === "extra" ? "ok" : "rec");
      }

      function drawMinimap(partial: any) {
        const c = sheet.minimap;
        if (!c || !partial?.frames?.length) return;
        const g = c.getContext("2d")!;
        g.clearRect(0, 0, c.width, c.height);
        const pts: number[][] = (partial.points ?? []).filter((q: number[]) => q[2] > 0.15 && q[2] < 2.3);
        const path: number[][] = partial.frames.map((f: any) => f.p);
        const all = [...pts, ...path];
        const xs = all.map((q) => q[0]).sort((a, b) => a - b);
        const ys = all.map((q) => q[1]).sort((a, b) => a - b);
        const k = Math.floor(xs.length * 0.03);
        const [x0, x1, y0, y1] = [xs[k], xs[xs.length - 1 - k], ys[k], ys[ys.length - 1 - k]];
        const span = Math.max(x1 - x0, y1 - y0, 2);
        const s = (c.width - 40) / span;
        const X = (x: number) => c.width / 2 + (x - (x0 + x1) / 2) * s;
        const Y = (y: number) => c.height / 2 - (y - (y0 + y1) / 2) * s;
        // Missing side, from where you are now.
        const here = path[path.length - 1];
        const gap = partial.coverage?.gap_heading_deg ?? partial.quality?.missing_heading_deg;
        if (gap != null && partial.coverage?.level === "short") {
          const a = (gap * Math.PI) / 180;
          g.fillStyle = "rgba(255, 159, 10, 0.35)";
          g.beginPath();
          g.moveTo(X(here[0]), Y(here[1]));
          for (let t = -0.6; t <= 0.61; t += 0.1) g.lineTo(X(here[0] + span * Math.cos(a + t)), Y(here[1] + span * Math.sin(a + t)));
          g.closePath();
          g.fill();
        }
        g.fillStyle = "rgba(255, 255, 255, 0.75)";
        for (const q of pts) g.fillRect(X(q[0]) - 1.5, Y(q[1]) - 1.5, 3, 3);
        g.strokeStyle = "rgba(10, 132, 255, 0.9)";
        g.lineWidth = 3;
        g.beginPath();
        path.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
        g.stroke();
        g.fillStyle = "#0a84ff";
        g.beginPath();
        g.arc(X(here[0]), Y(here[1]), 8, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = "#fff";
        g.lineWidth = 2;
        g.stroke();
      }
    }

    // ---- 3. finishing ----------------------------------------------------------

    function finishing() {
      const bar = h("div", { class: "bar" }, h("div", { style: "width:5%" }));
      const label = h("p", { class: "lede" }, "Putting your room together…");
      screen(h("div", { class: "finishing" }, h("h1", {}, "Almost done"), label, bar));
      const stages: Record<string, string> = {
        features: "Looking at your video…", matching: "Matching views…", mapping: "Building the room…",
        aligning: "Finding the floor and walls…",
      };
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        offProgress();
        window.clearInterval(poll);
        review();
      };
      const offProgress = conn.on("scan", (m) => {
        if (m.id !== scanId) return;
        if (m.status === "processing") {
          (bar.firstChild as HTMLElement).style.width = `${Math.round(100 * (m.progress ?? 0.1))}%`;
          label.textContent = stages[m.stage] ?? label.textContent;
        }
        if (m.status === "done" || m.status === "failed") settle();
      });
      // Fallback in case a message was missed.
      const poll = window.setInterval(async () => {
        const st = await conn.api(`/api/scans/${scanId}`).catch(() => null);
        if (st?.meta?.status === "done" || st?.meta?.status === "failed") settle();
      }, 2500);
      offs.push(offProgress, () => window.clearInterval(poll));
    }

    // ---- 4. review ---------------------------------------------------------------

    // Joining this scan into the space's map happens after it's processed; track it for the review.
    offs.push(conn.on("space_map", (m) => {
      if (!scanId || (m.scan_id && m.scan_id !== scanId)) return;
      join = { status: m.status, joined: m.joined };
      joinLine?.replaceChildren(joinText());
    }));
    let joinLine: HTMLElement | null = null;
    const joinText = (): string => {
      if (!join || !extending()) return "";
      if (join.status === "joining") return "Joining to your map…";
      if (join.status === "ready" && join.joined) return "Joined to your map ✓";
      if (join.status === "ready") return "Saved as a separate area. Scan somewhere that connects the two to join them.";
      return "";
    };

    async function review() {
      const st = await conn.api(`/api/scans/${scanId}`).catch(() => null);
      result = st?.result ?? null;
      if (!result?.ok) {
        screen(
          h("h1", {}, "That didn't work"),
          h("p", { class: "reason" }, result?.error || "The room couldn't be put together from this video."),
          h("p", { class: "lede" }, "Turn the lights on, move slowly, and point across the room at furniture and corners."),
          h("div", { class: "flow-actions" },
            h("button", { class: "primary", onclick: () => camera() }, "Try again"),
            h("button", { class: "link-btn", onclick: () => done("cancelled") }, "Cancel")),
        );
        return;
      }
      const q: Quality | null = result.quality ?? null;
      const good = q?.verdict === "good";
      const size = q?.size_m;
      const main = q?.reasons?.find((r) => r.code !== "size_estimated");
      const canvas = h("canvas", { class: "flow-plan" });
      screen(
        h("p", { class: "lede" }, name() ?? "Your room"),
        h("p", { class: `verdict ${good ? "good" : "weak"}` }, good ? "Looks good" : "Part of this room is missing"),
        canvas,
        size ? h("p", { class: "size" }, `About ${size[0].toFixed(1)} × ${size[1].toFixed(1)} m` +
          (q?.size_source === "measured" ? " · measured" : " · estimated")) : null,
        (joinLine = h("p", { class: "lede" }, joinText())),
        !good && main ? h("p", { class: "reason" }, main.text) : null,
        h("div", { class: "flow-actions" },
          good
            ? h("button", { class: "primary", onclick: () => done("saved") }, "Save room")
            : h("button", { class: "primary", onclick: () => camera(scanId!) }, "Scan more"),
          good
            ? h("button", { class: "link-btn", onclick: () => camera(scanId!) }, "Scan more")
            : h("button", { class: "link-btn subtle", onclick: () => done("saved") }, "Save anyway"),
          result.layout?.ok && q?.size_source !== "measured"
            ? h("button", { class: "link-btn", onclick: () => measure() }, "Check the size: measure one wall")
            : null),
      );
      requestAnimationFrame(() => drawRoom(canvas, result, { missing: good ? null : q?.missing_heading_deg }));
    }

    // ---- 5. check the size ---------------------------------------------------------

    function measure() {
      const walls: any[] = result?.layout?.walls ?? [];
      let wall: number | null = walls.length ? walls.reduce((bi, w, i) => (w.length_m > walls[bi].length_m ? i : bi), 0) : null;
      const canvas = h("canvas", { class: "flow-plan" });
      const onMap = h("p", { class: "size" });
      const input = h("input", { type: "number", inputmode: "decimal", step: "0.01", min: "0.2", max: "50", placeholder: "e.g. 3.40" });
      let helpers: ReturnType<typeof drawRoom> = null;
      const redraw = () => {
        helpers = drawRoom(canvas, result, { wall: wall ?? undefined });
        onMap.textContent = wall != null ? `On the map this wall is about ${walls[wall].length_m.toFixed(2)} m.` : "";
      };
      canvas.addEventListener("pointerdown", (e) => {
        if (!helpers) return;
        const r = canvas.getBoundingClientRect();
        wall = nearestWall(walls, helpers.toWorld(e.clientX - r.left, e.clientY - r.top));
        redraw();
      });
      screen(
        h("h1", {}, "Check the size"),
        h("p", { class: "lede" }, "Tap a wall, measure it with a tape, and type its real length. Every distance is corrected from it."),
        canvas, onMap,
        h("div", { class: "measure-row" }, input, h("span", { class: "size" }, "metres")),
        h("div", { class: "flow-actions" },
          h("button", {
            class: "primary",
            onclick: async () => {
              const m = Number(input.value);
              if (wall == null || !(m >= 0.2 && m <= 50)) {
                toast("Tap a wall, then type its length in metres.");
                return;
              }
              try {
                await conn.api(`/api/scans/${scanId}/scale`, "POST", { measured_m: m, wall });
                review();
              } catch (e: any) {
                toast(e.message);
              }
            },
          }, "Use this length"),
          h("button", { class: "link-btn", onclick: () => review() }, "Back")),
      );
      requestAnimationFrame(redraw);
    }

    if (opts.resumeScanId) camera(opts.resumeScanId);
    else if (opts.skipPrep) camera();
    else prep();
  });
}
