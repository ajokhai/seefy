// Guide screen (phone): setup as a short sequence of steps, one at a time.
//
// Each step has one instruction, one main button, and a clear "done" state.
// Steps that the app can check (lens calibrated, tags mapped) tick themselves;
// the rest are confirmed with a tap. Progress is remembered on this phone.

import { conn } from "./conn";
import { Tracker, type FrameResult } from "./tracker";
import { fmt, h, toast } from "./ui";

type StepId = "print" | "place" | "lens" | "map" | "walk";

interface Step {
  id: StepId;
  title: string;
  render: (body: HTMLElement) => void;
}

const STORE = "seefy.guide";

function loadDone(): Set<StepId> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORE) ?? "[]"));
  } catch {
    return new Set();
  }
}

function saveDone(done: Set<StepId>): void {
  try {
    localStorage.setItem(STORE, JSON.stringify([...done]));
  } catch {
    /* private mode: progress just isn't remembered */
  }
}

let tracker: Tracker | null = null;

export function guideScreen(): { el: HTMLElement; destroy: () => void } {
  const done = loadDone();
  let open: StepId | null = null; // step the user tapped to revisit
  const offs: (() => void)[] = [];

  // One shared camera view, moved into whichever step needs it.
  const video = h("video", { playsinline: true, muted: true, autoplay: true });
  const overlay = h("canvas", { class: "overlay" });
  const pill = h("div", { class: "pill" }, "Camera off");
  const camera = h("div", { class: "camera live" }, video, overlay, pill);
  if (!tracker) tracker = new Tracker(video);
  else {
    tracker.video = video;
    if (tracker.stream) {
      video.srcObject = tracker.stream;
      video.play().catch(() => {});
    }
  }
  const tr = tracker;

  async function startCamera(mode: "track" | "lens") {
    tr.setMode(mode);
    try {
      await tr.start();
    } catch (e: any) {
      toast(`Camera failed: ${e.message ?? e}`);
    }
    renderAll();
  }

  function stopCamera() {
    tr.stop();
    renderAll();
  }

  tr.onStatus = (s) => {
    if (s) pill.textContent = s;
  };

  const markDone = (id: StepId) => {
    done.add(id);
    saveDone(done);
    open = null;
    renderAll();
  };

  // ---- steps ---------------------------------------------------------------

  const origin = () => conn.tagmap?.origin ?? 0;
  const mappedCount = () => Object.keys(conn.tagmap?.tags ?? {}).length;

  const steps: Step[] = [
    {
      id: "print",
      title: "Print the tags",
      render: (b) =>
        b.append(
          h("p", {}, "On your laptop, open the print page and print it at 100% (actual size)."),
          h("p", { class: "link" }, h("a", { href: "/print.html", target: "_blank" }, `${location.host}/print.html`)),
          h("p", { class: "muted" },
            "You get: one big tag (tag 0) for the floor, smaller tags for the walls, and a grid of small tags for calibrating the camera."),
          h("button", { class: "primary", onclick: () => markDone("print") }, "Done, they're printed"),
        ),
    },
    {
      id: "place",
      title: "Place the tags",
      render: (b) =>
        b.append(
          h("ul", {},
            h("li", {}, h("b", {}, "Tag 0"), " flat on the floor, roughly in the middle of the room."),
            h("li", {}, h("b", {}, "Tags 1–4"), " upright on different walls, about chest height."),
            h("li", {}, "The ", h("b", {}, "grid"), " taped flat on a table or wall.")),
          h("button", { class: "primary", onclick: () => markDone("place") }, "Done, they're placed"),
        ),
    },
    {
      id: "lens",
      title: "Calibrate the camera",
      render: (b) => {
        const views = h("b", {}, String(lensViews));
        const need = conn.config?.lens?.min_views ?? 12;
        const bar = h("div", { class: "bar" }, h("div", { style: `width:${Math.min(100, (100 * lensViews) / need)}%` }));
        if (conn.lens?.ok) {
          b.append(
            h("p", { class: "good" }, `Calibrated: field of view ${conn.lens.fov_h_deg}°, fit ${conn.lens.rms_px} px.`),
            h("button", { class: "primary", onclick: () => { stopCamera(); markDone("lens"); } }, "Next"),
          );
          return;
        }
        b.append(h("p", {}, "Point the camera at the grid and move slowly: tilt it, go closer and further, cover every part of the screen."));
        if (tr.running && tr.mode === "lens") {
          b.append(camera, h("p", {}, "Views captured: ", views, ` of ${need}`), bar,
            h("p", { class: "muted" }, "It calibrates by itself once there are enough."));
        } else {
          b.append(h("button", { class: "primary", onclick: () => startCamera("lens") }, "Start camera"));
        }
        b.append(h("button", { class: "link-btn", onclick: () => { stopCamera(); markDone("lens"); } },
          "Skip (tracking works, just less accurately)"));
      },
    },
    {
      id: "map",
      title: "Map the room",
      render: (b) => {
        const recording = conn.session?.kind === "map";
        b.append(h("p", {},
          `Stand back so tag ${origin()} on the floor and one wall tag are both on screen. Then turn slowly so each wall tag ` +
          "appears together with a tag that's already green."));
        if (tr.running && tr.mode === "track") {
          b.append(camera, tagChips());
          b.append(h("p", { class: "muted" }, `${mappedCount()} tag${mappedCount() === 1 ? "" : "s"} mapped` +
            (recording ? " · recording this pass" : "")));
          b.append(h("button", {
            class: "primary",
            disabled: mappedCount() < 2,
            onclick: async () => {
              if (conn.session) await conn.api("/api/session/stop", "POST").catch(() => {});
              markDone("map");
            },
          }, mappedCount() < 2 ? "Map at least 2 tags to continue" : "Done mapping"));
        } else {
          b.append(h("button", {
            class: "primary",
            onclick: async () => {
              if (!conn.session) await conn.api("/api/session/start", "POST", { kind: "map" }).catch(() => {});
              startCamera("track");
            },
          }, "Start camera"));
        }
      },
    },
    {
      id: "walk",
      title: "Walk around",
      render: (b) => {
        const recording = conn.session?.kind === "walk";
        b.append(
          h("p", {}, "Hold the phone at chest height, camera facing forward, and walk around the room."),
          h("p", {}, "On your laptop, open ", h("b", {}, "Live"), ": your path is drawn on the floor plan."),
        );
        if (!(tr.running && tr.mode === "track")) {
          b.append(h("button", { class: "primary", onclick: () => startCamera("track") }, "Start camera"));
          return;
        }
        const p = tr.last?.pose;
        b.append(camera, h("p", { class: p?.ok ? "good" : "muted" },
          p?.ok ? `You're at x ${fmt(p.p[0], 2)} m, y ${fmt(p.p[1], 2)} m` : "Looking for tags…"));
        b.append(h("button", {
          class: recording ? "primary danger" : "primary",
          onclick: async () => {
            await conn.api(recording ? "/api/session/stop" : "/api/session/start", "POST",
              recording ? undefined : { kind: "walk" }).catch((e) => toast(e.message));
          },
        }, recording ? `Stop recording (${fmt(conn.session?.duration_s, 0)} s)` : "Record this walk"));
        b.append(h("p", { class: "muted" },
          "Recordings are kept for training WiFi sensing later. Each one adds to the last."));
      },
    },
  ];

  function tagChips(): HTMLElement {
    const mapped = conn.tagmap?.tags ?? {};
    const seenNow = new Set(tr.last?.dets.map((d) => d.id));
    const roomMax = conn.config?.tracking?.room_tag_max_id ?? 49;
    const ids = new Set<number>([
      ...Object.keys(mapped).map(Number),
      ...Object.keys(conn.tagmap?.observed ?? {}).map(Number),
      ...[...seenNow].filter((id) => id <= roomMax),
    ]);
    return h("div", { class: "chips" },
      ...[...ids].sort((a, b) => a - b).map((id) =>
        h("span", { class: `chip ${mapped[id] ? "mapped" : ""} ${seenNow.has(id) ? "seen" : ""}` }, String(id))));
  }

  // Automatic completion where the app can tell.
  const autoDone = (id: StepId) => (id === "lens" && conn.lens?.ok && done.has("lens")) || done.has(id);

  // ---- rendering -----------------------------------------------------------

  let lensViews = 0;
  const list = h("div", { class: "steps" });
  const head = h("div", { class: "guide-head" });
  const el = h("div", { class: "guide" }, head, list,
    h("button", {
      class: "link-btn",
      onclick: () => {
        if (!confirm("Start the guide again from step 1? Nothing you've recorded is deleted.")) return;
        done.clear();
        saveDone(done);
        renderAll();
      },
    }, "Start the guide again"));

  function renderAll() {
    const current = open ?? steps.find((s) => !autoDone(s.id))?.id ?? null;
    const n = steps.filter((s) => autoDone(s.id)).length;
    head.replaceChildren(
      h("h2", {}, current ? `Step ${steps.findIndex((s) => s.id === current) + 1} of ${steps.length}` : "All set"),
      h("div", { class: "bar" }, h("div", { style: `width:${(100 * n) / steps.length}%` })),
    );
    list.replaceChildren(
      ...steps.map((s, i) => {
        const isDone = autoDone(s.id);
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
      }),
    );
  }

  function drawOverlay(r: FrameResult) {
    const { w, h: hh } = tr.size;
    if (overlay.width !== w || overlay.height !== hh) {
      overlay.width = w;
      overlay.height = hh;
    }
    const g = overlay.getContext("2d")!;
    g.clearRect(0, 0, w, hh);
    const mapped = conn.tagmap?.tags ?? {};
    const roomMax = conn.config?.tracking?.room_tag_max_id ?? 49;
    g.lineWidth = Math.max(3, w / 250);
    g.font = `700 ${Math.round(w / 30)}px system-ui`;
    for (const d of r.dets) {
      const color = d.id > roomMax ? "#4c8dff" : mapped[d.id] ? "#22c55e" : "#f5a524";
      g.strokeStyle = color;
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(d.c[0], d.c[1]);
      for (let i = 2; i < 8; i += 2) g.lineTo(d.c[i], d.c[i + 1]);
      g.closePath();
      g.stroke();
      if (d.id <= roomMax) g.fillText(String(d.id), d.c[0], d.c[1] - 8);
    }
    if (tr.mode === "lens") {
      const n = r.dets.filter((d) => d.id > roomMax).length;
      pill.textContent = n ? `${n} grid tags in view` : "Point at the grid";
      pill.className = `pill ${n >= (conn.config?.lens?.min_tags_per_view ?? 8) ? "ok" : "warn"}`;
    } else {
      const p = r.pose;
      pill.textContent = p?.ok ? "Tracking" : r.dets.length ? "Tags seen, keep a green one in view" : "No tags in view";
      pill.className = `pill ${p?.ok ? "ok" : "warn"}`;
    }
  }

  // Re-render the open step at most a few times a second while the camera runs.
  let lastRender = 0;
  tr.onResult = (r) => {
    drawOverlay(r);
    const now = performance.now();
    if (now - lastRender > 400) {
      lastRender = now;
      renderAll();
    }
  };

  let calibrating = false;
  offs.push(
    conn.on("lens_view", async (m) => {
      if (!m.accepted) return;
      lensViews = m.views;
      const need = conn.config?.lens?.min_views ?? 12;
      if (lensViews >= need && !calibrating && !conn.lens?.ok) {
        calibrating = true;
        try {
          const r = await conn.api(`/api/lens/${conn.id}/calibrate`, "POST");
          if (r.ok) conn.lens = r;
        } finally {
          calibrating = false;
        }
        renderAll();
      }
    }),
    conn.on("lens", renderAll),
    conn.on("tagmap", renderAll),
    conn.on("session", renderAll),
  );

  renderAll();
  return {
    el,
    destroy: () => {
      offs.forEach((off) => off());
      tr.onResult = () => {};
    },
  };
}
