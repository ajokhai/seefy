// Guide screen: setup as a short sequence of steps, one at a time.
//
// Default (markerless): scan the room with the phone, the laptop builds the map, check it on Live.
// Optional tag mode: printed or on-screen tags for live, extra-accurate tracking.
// Each step has one instruction and one main button; progress is remembered on this phone.

import { openCameraSheet, type CameraSheet } from "./camera";
import { conn, isTouch } from "./conn";
import { startScan } from "./scanflow";
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

  /** Run the full scan flow (scanflow.ts) and pick up its result here. */
  async function runScan(resumeScanId?: string) {
    const out = await startScan({ resumeScanId, skipPrep: !!resumeScanId });
    if (out.scanId) {
      scan = { ...(scan.id === out.scanId ? scan : {}), id: out.scanId };
      if (out.action === "saved") done.add(`saved-${out.scanId}`);
      save("seefy.guide.done", [...done]);
      await refreshScan();
    }
    renderAll();
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
        h("button", { class: "primary", onclick: () => runScan() }, "Open camera"),
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
            h("button", { class: "primary", onclick: () => runScan() }, "Scan again"));
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
          h("button", { class: "link-btn", onclick: () => runScan(scan.id) }, "Scan more (adds to this scan)"),
          h("button", { class: "link-btn subtle", onclick: () => runScan() }, "Retake from scratch"),
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
        h("button", { class: "primary", onclick: () => runScan() }, "New scan"),
        scan.id ? h("button", { class: "link-btn", onclick: () => runScan(scan.id) }, "Scan more of this room") : "",
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
