// Guide screen: setup as a short sequence of steps, one at a time.
//
// Default (markerless): scan the room with the phone, the laptop builds the map, check it on Live.
// Optional tag mode: printed or on-screen tags for live, extra-accurate tracking.
// Each step has one instruction and one main button; progress is remembered on this phone.

import { openCameraSheet, requestMotionPermission, type CameraSheet } from "./camera";
import { conn, isTouch } from "./conn";
import { ScanRecorder, type ScanStats } from "./scan";
import { Tracker, type FrameResult } from "./tracker";
import { MapView } from "./mapview";
import { fmt, h, toast } from "./ui";

type Mode = "scan" | "tags";

interface Step {
  id: string;
  title: string;
  isDone: () => boolean;
  render: (body: HTMLElement) => void;
}

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: progress just isn't remembered */
  }
}

let tracker: Tracker | null = null;

export function guideScreen(): { el: HTMLElement; destroy: () => void } {
  let mode: Mode = load("seefy.guide.mode", "scan");
  const done = new Set<string>(load("seefy.guide.done", []));
  let open: string | null = null;
  const offs: (() => void)[] = [];

  const markDone = (id: string) => {
    done.add(id);
    save("seefy.guide.done", [...done]);
    open = null;
    renderAll();
  };

  // ---- scan state (from the host) -------------------------------------------

  let scan: { id?: string; status?: string; stage?: string; progress?: number; [k: string]: any } = {};
  async function refreshScan() {
    try {
      const list = await conn.api("/api/scans");
      if (list.length && !scan.id) scan = { ...list[0] };
      if (list.length && list[0].id === scan.id) scan = { ...scan, ...list[0] };
      if (scan.status === "done" && scan.room_size_m === undefined) {
        const { result } = await conn.api(`/api/scans/${scan.id}`);
        if (result) scan = { ...scan, room_size_m: result.room_size_m, scale_method: result.scale_method,
                             coverage: result.coverage, layout: result.layout };
      }
    } catch {
      /* host restarting */
    }
    renderAll();
  }

  // ---- full-screen camera: markerless scan -----------------------------------

  const roomName = () => {
    const sp = conn.state?.space;
    return sp?.rooms?.find((r: any) => r.id === sp.active_room)?.name ?? null;
  };

  async function openScanCamera(resumeId?: string) {
    const motionAllowed = requestMotionPermission(); // must start inside the tap on iOS
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (e: any) {
      toast(`Camera unavailable: ${e.message ?? e}`);
      return;
    }
    let wake: any = null;
    try {
      wake = await (navigator as any).wakeLock?.request("screen");
    } catch {
      /* fine without */
    }
    const rec = { r: null as ScanRecorder | null, live: null as any };
    const offLive = conn.on("scan", (m) => {
      if (rec.r && m.id === rec.r.id && m.live) {
        rec.live = m.live;
        coach(sheet, rec.r.stats, rec.live);
      }
    });
    const finish = () => {
      offLive();
      stream.getTracks().forEach((t) => t.stop());
      wake?.release?.();
    };
    const sheet: CameraSheet = openCameraSheet({
      shutterLabel: "Start scan",
      onShutter: async () => {
        if (!rec.r) {
          rec.r = new ScanRecorder(sheet.video);
          rec.r.onStats = (s) => coach(sheet, s, rec.live);
          sheet.setShutter("recording");
          try {
            await rec.r.start(resumeId);
          } catch (e: any) {
            const message = e?.message ?? String(e);
            rec.r = null;
            sheet.setShutter("idle");
            sheet.setHint(`Couldn't start the scan: ${message}`);
            toast(`Couldn't start the scan: ${message}`);
            conn.api("/api/log", "POST", { where: "scan start", message, device: conn.id }).catch(() => {});
            return;
          }
          if (!(await motionAllowed)) toast("Motion sensors are off, so turn speed and scale can't be measured.");
        } else {
          sheet.setShutter("busy");
          sheet.setHint("Finishing upload…");
          try {
            await rec.r.stop();
            scan = { id: rec.r.id, status: "queued" };
          } catch (e: any) {
            toast(e.message);
          }
          finish();
          sheet.close();
          renderAll();
        }
      },
      onClose: () => {
        if (rec.r?.running) {
          rec.r.stop().catch(() => {});
          scan = { id: rec.r.id, status: "queued" };
        }
        finish();
        renderAll();
      },
    });
    sheet.video.srcObject = stream;
    sheet.video.play().catch(() => {});
    sheet.setStatus(roomName() ? `Ready · ${roomName()}` : "Ready");
    sheet.setHint("Lights on. Hold the phone upright and steady. Tap the button, then walk slowly around the room, pointing across it.");
  }

  /** Live coaching on the camera: turn speed from the gyroscope (instant), coverage from the laptop's map. */
  function coach(sheet: CameraSheet, s: ScanStats, live: any) {
    const cfg = conn.config?.scan ?? {};
    const limit = (cfg.max_turn_deg_per_frame ?? 5) * (cfg.capture_fps ?? 8);
    const m = Math.floor(s.seconds / 60);
    const sec = Math.floor(s.seconds % 60).toString().padStart(2, "0");
    if (s.motion) sheet.setMeter(s.turnRate / limit, `${Math.round(s.turnRate)}°/s`);

    const cov = live?.coverage;
    const enoughAt = conn.config?.coverage?.enough ?? 0.7;
    if (cov && !cov.error) {
      const words = { short: "Keep scanning", enough: "Enough ✓ You can stop", extra: "Extra sure ✓✓" } as Record<string, string>;
      sheet.setProgress(cov.score, enoughAt, `${words[cov.level] ?? ""} · ${live.registered} of ${live.frames} frames placed`, cov.level);
    } else {
      sheet.setProgress(Math.min(0.15, s.frames / 400), enoughAt, `${s.frames} frames · building the map…`);
    }
    sheet.setStatus(`● ${m}:${sec}`, cov?.level === "enough" || cov?.level === "extra" ? "ok" : "rec");

    // Most urgent first: things the phone can see right now, then the map's advice.
    if (s.brightness < 35) sheet.setHint("Too dark: turn on the lights.");
    else if (s.motion && s.turnRate > 2 * limit) sheet.setHint("Turn much slower: frames are being lost.");
    else if (s.motion && s.turnRate > limit) sheet.setHint("Turn slower.");
    else if (s.blurry > 0.5) sheet.setHint(s.brightness < 70 ? "Blurry: more light helps, and hold the phone steady." : "Blurry: hold the phone steadier and move slower.");
    else if (cov?.level === "extra") sheet.setHint("Room covered. Tap the button to finish.");
    else if (cov?.level === "enough") sheet.setHint(`That's enough. ${cov.hints?.[0] ? `For extra margin: ${cov.hints[0].toLowerCase()}` : "Keep going for extra margin, or tap to finish."}`);
    else if (cov?.hints?.length) sheet.setHint(cov.hints[0]);
    else if (s.seconds < 8) sheet.setHint("Walk slowly around the room, pointing the camera across it at furniture, corners and doors.");
    else sheet.setHint("Keep walking. Point across the room, not at a blank wall up close.");
  }

  // ---- full-screen camera: tags ----------------------------------------------

  async function openTagCamera(trackMode: "track" | "lens", sessionKind?: "map" | "walk") {
    if (!tracker) tracker = new Tracker(document.createElement("video"));
    const tr = tracker;
    const sheet = openCameraSheet({
      onClose: async () => {
        tr.stop();
        tr.onResult = () => {};
        if (conn.session) await conn.api("/api/session/stop", "POST").catch(() => {});
        renderAll();
      },
    });
    tr.video = sheet.video;
    tr.setMode(trackMode);
    tr.onStatus = (s) => s && sheet.setStatus(s);
    tr.onResult = (r) => drawTags(sheet, r, tr);
    if (sessionKind && !conn.session) await conn.api("/api/session/start", "POST", { kind: sessionKind }).catch(() => {});
    try {
      await tr.start();
    } catch (e: any) {
      toast(`Camera failed: ${e.message ?? e}`);
      sheet.close();
      return;
    }
    sheet.setHint(trackMode === "lens"
      ? "Point at the grid and move slowly: tilt, closer, further, every part of the screen."
      : "Keep a green tag in view. Turn slowly so each new tag appears next to a green one.");
  }

  let lensViews = 0;
  function drawTags(sheet: CameraSheet, r: FrameResult, tr: Tracker) {
    const { w, h: hh } = tr.size;
    const c = sheet.overlay;
    if (c.width !== w || c.height !== hh) {
      c.width = w;
      c.height = hh;
    }
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, w, hh);
    const mapped = conn.tagmap?.tags ?? {};
    const roomMax = conn.config?.tracking?.room_tag_max_id ?? 49;
    g.lineWidth = Math.max(3, w / 220);
    g.font = `700 ${Math.round(w / 26)}px system-ui`;
    for (const d of r.dets) {
      const color = d.id > roomMax ? "#4c8dff" : mapped[d.id] ? "#30d158" : "#ff9f0a";
      g.strokeStyle = color;
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(d.c[0], d.c[1]);
      for (let i = 2; i < 8; i += 2) g.lineTo(d.c[i], d.c[i + 1]);
      g.closePath();
      g.stroke();
      if (d.id <= roomMax) g.fillText(String(d.id), d.c[0], d.c[1] - 10);
    }
    if (tr.mode === "lens") {
      const need = conn.config?.lens?.min_views ?? 12;
      sheet.setStatus(conn.lens?.ok ? "Calibrated ✓" : `${lensViews} of ${need} views`, conn.lens?.ok ? "ok" : "");
    } else {
      const n = Object.keys(mapped).length;
      sheet.setStatus(r.pose?.ok ? `Tracking · ${n} tags mapped` : `${n} tags mapped`, r.pose?.ok ? "ok" : "warn");
    }
  }

  // ---- steps -----------------------------------------------------------------

  const phoneConnected = () => (conn.state?.devices ?? []).find((d: any) => d.role === "phone");
  const scanSteps: Step[] = [
    ...(isTouch ? [] : [{
      id: "phone",
      title: "Open Seefy on your phone",
      isDone: () => done.has("phone") || !!phoneConnected(),
      render: (b: HTMLElement) => {
        const phone = phoneConnected();
        if (phone) {
          b.append(h("p", { class: "good" }, `✓ ${phone.name} connected. Carry on there.`));
          return;
        }
        b.append(
          h("p", {}, "Scanning uses your phone's camera. Scan this code with the phone (same WiFi), then carry on there."),
          h("img", { src: "/api/qr.svg", width: 160, height: 160, class: "qr", alt: "QR code to open Seefy" }),
          h("p", { class: "muted" }, "This step ticks itself when the phone connects."),
          h("button", { class: "link-btn", onclick: () => markDone("phone") }, "Skip"),
        );
      },
    }]),
    {
      id: "scan",
      title: "Scan the room",
      isDone: () => !!scan.id,
      render: (b) => b.append(
        h("p", {}, "Walk slowly around the room with the camera, like filming a video. The room's corners, door, windows " +
          "and ceiling lights become its reference points. No markers needed."),
        h("ul", { class: "tips" },
          h("li", {}, "Lights on, phone upright and steady"),
          h("li", {}, "Walk around the room, pointing across it at furniture, corners and doors"),
          h("li", {}, "Not at a blank wall up close: it has nothing to lock onto"),
          h("li", {}, "The bar tells you when you've got enough")),
        roomName() ? h("p", { class: "muted" }, `Saving to: ${roomName()}`) : "",
        h("button", { class: "primary", onclick: () => openScanCamera() }, "Open camera"),
      ),
    },
    {
      id: "build",
      title: "Build the map",
      isDone: () => scan.status === "done",
      render: (b) => {
        if (!scan.id) {
          b.append(h("p", { class: "muted" }, "Scan the room first."));
          return;
        }
        if (scan.status === "failed") {
          b.append(h("p", { class: "bad" }, scan.error || "The map couldn't be built."),
            h("button", { class: "primary", onclick: () => openScanCamera() }, "Scan again"));
          return;
        }
        const stages: Record<string, string> = {
          features: "Finding corners, edges and lights",
          matching: "Matching frames",
          mapping: "Placing the camera in 3D",
          aligning: "Finding the floor and the scale",
        };
        b.append(
          h("p", {}, scan.status === "queued" ? "Waiting to start…" : stages[scan.stage ?? ""] ?? "Working…"),
          h("div", { class: "bar" }, h("div", { style: `width:${Math.round(100 * (scan.progress ?? 0.02))}%` })),
          h("p", { class: "muted" }, "This runs on your laptop and usually takes a few minutes."),
        );
      },
    },
    {
      id: "review",
      title: "Review the scan",
      isDone: () => done.has(`saved-${scan.id}`),
      render: (b) => {
        const cov = scan.coverage;
        const lay = scan.layout;
        const size = lay?.ok ? lay.size_m : scan.room_size_m;
        const words: Record<string, string> = { short: "Partial", enough: "Good", extra: "Very good" };
        const canvas = h("canvas", { class: "review-map" });
        b.append(
          h("p", { class: cov?.level === "short" ? "warn-text" : "good" },
            `${words[cov?.level] ?? "Done"} scan${size ? ` · about ${fmt(size[0], 1)} × ${fmt(size[1], 1)} m` : ""}` +
            `${roomName() ? ` · ${roomName()}` : ""}`),
          canvas,
          cov?.level === "short" && cov.hints?.length ? h("p", { class: "muted" }, `To improve it: ${cov.hints[0].toLowerCase()}`) : "",
          h("button", { class: "primary", onclick: () => markDone(`saved-${scan.id}`) }, "Save room"),
          h("button", { class: "link-btn", onclick: () => openScanCamera(scan.id) }, "Scan more (adds to this scan)"),
          h("button", { class: "link-btn subtle", onclick: () => openScanCamera() }, "Retake from scratch"),
        );
        // Draw the plan once the canvas is in the page.
        requestAnimationFrame(async () => {
          const view = new MapView(canvas);
          try {
            view.setScan(await conn.api(`/api/scans/${scan.id}`).then((r) => r.result));
          } catch {
            /* preview is optional */
          }
          setTimeout(() => view.destroy(), 1500); // static preview: stop the redraw loop after it has drawn
        });
      },
    },
  ];

  const mappedCount = () => Object.keys(conn.tagmap?.tags ?? {}).length;
  const tagSteps: Step[] = [
    {
      id: "t-show",
      title: "Put up the tags",
      isDone: () => done.has("t-show"),
      render: (b) => b.append(
        h("p", {}, "Print them, or show them on screens you already have (monitor, laptop, tablet, old phone)."),
        h("p", {}, h("a", { href: "/print.html", target: "_blank" }, "Open the tags page")),
        h("ul", { class: "tips" },
          h("li", {}, h("b", {}, "Tag 0"), " is the starting point. Lay a printed one flat on the floor, or show it on a monitor."),
          h("li", {}, "Spread 2–4 more around the room, each visible from where another one is.")),
        h("button", { class: "primary", onclick: () => markDone("t-show") }, "Done"),
      ),
    },
    {
      id: "t-lens",
      title: "Calibrate the camera (optional)",
      isDone: () => !!conn.lens?.ok || done.has("t-lens"),
      render: (b) => b.append(
        h("p", {}, "Point the camera at the grid of small tags and move it around. It calibrates itself."),
        h("button", { class: "primary", onclick: () => openTagCamera("lens") }, "Open camera"),
        h("button", { class: "link-btn", onclick: () => markDone("t-lens") }, "Skip"),
      ),
    },
    {
      id: "t-map",
      title: "Map the tags",
      isDone: () => mappedCount() >= 2 && done.has("t-map"),
      render: (b) => b.append(
        h("p", {}, "Start with tag 0 in view, then turn slowly so each tag appears next to one that's already green."),
        h("p", { class: "muted" }, `${mappedCount()} tags mapped so far`),
        h("button", { class: "primary", onclick: () => openTagCamera("track", "map") }, "Open camera"),
        mappedCount() >= 2 ? h("button", { class: "link-btn", onclick: () => markDone("t-map") }, "Done mapping") : "",
      ),
    },
    {
      id: "t-walk",
      title: "Walk around",
      isDone: () => done.has("t-walk"),
      render: (b) => b.append(
        h("p", {}, "Walk around with the camera facing forward. Your path appears on Live."),
        h("button", { class: "primary", onclick: () => openTagCamera("track", "walk") }, "Open camera"),
        h("button", { class: "link-btn", onclick: () => markDone("t-walk") }, "Done"),
      ),
    },
  ];

  // ---- rendering ---------------------------------------------------------------

  const list = h("div", { class: "steps" });
  const head = h("div", { class: "guide-head" });
  const foot = h("div", { class: "guide-foot" });
  const el = h("div", { class: "guide" }, head, list, foot);

  function renderAll() {
    const steps = mode === "scan" ? scanSteps : tagSteps;
    const current = open ?? steps.find((s) => !s.isDone())?.id ?? null;
    const n = steps.filter((s) => s.isDone()).length;
    head.replaceChildren(
      h("h2", {}, current ? `Step ${steps.findIndex((s) => s.id === current) + 1} of ${steps.length}` : "All set"),
      h("div", { class: "bar" }, h("div", { style: `width:${(100 * n) / steps.length}%` })),
      // Finished: always offer the next scan, never a dead end.
      ...(!current && mode === "scan" ? [h("section", { class: "card next-scan" },
        h("p", {}, roomName() ? `${roomName()} is saved.` : "Room saved."),
        h("button", { class: "primary", onclick: () => openScanCamera() }, "New scan"),
        scan.id ? h("button", { class: "link-btn", onclick: () => openScanCamera(scan.id) }, "Scan more of this room") : "",
        h("p", { class: "muted" }, "Manage rooms in the Rooms tab."))] : []),
    );
    list.replaceChildren(...steps.map((s, i) => {
      const isDone = s.isDone();
      const isOpen = s.id === current;
      const card = h("section", { class: `step ${isDone ? "done" : ""} ${isOpen ? "open" : ""}` },
        h("button", {
          class: "step-title",
          onclick: () => {
            open = isOpen ? null : s.id;
            renderAll();
          },
        }, h("span", { class: "num" }, isDone ? "✓" : String(i + 1)), s.title));
      if (isOpen) {
        const body = h("div", { class: "step-body" });
        s.render(body);
        card.append(body);
      }
      return card;
    }));
    foot.replaceChildren(
      h("button", {
        class: "link-btn",
        onclick: () => {
          mode = mode === "scan" ? "tags" : "scan";
          save("seefy.guide.mode", mode);
          open = null;
          renderAll();
        },
      }, mode === "scan" ? "Use tags instead (printed or on a screen)" : "Back to scanning without tags"),
      h("button", {
        class: "link-btn subtle",
        onclick: () => {
          if (!confirm("Start the guide again? Nothing you've recorded is deleted.")) return;
          done.clear();
          save("seefy.guide.done", []);
          scan = {};
          open = null;
          renderAll();
        },
      }, "Start the guide again"),
    );
  }

  offs.push(
    conn.on("scan", (m) => {
      if (!scan.id || m.id === scan.id || m.status === "recording") scan = { ...(m.id === scan.id ? scan : {}), ...m };
      if (m.status === "done" && m.id === scan.id) refreshScan(); // pull the layout for the review step
      // A new or resumed scan reopens the review for that scan.
      if (m.status === "recording" && m.id) done.delete(`saved-${m.id}`);
      renderAll();
    }),
    conn.on("lens_view", async (m) => {
      if (!m.accepted) return;
      lensViews = m.views;
      if (lensViews >= (conn.config?.lens?.min_views ?? 12) && !conn.lens?.ok) {
        const r = await conn.api(`/api/lens/${conn.id}/calibrate`, "POST").catch(() => null);
        if (r?.ok) conn.lens = r;
      }
    }),
    conn.on("tagmap", renderAll),
    conn.on("state", () => {
      const present = !!phoneConnected();
      if (present !== phoneWasPresent) {
        phoneWasPresent = present;
        renderAll();
      }
    }),
  );
  let phoneWasPresent = !!phoneConnected();
  refreshScan();
  renderAll();
  return { el, destroy: () => offs.forEach((off) => off()) };
}
