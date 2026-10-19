// Room editor: fix the floor plan the scan produced. Drag a wall to move it (its neighbours follow,
// so the room stays a rectangle), double-click a wall to add a door, drag a door along its wall,
// and move, resize, label or delete furniture boxes. Every change can be undone.
//
// Edits are kept as overrides over the scan's layout (server/seefy/layout.py): whole replacement
// values for the keys that changed, applied as {...layout, ...overrides}. See applyOverrides().

import type { Layout } from "./layout3d";
import { drawPlan } from "./plan2d";
import { fmt, h } from "./ui";
import "./editor.css";

type Opening = { from_m: number; to_m: number };
type Wall = Layout["walls"][number];
type Box = Layout["objects"][number] & { label?: string; points?: number };
export type Overrides = Partial<Pick<Layout, "outline" | "walls">> & { v?: number; size_m?: number[]; objects?: Box[] };
type Sel = { kind: "wall"; i: number } | { kind: "door"; i: number; j: number } | { kind: "box"; i: number } | null;

const EDITED_KEYS = ["outline", "size_m", "walls", "objects"] as const;
const DOOR_M = 0.8;

export function applyOverrides(layout: Layout, ov: Overrides | null | undefined): Layout {
  return ov && Object.keys(ov).length ? { ...layout, ...ov, edited: true } as Layout : layout;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The room as a rectangle in its own wall-aligned frame (u along yaw, v across), so edits keep right angles. */
class Rect {
  constructor(public yaw: number, public u0: number, public u1: number, public v0: number, public v1: number) {}

  static of(l: Layout & { yaw?: number }): Rect {
    const yaw = l.yaw ?? Math.atan2(l.outline[1][1] - l.outline[0][1], l.outline[1][0] - l.outline[0][0]);
    const uv = l.outline.map((p) => toUV(yaw, p[0], p[1]));
    const us = uv.map((p) => p[0]);
    const vs = uv.map((p) => p[1]);
    return new Rect(yaw, Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs));
  }

  corners(): number[][] {
    return [[this.u0, this.v0], [this.u1, this.v0], [this.u1, this.v1], [this.u0, this.v1]].map(([u, v]) => toXY(this.yaw, u, v));
  }
}
const toUV = (yaw: number, x: number, y: number) => [x * Math.cos(yaw) + y * Math.sin(yaw), -x * Math.sin(yaw) + y * Math.cos(yaw)];
const toXY = (yaw: number, u: number, v: number) => [r3(u * Math.cos(yaw) - v * Math.sin(yaw)), r3(u * Math.sin(yaw) + v * Math.cos(yaw))];

/** Rebuild outline, walls and size from the rectangle, keeping each wall's doors and support. */
function reshape(l: Layout & { size_m?: number[] }, r: Rect): void {
  const c = r.corners();
  l.outline = c;
  l.size_m = [r3(r.u1 - r.u0), r3(r.v1 - r.v0)];
  l.walls = l.walls.map((w, k) => {
    const a = c[k];
    const b = c[(k + 1) % 4];
    const len = r3(Math.hypot(b[0] - a[0], b[1] - a[1]));
    // Doors stay where they are in the room when the wall's start corner moves.
    const shift = ((a[0] - w.a[0]) * (b[0] - a[0]) + (a[1] - w.a[1]) * (b[1] - a[1])) / (len || 1);
    const openings = w.openings
      .map((o) => ({ from_m: r3(Math.max(0, o.from_m - shift)), to_m: r3(Math.min(len, o.to_m - shift)) }))
      .filter((o) => o.to_m - o.from_m >= 0.2);
    return { ...w, a, b, length_m: len, openings };
  });
}

export function mapEditor(opts: {
  layout: Layout;
  overrides?: Overrides | null;
  points?: number[][]; // scan points, drawn faintly so walls can be lined up with them
  save?: (ov: Overrides | null) => Promise<void>;
}): { el: HTMLElement; destroy: () => void } {
  const base = opts.layout;
  let doc: Omit<Layout, "objects"> & { size_m?: number[]; objects: Box[] } = clone(applyOverrides(base, opts.overrides)) as any;
  const undo: string[] = [];
  const redo: string[] = [];
  let saved = JSON.stringify(doc);
  let sel: Sel = null;

  const canvas = h("canvas", { class: "ed-canvas", tabindex: 0 });
  const btnUndo = h("button", { class: "ed-tool", title: "Undo (⌘Z)" }, "Undo");
  const btnRedo = h("button", { class: "ed-tool", title: "Redo (⇧⌘Z)" }, "Redo");
  const btnBox = h("button", { class: "ed-tool" }, "Add furniture");
  const btnReset = h("button", { class: "ed-tool" }, "Back to scan");
  const btnSave = h("button", { class: "ed-save" }, "Save");
  const savedNote = h("span", { class: "muted" });
  const panel = h("div", { class: "ed-panel side-card" });
  const el = h("div", { class: "editor" },
    h("div", { class: "ed-bar" }, btnUndo, btnRedo, h("span", { class: "ed-sep" }), btnBox, btnReset,
      h("span", { class: "ed-grow" }), savedNote, opts.save ? btnSave : null),
    h("div", { class: "ed-main" }, h("div", { class: "ed-stage" }, canvas), panel));

  // ---- view: metres <-> canvas pixels (y up in the world, down on the canvas) ----
  let s = 100;
  let ox = 0;
  let oy = 0;
  const X = (x: number) => ox + x * s;
  const Y = (y: number) => oy - y * s;
  const toWorld = (px: number, py: number) => [(px - ox) / s, (oy - py) / s];
  function fit() {
    const w = canvas.clientWidth;
    const hh = canvas.clientHeight;
    const xs = base.outline.map((p) => p[0]);
    const ys = base.outline.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    s = Math.min(w / (x1 - x0 + 2), hh / (y1 - y0 + 2));
    ox = w / 2 - ((x0 + x1) / 2) * s;
    oy = hh / 2 + ((y0 + y1) / 2) * s;
  }

  // ---- history ----
  function commit(mutate: () => void) {
    undo.push(JSON.stringify(doc));
    redo.length = 0;
    mutate();
    update();
  }
  const step = (from: string[], to: string[]) => {
    const prev = from.pop();
    if (!prev) return;
    to.push(JSON.stringify(doc));
    doc = JSON.parse(prev);
    if (sel?.kind === "box" && !doc.objects[sel.i]) sel = null;
    if (sel?.kind === "door" && !doc.walls[sel.i].openings[sel.j]) sel = null;
    update();
  };

  // ---- drawing ----
  function draw() {
    const w = canvas.clientWidth;
    const hh = canvas.clientHeight;
    if (!w || !hh) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
    const g = canvas.getContext("2d")!;
    g.scale(dpr, dpr);
    const css = getComputedStyle(el);
    // 1 m grid
    g.strokeStyle = css.getPropertyValue("--grid-faint");
    g.lineWidth = 1;
    const [wx0, wy1] = toWorld(0, 0);
    const [wx1, wy0] = toWorld(w, hh);
    g.beginPath();
    for (let x = Math.ceil(wx0); x <= wx1; x++) g.moveTo(X(x), 0), g.lineTo(X(x), hh);
    for (let y = Math.ceil(wy0); y <= wy1; y++) g.moveTo(0, Y(y)), g.lineTo(w, Y(y));
    g.stroke();
    if (opts.points?.length) {
      g.fillStyle = css.getPropertyValue("--scan-point");
      for (const p of opts.points) if (p[2] > 0.1 && p[2] < 2.2) g.fillRect(X(p[0]) - 1, Y(p[1]) - 1, 2, 2);
    }
    drawPlan(g, doc as Layout, X, Y, s);
    // labels and the selection on top
    const accent = css.getPropertyValue("--accent");
    g.font = "600 12px system-ui";
    g.textAlign = "center";
    g.textBaseline = "middle";
    doc.objects.forEach((o) => {
      if (!o.label) return;
      g.fillStyle = css.getPropertyValue("--fg");
      g.fillText(o.label, X(o.center[0]), Y(o.center[1]) - (Math.min(o.size[0], o.size[1]) * s > 34 ? 14 : 0));
    });
    g.textAlign = "start";
    g.textBaseline = "alphabetic";
    g.strokeStyle = accent;
    g.fillStyle = accent;
    g.lineWidth = 3;
    if (sel?.kind === "wall" || sel?.kind === "door") {
      const wl = doc.walls[sel.i];
      const [a, b] = sel.kind === "wall" ? [wl.a, wl.b] : doorEnds(wl, wl.openings[sel.j]);
      g.beginPath();
      g.moveTo(X(a[0]), Y(a[1]));
      g.lineTo(X(b[0]), Y(b[1]));
      g.stroke();
      if (sel.kind === "door") for (const p of [a, b]) dot(g, X(p[0]), Y(p[1]));
    } else if (sel?.kind === "box") {
      const c = boxCorners(doc.objects[sel.i]);
      g.lineWidth = 2;
      g.beginPath();
      c.forEach((p, k) => (k ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
      g.closePath();
      g.stroke();
      for (const p of c) dot(g, X(p[0]), Y(p[1]));
    }
  }
  const dot = (g: CanvasRenderingContext2D, x: number, y: number) => {
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.fill();
  };

  // ---- geometry helpers ----
  const wallDir = (wl: Wall) => {
    const len = Math.hypot(wl.b[0] - wl.a[0], wl.b[1] - wl.a[1]) || 1;
    return [(wl.b[0] - wl.a[0]) / len, (wl.b[1] - wl.a[1]) / len, len];
  };
  const along = (wl: Wall, p: number[]) => {
    const [ux, uy] = wallDir(wl);
    return (p[0] - wl.a[0]) * ux + (p[1] - wl.a[1]) * uy;
  };
  const across = (wl: Wall, p: number[]) => {
    const [ux, uy] = wallDir(wl);
    return Math.abs(-(p[0] - wl.a[0]) * uy + (p[1] - wl.a[1]) * ux);
  };
  const doorEnds = (wl: Wall, o: Opening) => {
    const [ux, uy] = wallDir(wl);
    return [o.from_m, o.to_m].map((d) => [wl.a[0] + ux * d, wl.a[1] + uy * d]);
  };
  const boxCorners = (o: Box) => {
    const [c, sn] = [Math.cos(o.yaw), Math.sin(o.yaw)];
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => {
      const u = (i * o.size[0]) / 2;
      const v = (j * o.size[1]) / 2;
      return [o.center[0] + u * c - v * sn, o.center[1] + u * sn + v * c];
    });
  };
  const inBox = (o: Box, p: number[]) => {
    const dx = p[0] - o.center[0];
    const dy = p[1] - o.center[1];
    const u = dx * Math.cos(o.yaw) + dy * Math.sin(o.yaw);
    const v = -dx * Math.sin(o.yaw) + dy * Math.cos(o.yaw);
    return Math.abs(u) <= o.size[0] / 2 && Math.abs(v) <= o.size[1] / 2;
  };

  type Hit = (NonNullable<Sel> & { handle?: number }) | null;
  function hitTest(px: number, py: number): Hit {
    const p = toWorld(px, py);
    const tol = 10 / s;
    if (sel?.kind === "box") {
      const k = boxCorners(doc.objects[sel.i]).findIndex((c) => Math.hypot(X(c[0]) - px, Y(c[1]) - py) < 9);
      if (k >= 0) return { ...sel, handle: k };
    }
    for (let i = doc.objects.length - 1; i >= 0; i--) if (inBox(doc.objects[i], p)) return { kind: "box", i };
    for (let i = 0; i < doc.walls.length; i++) {
      const wl = doc.walls[i];
      const d = along(wl, p);
      if (across(wl, p) > tol || d < -tol || d > wallDir(wl)[2] + tol) continue;
      const j = wl.openings.findIndex((o) => d >= o.from_m - tol && d <= o.to_m + tol);
      return j >= 0 ? { kind: "door", i, j } : { kind: "wall", i };
    }
    return null;
  }

  // ---- pointer editing ----
  let drag: { hit: Hit; start: number[]; before: string; snap: any } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.focus();
    const hit = hitTest(e.offsetX, e.offsetY);
    sel = hit ? ({ ...hit, handle: undefined } as unknown as Sel) : null;
    if (hit) {
      drag = { hit, start: toWorld(e.offsetX, e.offsetY), before: JSON.stringify(doc), snap: clone(doc) };
      canvas.setPointerCapture(e.pointerId);
    }
    update(false);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) {
      const hit = hitTest(e.offsetX, e.offsetY);
      canvas.style.cursor = hit?.handle != null ? "nwse-resize" : hit?.kind === "box" ? "move"
        : hit?.kind === "door" ? "ew-resize" : hit?.kind === "wall" ? "grab" : "default";
      return;
    }
    const p = toWorld(e.offsetX, e.offsetY);
    const [dx, dy] = [p[0] - drag.start[0], p[1] - drag.start[1]];
    const snap = drag.snap as typeof doc;
    const hit = drag.hit!;
    if (hit.kind === "wall") {
      // Move the wall straight out or in; the room stays a rectangle.
      const r = Rect.of(snap as any);
      const [du, dv] = toUV(r.yaw, dx, dy);
      const min = 0.5;
      if (hit.i === 0) r.v0 = Math.min(r.v0 + dv, r.v1 - min);
      if (hit.i === 1) r.u1 = Math.max(r.u1 + du, r.u0 + min);
      if (hit.i === 2) r.v1 = Math.max(r.v1 + dv, r.v0 + min);
      if (hit.i === 3) r.u0 = Math.min(r.u0 + du, r.u1 - min);
      doc = clone(snap);
      reshape(doc, r);
    } else if (hit.kind === "door") {
      const wl = snap.walls[hit.i];
      const o = wl.openings[hit.j];
      const [ux, uy, len] = wallDir(wl);
      const d = dx * ux + dy * uy;
      const width = o.to_m - o.from_m;
      const from = Math.max(0, Math.min(len - width, o.from_m + d));
      doc = clone(snap);
      doc.walls[hit.i].openings[hit.j] = { from_m: r3(from), to_m: r3(from + width) };
      doc.walls[hit.i].openings.sort((a, b) => a.from_m - b.from_m);
    } else if (hit.kind === "box") {
      doc = clone(snap);
      const o = doc.objects[hit.i];
      const was = snap.objects[hit.i];
      if (hit.handle == null) {
        o.center = [r3(was.center[0] + dx), r3(was.center[1] + dy), ...was.center.slice(2)];
      } else {
        // Resize from a corner, keeping the opposite corner where it was.
        const c = boxCorners(was);
        const fixed = c[(hit.handle + 2) % 4];
        const [cs, sn] = [Math.cos(was.yaw), Math.sin(was.yaw)];
        const ex = p[0] - fixed[0];
        const ey = p[1] - fixed[1];
        const u = ex * cs + ey * sn;
        const v = -ex * sn + ey * cs;
        o.size = [r3(Math.max(0.1, Math.abs(u))), r3(Math.max(0.1, Math.abs(v))), ...was.size.slice(2)];
        const mu = u / 2;
        const mv = v / 2;
        o.center = [r3(fixed[0] + mu * cs - mv * sn), r3(fixed[1] + mu * sn + mv * cs), ...was.center.slice(2)];
      }
    }
    update(false);
  });
  const endDrag = () => {
    if (!drag) return;
    if (JSON.stringify(doc) !== drag.before) {
      undo.push(drag.before);
      redo.length = 0;
    }
    drag = null;
    update();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("dblclick", (e) => {
    const hit = hitTest(e.offsetX, e.offsetY);
    if (hit?.kind === "wall") addDoor(hit.i, along(doc.walls[hit.i], toWorld(e.offsetX, e.offsetY)));
  });

  // ---- actions ----
  function addDoor(i: number, at: number) {
    const wl = doc.walls[i];
    const len = wallDir(wl)[2];
    if (len < DOOR_M + 0.1) return;
    const from = r3(Math.max(0, Math.min(len - DOOR_M, at - DOOR_M / 2)));
    commit(() => {
      wl.openings = [...wl.openings, { from_m: from, to_m: r3(from + DOOR_M) }].sort((a, b) => a.from_m - b.from_m);
      sel = { kind: "door", i, j: wl.openings.findIndex((o) => o.from_m === from) };
    });
  }
  function remove() {
    if (sel?.kind === "box") {
      const i = sel.i;
      commit(() => doc.objects.splice(i, 1));
      sel = null;
    } else if (sel?.kind === "door") {
      const { i, j } = sel;
      commit(() => doc.walls[i].openings.splice(j, 1));
      sel = null;
    }
    update();
  }
  btnUndo.onclick = () => step(undo, redo);
  btnRedo.onclick = () => step(redo, undo);
  btnBox.onclick = () => {
    const r = Rect.of(doc as any);
    const c = toXY(r.yaw, (r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2);
    commit(() => {
      doc.objects.push({ center: [c[0], c[1], 0.4], size: [0.8, 0.8, 0.8], yaw: r.yaw, label: "" });
      sel = { kind: "box", i: doc.objects.length - 1 };
    });
  };
  btnReset.onclick = () => {
    commit(() => (doc = clone(base) as any));
    sel = null;
    update();
  };
  btnSave.onclick = async () => {
    btnSave.disabled = true;
    savedNote.textContent = "Saving…";
    try {
      await opts.save!(overrides());
      saved = JSON.stringify(doc);
      savedNote.textContent = "Saved";
    } catch (e: any) {
      savedNote.textContent = `Not saved: ${e.message ?? e}`;
    }
    update(false);
  };
  canvas.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") step(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo);
    else if (mod && e.key.toLowerCase() === "y") step(redo, undo);
    else if (e.key === "Delete" || e.key === "Backspace") remove();
    else if (e.key === "Escape") (sel = null), update(false);
    else return;
    e.preventDefault();
  });

  /** Whole values for the keys that differ from the scan; null when nothing does. */
  function overrides(): Overrides | null {
    const out: any = {};
    for (const k of EDITED_KEYS) if (JSON.stringify((doc as any)[k]) !== JSON.stringify((base as any)[k])) out[k] = (doc as any)[k];
    return Object.keys(out).length ? { v: 1, ...out } : null;
  }

  // ---- side panel ----
  const num = (value: number, onset: (v: number) => void, min = 0.1) => {
    const inp = h("input", { type: "number", step: "0.05", min, value: value.toFixed(2) });
    inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v) && v >= min) commit(() => onset(r3(v)));
      else inp.value = value.toFixed(2);
    };
    return inp;
  };
  function renderPanel() {
    const kids: (Node | string)[] = [];
    if (sel?.kind === "wall") {
      const wl = doc.walls[sel.i];
      const i = sel.i;
      kids.push(h("div", { class: "side-head" }, h("h3", {}, "Wall"), h("span", { class: "badge off" }, `${fmt(wl.length_m, 2)} m`)),
        h("p", { class: "muted" }, "Drag it to move it. The walls next to it stretch to follow."),
        h("p", { class: "muted" }, wl.support < 0.35 ? "The scan saw little of this wall, so check where it really is." :
          `The scan saw ${Math.round(wl.support * 100)}% of this wall.`),
        h("button", { onclick: () => addDoor(i, wallDir(wl)[2] / 2) }, "Add a door"));
    } else if (sel?.kind === "door") {
      const { i, j } = sel;
      const o = doc.walls[i].openings[j];
      const len = wallDir(doc.walls[i])[2];
      kids.push(h("div", { class: "side-head" }, h("h3", {}, "Door")),
        h("p", { class: "muted" }, "Drag it along the wall to move it."),
        h("label", { class: "ed-field" }, "Width (m)", num(o.to_m - o.from_m, (v) => {
          const wdt = Math.min(v, len);
          const from = Math.min(o.from_m, len - wdt);
          doc.walls[i].openings[j] = { from_m: r3(from), to_m: r3(from + wdt) };
        }, 0.3)),
        h("button", { class: "ed-danger", onclick: remove }, "Remove door"));
    } else if (sel?.kind === "box") {
      const i = sel.i;
      const o = doc.objects[i];
      const label = h("input", { type: "text", placeholder: "e.g. Sofa, Bed, Desk", value: o.label ?? "" });
      label.onchange = () => commit(() => (doc.objects[i].label = label.value.trim()));
      kids.push(h("div", { class: "side-head" }, h("h3", {}, "Furniture")),
        h("label", { class: "ed-field" }, "Name", label),
        h("label", { class: "ed-field" }, "Width (m)", num(o.size[0], (v) => (doc.objects[i].size[0] = v))),
        h("label", { class: "ed-field" }, "Depth (m)", num(o.size[1], (v) => (doc.objects[i].size[1] = v))),
        h("label", { class: "ed-field" }, "Height (m)", num(o.size[2] ?? 0.8, (v) => {
          doc.objects[i].size[2] = v;
          doc.objects[i].center[2] = r3(v / 2);
        })),
        h("p", { class: "muted" }, "Drag the box to move it, or a corner to resize it."),
        h("button", { class: "ed-danger", onclick: remove }, "Delete"));
    } else {
      kids.push(h("div", { class: "side-head" }, h("h3", {}, "Edit the room")),
        h("ul", { class: "ed-tips" },
          h("li", {}, "Drag a wall to move it."),
          h("li", {}, "Double-click a wall to add a door, and drag a door to move it."),
          h("li", {}, "Click furniture to name, resize or delete it."),
          h("li", {}, "⌘Z undoes, ⇧⌘Z redoes.")),
        h("dl", { class: "stats" },
          h("dt", {}, "Room"), h("dd", {}, `${fmt(doc.size_m?.[0], 2)} × ${fmt(doc.size_m?.[1], 2)} m`),
          h("dt", {}, "Doors"), h("dd", {}, String(doc.walls.reduce((n, w) => n + w.openings.length, 0))),
          h("dt", {}, "Furniture"), h("dd", {}, String(doc.objects.length))));
    }
    panel.replaceChildren(...kids);
  }

  function update(panelToo = true) {
    btnUndo.disabled = !undo.length;
    btnRedo.disabled = !redo.length;
    const dirty = JSON.stringify(doc) !== saved;
    btnSave.disabled = !dirty;
    if (dirty && savedNote.textContent === "Saved") savedNote.textContent = "";
    btnReset.disabled = !overrides();
    if (panelToo || !drag) renderPanel();
    draw();
  }

  const ro = new ResizeObserver(() => {
    fit();
    draw();
  });
  ro.observe(canvas);
  update();

  return { el, destroy: () => ro.disconnect() };
}
