// Scan inspector (desktop): is the latest room scan right? Shows the point cloud with a small camera
// frustum for every placed photo, and each photo with the map's points projected onto it. If the scan is
// right, the dots sit on the corners, edges and texture they came from.
//
// Seefy's world is z-up (x, y on the floor); three.js is y-up, so (x, y, z) -> (x, z, -y).
// Frame poses: p is the camera centre, R is camera-to-world (row-major), camera x right, y down, z forward.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { conn } from "./conn";
import { fmt, h } from "./ui";
import "./inspect.css";

// err_px / obs: mean reprojection error of this photo's matched keypoints, and how many (from COLMAP).
type Frame = { name: string; t: number | null; p: number[]; R: number[]; err_px?: number; obs?: number };
type Camera = { model: string; width: number; height: number; fx: number; fy: number; cx: number; cy: number; k: number[] };

const toThree = (p: number[]) => new THREE.Vector3(p[0], p[2], -p[1]);
const camToWorld = (f: Frame, x: number, y: number, z: number) => {
  const R = f.R;
  return [f.p[0] + R[0] * x + R[1] * y + R[2] * z, f.p[1] + R[3] * x + R[4] * y + R[5] * z,
    f.p[2] + R[6] * x + R[7] * y + R[8] * z];
};

/** Pixel projection for the COLMAP lens models Seefy uses, scaled to an image of size w x h. */
class Lens {
  constructor(readonly fx: number, readonly fy: number, readonly cx: number, readonly cy: number,
    private dist: (x: number, y: number) => [number, number], readonly label: string, readonly assumed: boolean) {}

  static from(cam: Camera | undefined, w: number, h: number): Lens {
    const id = (x: number, y: number): [number, number] => [x, y];
    if (!cam?.fx || !cam.width) {
      // No intrinsics from the server: assume a typical phone main camera (about 65° across the long side).
      const f = 0.78 * Math.max(w, h);
      return new Lens(f, f, w / 2, h / 2, id, `assumed pinhole, f ${f.toFixed(0)} px`, true);
    }
    const s = w / cam.width;
    // k: SIMPLE_RADIAL [k1], RADIAL [k1, k2], OPENCV [k1, k2, p1, p2], pinhole models [].
    const [k1 = 0, k2 = 0, p1 = 0, p2 = 0] = cam.k ?? [];
    const dist = (x: number, y: number): [number, number] => {
      const r2 = x * x + y * y;
      const d = 1 + k1 * r2 + k2 * r2 * r2;
      return [x * d + 2 * p1 * x * y + p2 * (r2 + 2 * x * x), y * d + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y];
    };
    const fov = (2 * Math.atan(cam.width / 2 / cam.fx) * 180) / Math.PI;
    const extra = cam.k?.length ? `, k ${cam.k.map((k) => k.toFixed(3)).join(" ")}` : "";
    return new Lens(cam.fx * s, cam.fy * s, cam.cx * s, cam.cy * s, cam.k?.length ? dist : id,
      `${cam.model}, f ${cam.fx.toFixed(0)} px (${fov.toFixed(0)}° across)${extra}`, false);
  }

  /** Camera-axes point -> pixel, or null if behind the camera or far outside the lens model's range. */
  project(x: number, y: number, z: number): [number, number] | null {
    if (z < 0.05) return null;
    const a = x / z;
    const b = y / z;
    if (Math.abs(a) > 1.5 || Math.abs(b) > 1.5) return null; // distortion polynomials fold back out here
    const [u, v] = this.dist(a, b);
    return [this.fx * u + this.cx, this.fy * v + this.cy];
  }
}

class ScanView {
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);
  private controls: OrbitControls;
  private room = new THREE.Group();
  private cloud: THREE.Points | null = null;
  private frusta: THREE.LineSegments | null = null;
  private picked = new THREE.Group();
  private frames: Frame[] = [];
  private raf = 0;
  private resize: ResizeObserver;
  onPick: (i: number) => void = () => {};

  constructor(private container: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(this.room, this.picked);
    this.camera.position.set(4, 5, 6);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    // A click (not a drag) picks the nearest camera on screen.
    let down: [number, number] | null = null;
    const cv = this.renderer.domElement;
    cv.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
    cv.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) this.pickAt(e.clientX, e.clientY);
      down = null;
    });
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private fit(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private pickAt(x: number, y: number): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    let best = -1;
    let bestD = 24; // px
    this.frames.forEach((f, i) => {
      const v = toThree(f.p).project(this.camera);
      if (v.z > 1) return;
      const d = Math.hypot(((v.x + 1) / 2) * r.width + r.left - x, ((1 - v.y) / 2) * r.height + r.top - y);
      if (d < bestD) [best, bestD] = [i, d];
    });
    if (best >= 0) this.onPick(best);
  }

  setScan(result: any, aspect: number): void {
    this.room.clear();
    this.cloud = null;
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const pts: number[][] = result?.points ?? [];
    this.frames = result?.frames ?? [];

    let [x0, x1, y0, y1] = [-2, 2, -2, 2];
    if (pts.length) {
      const xs = pts.map((q) => q[0]).sort((a, b) => a - b);
      const ys = pts.map((q) => q[1]).sort((a, b) => a - b);
      const k = Math.floor(xs.length * 0.02);
      [x0, x1, y0, y1] = [xs[k], xs[xs.length - 1 - k], ys[k], ys[ys.length - 1 - k]];
    }
    const size = Math.ceil(Math.max(x1 - x0, y1 - y0, 3)) + 2;
    const grid = new THREE.GridHelper(size, size, dark ? 0x48484a : 0xc7c7cc, dark ? 0x2c2c2e : 0xe5e5ea);
    grid.position.set((x0 + x1) / 2, 0, -(y0 + y1) / 2);
    this.room.add(grid);

    if (pts.length) {
      const pos = new Float32Array(pts.length * 3);
      pts.forEach((q, i) => pos.set([q[0], q[2], -q[1]], i * 3));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pts.length * 3), 3));
      this.cloud = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.03, vertexColors: true, sizeAttenuation: true }));
      this.room.add(this.cloud);
    }

    // One small pyramid per placed photo: apex at the camera centre, base 15 cm in front.
    const d = 0.15;
    const hw = 0.5 * d * 0.8 * Math.min(1, aspect);
    const hh = hw / aspect;
    const seg: number[] = [];
    for (const f of this.frames) {
      const c = [f.p, ...[[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => camToWorld(f, x, y, d))]
        .map((q) => [q[0], q[2], -q[1]]);
      for (const [a, b] of [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [2, 3], [3, 4], [4, 1]]) seg.push(...c[a], ...c[b]);
    }
    if (seg.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(seg), 3));
      this.frusta = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.55 }));
      this.room.add(this.frusta);
    }
    if (this.frames.length > 1) {
      const line = new THREE.BufferGeometry().setFromPoints(this.frames.map((f) => toThree(f.p)));
      this.room.add(new THREE.Line(line, new THREE.LineBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.35 })));
    }

    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const span = Math.max(x1 - x0, y1 - y0, 3);
    this.controls.target.set(cx, 0.8, -cy);
    this.camera.position.set(cx + span * 0.7, span * 0.9, -cy + span * 0.9);
    this.camera.far = span * 10;
    this.camera.updateProjectionMatrix();
  }

  /** Colour the cloud by the scan's own RGB, or by height (floor blue, head height orange). */
  colour(result: any, mode: "rgb" | "height"): void {
    if (!this.cloud) return;
    const pts: number[][] = result.points;
    const rgb: number[][] | undefined = result.colors?.length === pts.length ? result.colors : undefined;
    const col = this.cloud.geometry.getAttribute("color") as THREE.BufferAttribute;
    const low = new THREE.Color(0x0a84ff);
    const high = new THREE.Color(0xff9f0a);
    const c = new THREE.Color();
    pts.forEach((q, i) => {
      if (mode === "rgb" && rgb) c.setRGB(rgb[i][0] / 255, rgb[i][1] / 255, rgb[i][2] / 255, THREE.SRGBColorSpace);
      else c.copy(low).lerp(high, Math.min(1, Math.max(0, q[2] / 2.4)));
      col.setXYZ(i, c.r, c.g, c.b);
    });
    col.needsUpdate = true;
  }

  /** Highlight one camera: a bigger frustum and a line to what it looks at. */
  select(i: number, aspect: number): void {
    this.picked.clear();
    const f = this.frames[i];
    if (!f) return;
    const d = 0.35;
    const hw = 0.5 * d * 0.8 * Math.min(1, aspect);
    const hh = hw / aspect;
    const c = [f.p, ...[[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => camToWorld(f, x, y, d))]
      .map((q) => [q[0], q[2], -q[1]]);
    const seg: number[] = [];
    for (const [a, b] of [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [2, 3], [3, 4], [4, 1]]) seg.push(...c[a], ...c[b]);
    const look = camToWorld(f, 0, 0, 1.5);
    seg.push(...c[0], look[0], look[2], -look[1]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(seg), 3));
    this.picked.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xff375f })));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff375f }));
    dot.position.copy(toThree(f.p));
    this.picked.add(dot);
  }
}

export function inspectScreen(): { el: HTMLElement; destroy: () => void } {
  const stats = h("div", { class: "insp-stats" });
  const box3d = h("div", { class: "insp-3d" });
  const btnRgb = h("button", { class: "seg on" }, "Photo colour");
  const btnHeight = h("button", { class: "seg" }, "Height");
  const img = h("img", { alt: "" });
  const overlay = h("canvas");
  const photo = h("div", { class: "insp-photo" }, img, overlay);
  const photoInfo = h("div", { class: "insp-photo-info muted" });
  const dotsToggle = h("input", { type: "checkbox", checked: true });
  const film = h("div", { class: "insp-film" });
  const empty = h("p", { class: "insp-empty muted", hidden: true }, "No finished room scan yet. On your phone, open Guide and scan the room.");
  const el = h("div", { class: "inspect" },
    stats,
    empty,
    h("div", { class: "insp-main" },
      h("div", { class: "insp-stage" }, h("div", { class: "segs floating" }, btnRgb, btnHeight), box3d,
        h("div", { class: "insp-hint" }, "Click a camera to see its photo. ← → step through them.")),
      h("div", { class: "insp-side" },
        photo,
        h("label", { class: "insp-check" }, dotsToggle, " Show the map's points on the photo"),
        photoInfo,
        h("p", { class: "muted" },
          "If the scan is right, the dots land on the corners, edges and patterns they were built from. " +
          "Dots that are offset, rotated or scattered mean that photo, or the whole map, is placed wrong."))),
    film,
  );

  const view = new ScanView(box3d);
  let result: any = null;
  let sid = "";
  let sel = -1;
  let lens: Lens | null = null;
  let mode: "rgb" | "height" = "rgb";
  try {
    if (localStorage.getItem("seefy.inspect.colour") === "height") mode = "height";
  } catch {
    /* fine */
  }

  const frameUrl = (name: string) => `/api/scans/${encodeURIComponent(sid)}/frames/${encodeURIComponent(name)}`;
  const aspect = () => {
    const c: Camera | undefined = result?.camera;
    return c?.width && c?.height ? c.width / c.height : img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 9 / 16;
  };

  const setMode = (m: "rgb" | "height") => {
    const hasRgb = result?.colors?.length && result.colors.length === result.points?.length;
    mode = m === "rgb" && !hasRgb ? "height" : m;
    btnRgb.classList.toggle("on", mode === "rgb");
    btnHeight.classList.toggle("on", mode === "height");
    btnRgb.disabled = !hasRgb;
    btnRgb.title = hasRgb ? "" : "This scan has no point colours";
    if (result) view.colour(result, mode);
    try {
      localStorage.setItem("seefy.inspect.colour", m);
    } catch {
      /* fine */
    }
  };
  btnRgb.onclick = () => setMode("rgb");
  btnHeight.onclick = () => setMode("height");

  const chip = (label: string, value: string, tone: "" | "ok" | "warn" | "bad" = "", title = "") =>
    h("div", { class: `insp-chip ${tone}`, title }, h("span", {}, label), h("b", {}, value));

  function renderStats() {
    const r = result;
    const cov = r.coverage;
    const imu = r.imu ?? {};
    const share = r.total ? r.registered / r.total : 0;
    const scaleImu = /accelerometer/.test(r.scale_method ?? "");
    const errs = (r.frames as Frame[]).filter((f) => f.err_px != null);
    const err: number | undefined = r.reproj_err_px ??
      (errs.length ? errs.reduce((a, f) => a + f.err_px! * (f.obs ?? 1), 0) / errs.reduce((a, f) => a + (f.obs ?? 1), 0) : undefined);
    stats.replaceChildren(
      chip("Photos placed", `${r.registered} of ${r.total} (${Math.round(share * 100)}%)`,
        share >= 0.7 ? "ok" : share >= 0.4 ? "warn" : "bad",
        "Photos the reconstruction could fit into one map. The rest were dropped."),
      chip("Coverage", cov ? `${cov.level} · ${Math.round((cov.score ?? 0) * 100)}%` : "–",
        !cov ? "" : cov.level === "short" ? "warn" : "ok", cov?.hint ?? ""),
      chip("Scale", scaleImu ? "accelerometer" : r.scale_method ? "assumed height" : "–", scaleImu ? "ok" : "warn",
        r.scale_method ?? ""),
      chip("IMU scale", imu.ok == null ? "not run" : imu.ok ? `worked · r ${fmt(imu.correlation, 2)}` : `failed · r ${fmt(imu.correlation, 2)}`,
        imu.ok ? "ok" : imu.ok == null ? "" : "bad", imu.reason ?? ""),
      chip("Room", r.room_size_m?.length ? `${fmt(r.room_size_m[0], 1)} × ${fmt(r.room_size_m[1], 1)} × ${fmt(r.room_size_m[2], 1)} m` : "–"),
      chip("Fit error", err == null ? "–" : `${fmt(err, 2)} px mean`, err == null ? "" : err < 1.5 ? "ok" : err < 3 ? "warn" : "bad",
        "How far, on average, each matched feature lands from where the map says it should (reprojection error)."),
      chip("Points", String(r.points?.length ?? 0)),
      chip("Up from", r.up_method || "–", r.up_method === "gravity" ? "ok" : "warn"),
    );
  }

  function drawOverlay() {
    const w = img.clientWidth;
    const hgt = img.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(w * dpr);
    overlay.height = Math.round(hgt * dpr);
    overlay.style.width = `${w}px`;
    overlay.style.height = `${hgt}px`;
    const ctx = overlay.getContext("2d")!;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const f: Frame | undefined = result?.frames?.[sel];
    if (!f || !img.naturalWidth) return;
    lens = Lens.from(result.camera, img.naturalWidth, img.naturalHeight);
    const k = w / img.naturalWidth;
    const R = f.R;
    let inView = 0;
    const near: number[] = [];
    const proj: [number, number, number][] = [];
    for (const q of result.points as number[][]) {
      const dx = q[0] - f.p[0], dy = q[1] - f.p[1], dz = q[2] - f.p[2];
      // world -> camera is R transposed
      const x = R[0] * dx + R[3] * dy + R[6] * dz;
      const y = R[1] * dx + R[4] * dy + R[7] * dz;
      const z = R[2] * dx + R[5] * dy + R[8] * dz;
      const px = lens.project(x, y, z);
      if (!px || px[0] < 0 || px[1] < 0 || px[0] >= img.naturalWidth || px[1] >= img.naturalHeight) continue;
      inView++;
      near.push(z);
      proj.push([px[0] * k * dpr, px[1] * k * dpr, z]);
    }
    if (dotsToggle.checked && proj.length) {
      // Colour by distance from this camera, near red to far cyan, so depth order is readable.
      const sorted = [...near].sort((a, b) => a - b);
      const lo = sorted[Math.floor(sorted.length * 0.05)];
      const hi = sorted[Math.floor(sorted.length * 0.95)];
      const r = 2.2 * dpr;
      ctx.lineWidth = dpr;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      for (const [u, v, z] of proj) {
        const t = hi > lo ? Math.min(1, Math.max(0, (z - lo) / (hi - lo))) : 0.5;
        ctx.fillStyle = `hsl(${Math.round(t * 190)}, 100%, 55%)`;
        ctx.beginPath();
        ctx.arc(u, v, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    photoInfo.replaceChildren(
      h("div", {}, h("b", {}, f.name), ` · photo ${sel + 1} of ${result.frames.length}`,
        f.t != null && result.frames[0]?.t != null ? ` · ${fmt((f.t - result.frames[0].t) / 1000, 1, " s")}` : ""),
      h("div", {}, `${inView} map points in view · camera at ${f.p.map((v) => v.toFixed(2)).join(", ")} m, ` +
        `${fmt(f.p[2], 2, " m")} above the floor`),
      f.err_px != null
        ? h("div", { class: f.err_px < 1.5 ? "" : "insp-warn" },
          `Fit error ${fmt(f.err_px, 2)} px mean over ${f.obs ?? "?"} matched features`)
        : "",
      h("div", { class: lens.assumed ? "insp-warn" : "" }, `Lens: ${lens.label}`),
    );
  }

  function select(i: number) {
    const frames: Frame[] = result?.frames ?? [];
    if (!frames.length) return;
    sel = (i + frames.length) % frames.length;
    const f = frames[sel];
    img.src = frameUrl(f.name);
    view.select(sel, aspect());
    film.querySelectorAll(".on").forEach((t) => t.classList.remove("on"));
    const thumb = film.children[sel] as HTMLElement | undefined;
    thumb?.classList.add("on");
    thumb?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  view.onPick = select;
  img.onload = drawOverlay;
  img.onerror = () => {
    const ctx = overlay.getContext("2d")!;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    photoInfo.replaceChildren(h("div", { class: "insp-warn" }, "This photo isn't available from the server."));
  };
  dotsToggle.onchange = drawOverlay;
  const ro = new ResizeObserver(drawOverlay);
  ro.observe(photo);

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
    if (e.key === "ArrowRight") select(sel + 1);
    else if (e.key === "ArrowLeft") select(sel - 1);
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);

  async function load() {
    let r: any;
    try {
      r = await conn.api("/api/scans/latest");
    } catch {
      r = null;
    }
    if (!r?.frames?.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    result = r;
    sid = r.id ?? "";
    if (!sid) {
      // Older results don't carry their id: the latest result is the newest finished scan.
      try {
        const list: any[] = await conn.api("/api/scans");
        sid = list.find((m) => m.status === "done")?.id ?? "";
      } catch {
        /* photos will show as unavailable */
      }
    }
    renderStats();
    view.setScan(r, aspect());
    setMode(mode);
    film.replaceChildren(...r.frames.map((f: Frame, i: number) =>
      h("button", { class: "insp-thumb", title: f.name, onclick: () => select(i) },
        h("img", { src: frameUrl(f.name), loading: "lazy", alt: "", onerror: (e: Event) => ((e.target as HTMLElement).hidden = true) }))));
    select(Math.max(0, Math.min(sel, r.frames.length - 1)));
  }

  const offs = [conn.on("scan", (m) => {
    if (m.status === "done") load();
  })];
  load();

  return {
    el,
    destroy: () => {
      offs.forEach((off) => off());
      window.removeEventListener("keydown", onKey);
      ro.disconnect();
      view.destroy();
    },
  };
}
