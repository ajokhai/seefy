// Room layout drawn as a floor plan on a 2D canvas: floor, thick walls with door gaps and swing
// arcs, furniture boxes, and wall lengths in metres. Input is the scan result's `layout`
// (server/seefy/layout.py); X and Y map metres to canvas pixels, s is pixels per metre.

import type { Layout } from "./layout3d";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function drawPlan(g: CanvasRenderingContext2D, layout: Layout, X: (x: number) => number, Y: (y: number) => number, s: number): void {
  if (!layout?.ok) return;
  const wall = css("--fg");
  const muted = css("--muted");

  // Floor.
  g.fillStyle = css("--card");
  g.globalAlpha = 0.55;
  g.beginPath();
  layout.outline.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
  g.closePath();
  g.fill();
  g.globalAlpha = 1;

  // Walls: solid between openings, a door swing in each opening. Weak walls are dashed.
  const thick = Math.max(3, 0.1 * s);
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
    g.setLineDash(w.support < 0.35 ? [thick * 2, thick * 1.5] : []);
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
      // Canvas y points down, so a turn toward the wall's left (world) is a negative canvas angle.
      const base = Math.atan2(-uy, ux);
      const left = isInside(layout, hx, hy, ux, uy);
      const end = left ? base - Math.PI / 2 : base + Math.PI / 2;
      g.strokeStyle = muted;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(X(hx), Y(hy), r, base, end, left);
      g.moveTo(X(hx), Y(hy));
      g.lineTo(X(hx) + r * Math.cos(end), Y(hy) + r * Math.sin(end));
      g.stroke();
    }
    // Length label, outside the wall's midpoint.
    const [mx, my] = at(len / 2);
    const [nx, ny] = outward(layout, mx, my, -uy, ux);
    g.fillStyle = muted;
    g.font = "600 11px system-ui";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(`${len.toFixed(2)} m`, X(mx + nx * 0.28), Y(my + ny * 0.28));
  }

  // Furniture: rotated boxes with their footprint size.
  for (const o of layout.objects) {
    const [cx, cy] = o.center;
    const [w, d] = o.size;
    g.save();
    g.translate(X(cx), Y(cy));
    g.rotate(-o.yaw);
    g.fillStyle = "color-mix(in srgb, #ff9f0a 18%, transparent)";
    g.strokeStyle = "#ff9f0a";
    g.lineWidth = 1.5;
    g.fillRect(-w * s / 2, -d * s / 2, w * s, d * s);
    g.strokeRect(-w * s / 2, -d * s / 2, w * s, d * s);
    if (Math.min(w, d) * s > 34) {
      g.fillStyle = css("--fg");
      g.font = "11px system-ui";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(`${w.toFixed(1)} × ${d.toFixed(1)}`, 0, 0);
    }
    g.restore();
  }
  g.textAlign = "start";
  g.textBaseline = "alphabetic";
}

/** Unit normal (nx, ny) at (x, y) pointing away from the room centre. */
function outward(layout: Layout, x: number, y: number, nx: number, ny: number): [number, number] {
  const cx = layout.outline.reduce((a, p) => a + p[0], 0) / layout.outline.length;
  const cy = layout.outline.reduce((a, p) => a + p[1], 0) / layout.outline.length;
  return (x - cx) * nx + (y - cy) * ny >= 0 ? [nx, ny] : [-nx, -ny];
}

/** Whether the wall's left-hand normal (-uy, ux) points into the room, so doors swing inward. */
function isInside(layout: Layout, x: number, y: number, ux: number, uy: number): boolean {
  const [nx] = outward(layout, x, y, -uy, ux);
  return nx !== -uy; // outward flipped it, so the left normal points inward
}
