// Top-down floor map: grid, tags, phones, body trails. World frame is z-up,
// so the map shows (x, y) with y pointing up the screen.

export interface PhoneTrack {
  name: string;
  p: number[];
  R: number[];
  body: number[];
  heading: number | null;
  t: number;
  trail: { x: number; y: number; t: number }[];
}

const TRAIL_MS = 60_000;

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class MapView {
  canvas: HTMLCanvasElement;
  tagmap: any = null;
  phones = new Map<string, PhoneTrack>();
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private dirty = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => (this.dirty = true)).observe(canvas);
    const loop = () => {
      if (this.dirty) this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  setTagmap(tm: any): void {
    this.tagmap = tm;
    this.dirty = true;
  }

  addPose(device: string, name: string, pose: any): void {
    let tr = this.phones.get(device);
    if (!tr) {
      tr = { name, p: pose.p, R: pose.R, body: pose.body, heading: pose.heading, t: pose.t, trail: [] };
      this.phones.set(device, tr);
    }
    Object.assign(tr, { name, p: pose.p, R: pose.R, body: pose.body, heading: pose.heading, t: pose.t });
    tr.trail.push({ x: pose.body[0], y: pose.body[1], t: pose.t });
    while (tr.trail.length && pose.t - tr.trail[0].t > TRAIL_MS) tr.trail.shift();
    this.dirty = true;
  }

  clearTrails(): void {
    this.phones.forEach((p) => (p.trail = []));
    this.dirty = true;
  }

  private bounds(): [number, number, number, number] {
    let xs: number[] = [0];
    let ys: number[] = [0];
    for (const t of Object.values<any>(this.tagmap?.tags ?? {})) {
      for (let i = 0; i < 12; i += 3) {
        xs.push(t.corners[i]);
        ys.push(t.corners[i + 1]);
      }
    }
    for (const ph of this.phones.values()) {
      xs.push(ph.p[0]);
      ys.push(ph.p[1]);
      for (const q of ph.trail) {
        xs.push(q.x);
        ys.push(q.y);
      }
    }
    let [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const minSpan = 3;
    if (x1 - x0 < minSpan) [x0, x1] = [(x0 + x1) / 2 - minSpan / 2, (x0 + x1) / 2 + minSpan / 2];
    if (y1 - y0 < minSpan) [y0, y1] = [(y0 + y1) / 2 - minSpan / 2, (y0 + y1) / 2 + minSpan / 2];
    const pad = 0.6;
    return [x0 - pad, x1 + pad, y0 - pad, y1 + pad];
  }

  private draw(): void {
    this.dirty = false;
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const [x0, x1, y0, y1] = this.bounds();
    const s = Math.min(W / (x1 - x0), H / (y1 - y0));
    const ox = (W - s * (x1 - x0)) / 2;
    const oy = (H - s * (y1 - y0)) / 2;
    const X = (x: number) => ox + (x - x0) * s;
    const Y = (y: number) => H - (oy + (y - y0) * s);

    // Grid: 1 m lines, 0.5 m faint.
    for (const [step, color] of [[0.5, css("--grid-faint")], [1, css("--grid")]] as const) {
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.beginPath();
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
        g.moveTo(X(x), 0);
        g.lineTo(X(x), H);
      }
      for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
        g.moveTo(0, Y(y));
        g.lineTo(W, Y(y));
      }
      g.stroke();
    }
    g.fillStyle = css("--muted");
    g.font = "11px system-ui";
    g.fillText("1 m grid", 8, H - 8);

    // Origin axes.
    g.lineWidth = 2;
    g.strokeStyle = css("--axis-x");
    g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(0.5), Y(0)); g.stroke();
    g.strokeStyle = css("--axis-y");
    g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(0), Y(0.5)); g.stroke();

    // Tags: floor tags appear as squares, wall tags as short lines.
    for (const [id, t] of Object.entries<any>(this.tagmap?.tags ?? {})) {
      const cs = t.corners;
      g.strokeStyle = css("--tag");
      g.fillStyle = css("--tag-fill");
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(X(cs[0]), Y(cs[1]));
      for (let i = 3; i < 12; i += 3) g.lineTo(X(cs[i]), Y(cs[i + 1]));
      g.closePath();
      g.fill();
      g.stroke();
      const cx = (cs[0] + cs[3] + cs[6] + cs[9]) / 4;
      const cy = (cs[1] + cs[4] + cs[7] + cs[10]) / 4;
      g.fillStyle = css("--fg");
      g.font = "600 12px system-ui";
      g.fillText(id, X(cx) + 6, Y(cy) - 6);
    }

    // Phones: trail of body positions, body dot, phone dot with heading.
    const now = Math.max(0, ...[...this.phones.values()].map((p) => p.t));
    for (const ph of this.phones.values()) {
      const stale = now - ph.t > 2000;
      g.lineWidth = 2;
      for (let i = 1; i < ph.trail.length; i++) {
        const a = ph.trail[i - 1];
        const b = ph.trail[i];
        const age = (now - b.t) / TRAIL_MS;
        g.strokeStyle = `color-mix(in srgb, ${css("--accent")} ${Math.round((1 - age) * 100)}%, transparent)`;
        g.beginPath();
        g.moveTo(X(a.x), Y(a.y));
        g.lineTo(X(b.x), Y(b.y));
        g.stroke();
      }
      g.fillStyle = stale ? css("--muted") : css("--accent");
      g.beginPath();
      g.arc(X(ph.body[0]), Y(ph.body[1]), 8, 0, Math.PI * 2);
      g.fill();
      if (ph.heading !== null) {
        const hx = Math.cos(ph.heading);
        const hy = Math.sin(ph.heading);
        g.strokeStyle = g.fillStyle;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(X(ph.body[0]), Y(ph.body[1]));
        g.lineTo(X(ph.p[0] + hx * 0.3), Y(ph.p[1] + hy * 0.3));
        g.stroke();
      }
      g.fillStyle = css("--fg");
      g.font = "12px system-ui";
      g.fillText(`${ph.name}${stale ? " (lost)" : ""}`, X(ph.body[0]) + 12, Y(ph.body[1]) + 4);
    }
  }
}
