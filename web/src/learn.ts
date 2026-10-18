// Learn screen (phone): camera, tag tracking, lens calibration, recording passes.

import { conn } from "./conn";
import { Tracker, type FrameResult, type Mode } from "./tracker";
import { fmt, h, toast } from "./ui";

let tracker: Tracker | null = null;

export function learnScreen(): { el: HTMLElement; destroy: () => void } {
  const video = h("video", { playsinline: true, muted: true, autoplay: true });
  const overlay = h("canvas", { class: "overlay" });
  const startBtn = h("button", { class: "primary big" }, "Start camera");
  const camWrap = h("div", { class: "camera" }, video, overlay, h("div", { class: "camera-start" }, startBtn));
  const pill = h("div", { class: "pill" }, "Camera off");
  camWrap.append(pill);

  const modeTrack = h("button", { class: "seg on" }, "Map & track");
  const modeLens = h("button", { class: "seg" }, "Lens");
  const status = h("dl", { class: "stats" });
  const tagList = h("div", { class: "taglist" });

  const kind = h("select", {}, h("option", { value: "map" }, "Map pass"), h("option", { value: "walk" }, "Learn walk"));
  const notes = h("input", { placeholder: "Notes (optional)", maxlength: 200 });
  const recBtn = h("button", { class: "primary" }, "Start recording");
  const recInfo = h("div", { class: "muted" });

  const lensViews = h("span", {}, "0");
  const lensResult = h("div", { class: "muted" });
  const lensPanel = h(
    "section",
    { class: "card", hidden: true },
    h("h3", {}, "Lens calibration"),
    h("p", { class: "muted" },
      "Point the camera at the printed calibration grid and move slowly: tilt it, get closer and further, cover the corners of the view. Views are captured automatically."),
    h("p", {}, "Views captured: ", lensViews, h("span", { class: "muted" }, ` (need ${conn.config?.lens?.min_views ?? 12})`)),
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: () => calibrate() }, "Calibrate"),
      h("button", { onclick: () => resetLens() }, "Reset")),
    lensResult,
  );

  const el = h(
    "div",
    { class: "learn" },
    camWrap,
    h("div", { class: "segs" }, modeTrack, modeLens),
    h("section", { class: "card" }, status),
    lensPanel,
    h("section", { class: "card" },
      h("h3", {}, "Record a pass"),
      h("p", { class: "muted" },
        "Every pass adds to what was learned before. Map passes improve the tag map; learn walks will train WiFi sensing."),
      h("div", { class: "row" }, kind, notes),
      h("div", { class: "row" }, recBtn),
      recInfo),
    h("section", { class: "card" }, h("h3", {}, "Room tags"), tagList),
  );

  const video_ = video;
  if (!tracker) tracker = new Tracker(video_);
  else {
    // Re-attach the running stream to the new video element after navigating back.
    tracker.video = video_;
    if (tracker.stream) {
      video_.srcObject = tracker.stream;
      video_.play().catch(() => {});
    }
  }
  const tr = tracker;
  camWrap.classList.toggle("live", tr.running);

  startBtn.onclick = async () => {
    try {
      await tr.start();
      camWrap.classList.add("live");
    } catch (e: any) {
      toast(`Camera failed: ${e.message ?? e}`);
      pill.textContent = "Camera unavailable";
    }
  };
  tr.onStatus = (s) => {
    if (s) pill.textContent = s;
  };

  const setMode = (m: Mode) => {
    tr.setMode(m);
    modeTrack.classList.toggle("on", m === "track");
    modeLens.classList.toggle("on", m === "lens");
    lensPanel.hidden = m !== "lens";
  };
  modeTrack.onclick = () => setMode("track");
  modeLens.onclick = () => setMode("lens");
  setMode(tr.mode);

  tr.onResult = (r) => {
    drawOverlay(overlay, r);
    renderStatus();
  };

  function drawOverlay(c: HTMLCanvasElement, r: FrameResult) {
    const { w, h: hh } = tr.size;
    if (c.width !== w || c.height !== hh) {
      c.width = w;
      c.height = hh;
    }
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, w, hh);
    const mapped = conn.tagmap?.tags ?? {};
    const roomMax = conn.config?.tracking?.room_tag_max_id ?? 49;
    g.lineWidth = Math.max(2, w / 320);
    g.font = `600 ${Math.round(w / 40)}px system-ui`;
    for (const d of r.dets) {
      const color = d.id > roomMax ? "#4c8dff" : mapped[d.id] ? "#22c55e" : "#f5a524";
      g.strokeStyle = color;
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(d.c[0], d.c[1]);
      for (let i = 2; i < 8; i += 2) g.lineTo(d.c[i], d.c[i + 1]);
      g.closePath();
      g.stroke();
      g.fillText(String(d.id), d.c[0], d.c[1] - 6);
    }
    if (tr.mode === "track") {
      const p = r.pose;
      pill.textContent = p?.ok
        ? `Tracking · ${p.tags.length} tag${p.tags.length > 1 ? "s" : ""}`
        : r.dets.length
          ? Object.keys(mapped).length ? "Tags seen, none mapped yet" : "Mapping: keep the floor tag (0) in view"
          : "No tags in view";
      pill.className = `pill ${p?.ok ? "ok" : "warn"}`;
    } else {
      const n = r.dets.filter((d) => d.id > roomMax).length;
      pill.textContent = `${n} grid tags in view`;
      pill.className = `pill ${n >= (conn.config?.lens?.min_tags_per_view ?? 8) ? "ok" : "warn"}`;
    }
  }

  function renderStatus() {
    const r = tr.last;
    const p = r?.pose;
    const s = conn.sync;
    const rows: [string, string][] = [
      ["Position", p?.ok ? `${fmt(p.p[0], 2)}, ${fmt(p.p[1], 2)}, ${fmt(p.p[2], 2)} m` : "–"],
      ["Fit error", p ? fmt(p.err, 2, " px") : "–"],
      ["Camera", tr.running ? `${tr.size.w}×${tr.size.h} · ${fmt(tr.fps, 0)} fps` : "off"],
      ["Detect", fmt(tr.detectMs, 0, " ms")],
      ["Lens", tr.intrinsics?.calibrated ? "calibrated" : "approximate (calibrate for accuracy)"],
      ["Clock sync", s ? `±${fmt(s.err_ms, 1)} ms (${s.samples} samples)` : "syncing…"],
    ];
    status.replaceChildren(...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  }

  function renderTags() {
    const tm = conn.tagmap;
    const observed: Record<string, number> = tm?.observed ?? {};
    const origin = tm?.origin ?? 0;
    const ids = new Set([...Object.keys(observed), ...Object.keys(tm?.tags ?? {})].map(Number));
    if (!ids.size) {
      tagList.replaceChildren(
        h("p", { class: "muted" },
          "No tags seen yet. Print tags from the Sensors screen, put tag ",
          h("b", {}, String(origin)), " flat on the floor and the others on walls, then sweep the camera so tag ",
          String(origin), " shows up alongside each of the others."),
      );
      return;
    }
    const visible = new Set(tr.last?.dets.map((d) => d.id));
    tagList.replaceChildren(
      ...[...ids].sort((a, b) => a - b).map((id) => {
        const t = tm?.tags?.[id];
        return h("div", { class: `tag ${t ? "mapped" : ""} ${visible.has(id) ? "seen" : ""}` },
          h("b", {}, String(id)),
          h("span", {}, t ? `mapped · ${t.obs} obs · ${fmt(t.rms_px, 2)} px` : `${observed[id] ?? 0} obs, needs linking`),
        );
      }),
      h("p", { class: "muted" },
        `${tm?.frames ?? 0} frames across ${tm?.passes ?? 0} pass(es) · fit ${fmt(tm?.rms_px, 2, " px")}`),
    );
  }

  function renderRec() {
    const s = conn.session;
    recBtn.textContent = s ? "Stop recording" : "Start recording";
    recBtn.classList.toggle("danger", !!s);
    recInfo.textContent = s ? `Recording ${s.kind} pass ${s.pass} · ${fmt(s.duration_s, 0)} s` : "";
  }

  recBtn.onclick = async () => {
    try {
      if (conn.session) await conn.api("/api/session/stop", "POST");
      else await conn.api("/api/session/start", "POST", { kind: kind.value, notes: notes.value });
    } catch (e: any) {
      toast(e.message);
    }
  };

  async function calibrate() {
    try {
      const r = await conn.api(`/api/lens/${conn.id}/calibrate`, "POST");
      lensResult.textContent = r.ok
        ? `Done: fit ${r.rms_px} px over ${r.views_used} views, field of view ${r.fov_h_deg}°.`
        : `Not yet: ${r.error}`;
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function resetLens() {
    if (!confirm("Delete all lens calibration views for this phone?")) return;
    await conn.api(`/api/lens/${conn.id}/reset`, "POST");
    lensViews.textContent = "0";
    lensResult.textContent = "";
  }

  const offs = [
    conn.on("lens_view", (m) => {
      if (m.accepted) lensViews.textContent = String(m.views);
    }),
    conn.on("tagmap", renderTags),
    conn.on("state", () => {
      renderRec();
      renderTags();
    }),
    conn.on("session", renderRec),
    conn.on("sync", renderStatus),
  ];
  renderStatus();
  renderTags();
  renderRec();

  return {
    el,
    destroy: () => {
      offs.forEach((off) => off());
      tr.onResult = () => {};
    },
  };
}
