// Markerless room scan: send camera frames and motion samples to the host, stamped on its clock.

import { conn } from "./conn";

export interface ScanStats {
  seconds: number;
  frames: number;
  sharpness: number; // recent median sharpness of sent frames (higher is crisper)
  blurry: number; // share of recent camera frames too blurry to use, 0..1
  inflight: number;
  dropped: number;
  turnRate: number; // deg/s, smoothed
  brightness: number; // 0-255
  motion: boolean;
}

export class ScanRecorder {
  id = "";
  running = false;
  stats: ScanStats = { seconds: 0, frames: 0, sharpness: 0, blurry: 0, inflight: 0, dropped: 0, turnRate: 0, brightness: 128, motion: false };
  onStats: (s: ScanStats) => void = () => {};

  private video: HTMLVideoElement;
  private slotStart = -Infinity; // each slot (1 / capture_fps) sends its sharpest camera frame
  private best: { sharp: number; t: number } | null = null;
  private bestCanvas = document.createElement("canvas");
  private probe = document.createElement("canvas");
  private probeCtx = this.probe.getContext("2d", { willReadFrequently: true })!;
  private recentSharp: number[] = [];
  private recentBlurry: boolean[] = [];
  private started = 0;
  private motionBuf: any[] = [];
  private timers: number[] = [];
  private onMotion = (e: DeviceMotionEvent) => this.motion(e);

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  /** Start a new scan, or resume an existing one ("Scan more") to extend its map. */
  async start(resumeId?: string): Promise<void> {
    const r = resumeId
      ? await conn.api(`/api/scans/${resumeId}/resume`, "POST")
      : await conn.api("/api/scans/start", "POST", { device: conn.id, room_id: conn.state?.space?.active_room ?? undefined });
    this.id = r.id;
    this.running = true;
    this.started = performance.now();
    this.stats = { seconds: 0, frames: 0, sharpness: 0, blurry: 0, inflight: 0, dropped: 0, turnRate: 0, brightness: 128, motion: false };
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

  /** Sharpness of the current video frame: variance of a Laplacian on a small grayscale copy. */
  private sharpness(): number {
    const w = 180, h = 320;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const [pw, ph] = vw > vh ? [h, w] : [w, h];
    this.probe.width = pw;
    this.probe.height = ph;
    this.probeCtx.drawImage(this.video, 0, 0, pw, ph);
    const d = this.probeCtx.getImageData(0, 0, pw, ph).data;
    const g = new Float32Array(pw * ph);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < ph - 1; y++) {
      for (let x = 1; x < pw - 1; x++) {
        const k = y * pw + x;
        const lap = g[k - pw] + g[k + pw] + g[k - 1] + g[k + 1] - 4 * g[k];
        sum += lap;
        sum2 += lap * lap;
        n++;
      }
    }
    const mean = sum / n;
    return sum2 / n - mean * mean;
  }

  private frame(captureLocal: number): void {
    const cfg = conn.config?.scan ?? {};
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w) return;
    const slot = 1000 / (cfg.capture_fps ?? 8);

    // Look at every camera frame; keep the sharpest one of this slot.
    const sharp = this.sharpness();
    const ref = this.median(this.recentSharp) || sharp;
    this.recentBlurry.push(sharp < ref * (cfg.blur_ratio ?? 0.5));
    if (this.recentBlurry.length > 60) this.recentBlurry.shift();
    this.stats.blurry = this.recentBlurry.filter(Boolean).length / this.recentBlurry.length;
    if (!this.best || sharp > this.best.sharp) {
      this.best = { sharp, t: captureLocal };
      const k = Math.min(1, (cfg.capture_max_side ?? 1280) / Math.max(w, h));
      this.bestCanvas.width = Math.round(w * k);
      this.bestCanvas.height = Math.round(h * k);
      this.bestCanvas.getContext("2d")!.drawImage(this.video, 0, 0, this.bestCanvas.width, this.bestCanvas.height);
    }
    if (captureLocal - this.slotStart < slot) return;

    // End of the slot: send its sharpest frame, unless it's far blurrier than usual.
    const pick = this.best!;
    this.best = null;
    this.slotStart = captureLocal;
    this.recentSharp.push(pick.sharp);
    if (this.recentSharp.length > 40) this.recentSharp.shift();
    this.stats.sharpness = this.median(this.recentSharp);
    if (pick.sharp < ref * (cfg.blur_ratio ?? 0.5) * 0.6) {
      this.stats.dropped++; // even the best of this slot is a smear; skip it
      return;
    }
    if (this.stats.inflight >= 6) {
      this.stats.dropped++; // network can't keep up; skip rather than lag
      return;
    }
    const t = conn.toHost(pick.t);
    const canvas = this.bestCanvas;
    this.bestCanvas = document.createElement("canvas"); // the next slot draws into a fresh canvas
    this.stats.inflight++;
    canvas.toBlob(async (blob) => {
      try {
        if (blob) {
          await fetch(`/api/scans/${this.id}/frame?t=${t.toFixed(1)}&sharp=${pick.sharp.toFixed(0)}`, {
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

  private median(v: number[]): number {
    if (!v.length) return 0;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
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
