// Markerless room scan: send camera frames and motion samples to the host, stamped on its clock.

import { conn } from "./conn";

export interface ScanStats {
  seconds: number;
  frames: number;
  inflight: number;
  dropped: number;
  turnRate: number; // deg/s, smoothed
  brightness: number; // 0-255
  motion: boolean;
}

export class ScanRecorder {
  id = "";
  running = false;
  stats: ScanStats = { seconds: 0, frames: 0, inflight: 0, dropped: 0, turnRate: 0, brightness: 128, motion: false };
  onStats: (s: ScanStats) => void = () => {};

  private video: HTMLVideoElement;
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  private lastFrame = -Infinity;
  private started = 0;
  private motionBuf: any[] = [];
  private timers: number[] = [];
  private onMotion = (e: DeviceMotionEvent) => this.motion(e);

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async start(): Promise<void> {
    const r = await conn.api("/api/scans/start", "POST", { device: conn.id });
    this.id = r.id;
    this.running = true;
    this.started = performance.now();
    this.stats = { seconds: 0, frames: 0, inflight: 0, dropped: 0, turnRate: 0, brightness: 128, motion: false };
    window.addEventListener("devicemotion", this.onMotion);
    this.timers.push(window.setInterval(() => this.flushMotion(), 250));
    this.timers.push(window.setInterval(() => this.measureBrightness(), 1000));
    this.timers.push(window.setInterval(() => {
      this.stats.seconds = (performance.now() - this.started) / 1000;
      this.onStats(this.stats);
    }, 250));
    this.loop();
  }

  /** Stop recording, wait for uploads, and ask the host to build the map. */
  async stop(): Promise<void> {
    this.running = false;
    window.removeEventListener("devicemotion", this.onMotion);
    this.timers.forEach((t) => window.clearInterval(t));
    this.timers = [];
    this.flushMotion();
    while (this.stats.inflight > 0) await new Promise((r) => setTimeout(r, 100));
    await conn.api(`/api/scans/${this.id}/stop`, "POST");
  }

  private loop(): void {
    if (!this.running) return;
    const v = this.video as any;
    const next = (now: number, meta?: any) => {
      this.frame(meta?.captureTime ?? meta?.presentationTime ?? now);
      this.loop();
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
    else requestAnimationFrame((now) => next(now));
  }

  private frame(captureLocal: number): void {
    const cfg = conn.config?.scan ?? {};
    if (captureLocal - this.lastFrame < 1000 / (cfg.capture_fps ?? 5) * 0.95) return;
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w) return;
    if (this.stats.inflight >= 6) {
      this.stats.dropped++; // network can't keep up; skip rather than lag
      return;
    }
    this.lastFrame = captureLocal;
    const k = Math.min(1, (cfg.capture_max_side ?? 1280) / Math.max(w, h));
    this.canvas.width = Math.round(w * k);
    this.canvas.height = Math.round(h * k);
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    const t = conn.toHost(captureLocal);
    this.stats.inflight++;
    this.canvas.toBlob(async (blob) => {
      try {
        if (blob) {
          await fetch(`/api/scans/${this.id}/frame?t=${t.toFixed(1)}`, {
            method: "POST", body: blob, headers: { "Content-Type": "image/jpeg" },
          });
          this.stats.frames++;
        }
      } catch {
        this.stats.dropped++;
      } finally {
        this.stats.inflight--;
      }
    }, "image/jpeg", cfg.jpeg_quality ?? 0.85);
  }

  private motion(e: DeviceMotionEvent): void {
    const a = e.acceleration;
    const g = e.accelerationIncludingGravity;
    const r = e.rotationRate;
    const angle = (screen.orientation?.angle ?? (window as any).orientation ?? 0) % 360;
    this.motionBuf.push({
      t: conn.toHost(e.timeStamp),
      a: a && a.x != null ? [a.x, a.y, a.z] : null,
      g: g && g.x != null ? [g.x, g.y, g.z] : null,
      r: r && r.alpha != null ? [r.alpha, r.beta, r.gamma] : null,
      angle,
    });
    if (r && r.alpha != null) {
      const rate = Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0);
      this.stats.turnRate = this.stats.turnRate * 0.9 + rate * 0.1;
    }
    this.stats.motion = true;
  }

  private flushMotion(): void {
    if (!this.motionBuf.length || !this.id) return;
    conn.send({ type: "motion", scan: this.id, samples: this.motionBuf });
    this.motionBuf = [];
  }

  private measureBrightness(): void {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 32;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(this.video, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    this.stats.brightness = sum / (d.length / 4);
  }
}
