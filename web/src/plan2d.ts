// Room layout drawn as a floor plan on a 2D canvas, in the style of an architect's plan: light floor,
// dark walls with door gaps and swing arcs, furniture as soft rounded shapes, wall lengths in metres.
// Input is a room's `layout` (server/seefy/layout.py); X and Y map metres to canvas pixels, s is
// pixels per metre. Colours come from the --plan-* tokens in style.css, so light and dark both work.

import type { Layout } from "./layout3d";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export interface PlanOptions {
  labels?: boolean; // wall lengths and furniture names (default true)
  glow?: boolean; // tint the floor to show movement
}

export function drawPlan(g: CanvasRenderingContext2D, layout: Layout, X: (x: number) => number, Y: (y: number) => number, s: number,
  opts: PlanOptions = {}): void {
  if (!layout?.ok) return;
  const labels = opts.labels ?? true;
  const wall = css("--plan-wall");
  const label = css("--plan-label");
  const weak = (layout as any).confidence === "low";

  // Floor.
  g.fillStyle = opts.glow ? css("--plan-floor-moving") : css("--plan-floor");
  g.beginPath();
  layout.outline.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
  g.closePath();
  g.fill();

  // Furniture under the walls: rounded, softly filled, named when there's room for it.
  for (const o of layout.objects as any[]) {
    const [cx, cy] = o.center;
    const [w, d] = o.size;
    g.save();
    g.translate(X(cx), Y(cy));
    g.rotate(-o.yaw);
    const rw = w * s, rd = d * s, r = Math.min(6, rw / 4, rd / 4);
    g.fillStyle = css("--plan-furniture");
    g.strokeStyle = css("--plan-furniture-edge");
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(-rw / 2, -rd / 2, rw, rd, r);
    g.fill();
    g.stroke();
    if (labels && o.label && Math.min(rw, rd) > 30) {
      g.rotate(o.yaw); // keep text upright
      g.fillStyle = label;
      g.font = "500 11px -apple-system, system-ui";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(o.label, 0, 0);
    }
    g.restore();
  }

  // Walls: solid between openings, a door swing in each opening. Unsure walls are dashed.
  const thick = Math.max(3, Math.min(0.1 * s, 9));
  g.lineCap = "square";
  for (const w of layout.walls) {
    const [ax, ay] = w.a;
    const [bx, by] = w.b;
    const len = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const at = (d: number): [number, number] => [ax + ux * d, ay + uy * d];
    const solid: [number, number][] = [];
    let from = 0;
    for (const o of w.openings) {
      solid.push([from, o.from_m]);
      from = o.to_m;
    }
    solid.push([from, len]);
    g.strokeStyle = wall;
    g.lineWidth = thick;
    g.setLineDash(weak || w.support < 0.35 ? [thick * 2, thick * 1.5] : []);
    for (const [d0, d1] of solid) {
      if (d1 - d0 < 0.01) continue;
      const [x0, y0] = at(d0);
      const [x1, y1] = at(d1);
      g.beginPath();
      g.moveTo(X(x0), Y(y0));
      g.lineTo(X(x1), Y(y1));
      g.stroke();
    }
    g.setLineDash([]);
    // Door: a quarter-circle swing into the room, hinged at the opening's start.
    for (const o of w.openings) {
      const [hx, hy] = at(o.from_m);
      const r = (o.to_m - o.from_m) * s;
      const base = Math.atan2(Y(hy + uy) - Y(hy), X(hx + ux) - X(hx)); // wall direction on the canvas
      const [nx, ny] = inward(layout, hx, hy, -uy, ux);
      const toward = Math.atan2(Y(hy + ny) - Y(hy), X(hx + nx) - X(hx));
      const ccw = ((toward - base + 3 * Math.PI) % (2 * Math.PI)) - Math.PI < 0;
      g.strokeStyle = css("--plan-door");
      g.lineWidth = 1;
      g.beginPath();
      g.arc(X(hx), Y(hy), r, base, toward, ccw);
      g.moveTo(X(hx), Y(hy));
      g.lineTo(X(hx) + r * Math.cos(toward), Y(hy) + r * Math.sin(toward));
      g.stroke();
    }
    if (labels && len * s > 60) {
      const [mx, my] = at(len / 2);
      const [nx, ny] = inward(layout, mx, my, -uy, ux);
      g.fillStyle = label;
      g.font = "500 11px -apple-system, system-ui";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(`${len.toFixed(1)} m`, X(mx - nx * 0.3), Y(my - ny * 0.3));
    }
  }
  g.textAlign = "start";
  g.textBaseline = "alphabetic";
}

/** Unit normal at (x, y), flipped if needed to point toward the room's centre. */
function inward(layout: Layout, x: number, y: number, nx: number, ny: number): [number, number] {
  const cx = layout.outline.reduce((a, p) => a + p[0], 0) / layout.outline.length;
  const cy = layout.outline.reduce((a, p) => a + p[1], 0) / layout.outline.length;
  return (cx - x) * nx + (cy - y) * ny >= 0 ? [nx, ny] : [-nx, -ny];
}
