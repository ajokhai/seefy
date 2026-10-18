// Phone camera tracking: camera capture -> tag worker -> pose -> host.
//
// Frames are timestamped at capture (requestVideoFrameCallback) and converted
// to the host clock, so every pose and tag observation lands on the same
// timeline as everything else the host records.

import { conn } from "./conn";

export interface Det {
  id: number;
  c: number[]; // 8 floats: TL, TR, BR, BL corners in full-res pixels
}

export interface Pose {
  ok: boolean;
  err: number;
  tags: number[];
  p: number[];
  R: number[];
}

export interface FrameResult {
  t: number; // host ms
  dets: Det[];
  pose: Pose | null;
  ms: number;
}

export type Mode = "track" | "lens";

const DEFAULT_HFOV_DEG = 68; // typical phone main camera, used until the lens is calibrated

export class Tracker {
  video: HTMLVideoElement;
  stream: MediaStream | null = null;
  mode: Mode = "track";
  running = false;
  intrinsics: { K: number[]; D: number[]; calibrated: boolean } | null = null;
  fps = 0;
  detectMs = 0;
  last: FrameResult | null = null;
  onResult: (r: FrameResult) => void = () => {};
  onStatus: (s: string) => void = () => {};

  private worker: Worker | null = null;
  private workerReady = false;
  private busy = false;
  private frameId = 0;
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  private lastTagsSent = 0;
  private lastLensSent = 0;
  private frameTimes: number[] = [];
  private wakeLock: any = null;
  private statusTimer = 0;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    conn.on("tagmap", () => this.pushMap());
    conn.on("welcome", () => this.pushMap());
    conn.on("lens", () => this.updateIntrinsics());
    conn.on("config", () => this.pushSettings());
  }

  async start(): Promise<void> {
    if (this.running) return;
    const cfg = conn.config?.tracking ?? {};
    this.onStatus("Starting camera…");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: cfg.capture_width ?? 1280 },
        height: { ideal: cfg.capture_height ?? 720 },
        frameRate: { ideal: 30 },
      },
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this.updateIntrinsics();
    await this.startWorker();
    this.running = true;
    await this.keepAwake();
    this.scheduleFrame();
    this.statusTimer = window.setInterval(() => this.sendStatus(), 1000);
    this.onStatus("");
  }

  stop(): void {
    this.running = false;
    window.clearInterval(this.statusTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.wakeLock?.release?.();
    this.wakeLock = null;
    this.sendStatus();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.sendStatus();
  }

  get size(): { w: number; h: number } {
    return { w: this.video.videoWidth, h: this.video.videoHeight };
  }

  // ---- setup --------------------------------------------------------------

  private startWorker(): Promise<void> {
    if (this.worker) return Promise.resolve();
    this.onStatus("Loading tag detector (about 10 MB, first time only)…");
    this.worker = new Worker("/tag-worker.js");
    return new Promise((resolve, reject) => {
      this.worker!.onmessage = (e) => {
        const m = e.data;
        if (m.type === "ready") {
          this.workerReady = true;
          this.pushMap();
          resolve();
        } else if (m.type === "result") {
          this.busy = false;
          this.handleResult(m);
        } else if (m.type === "error") {
          this.busy = false;
          console.error("tag worker:", m.error);
          if (!this.workerReady) reject(new Error(m.error));
        }
      };
      this.worker!.postMessage({ type: "init", url: "/vendor/opencv.js", settings: this.workerSettings() });
    });
  }

  private workerSettings() {
    const tr = conn.config?.tracking ?? {};
    const lens = conn.config?.lens ?? {};
    return {
      refinement: tr.corner_refinement,
      roomMaxId: tr.room_tag_max_id,
      minTagPx: tr.min_tag_px,
      maxReprojPx: tr.max_reproj_px,
      boardFirst: lens.board_first_id,
      boardCount: (lens.board_cols ?? 5) * (lens.board_rows ?? 7),
    };
  }

  private pushSettings(): void {
    this.worker?.postMessage({ type: "settings", settings: this.workerSettings() });
  }

  private pushMap(): void {
    if (!this.worker || !this.workerReady) return;
    const tags: Record<string, unknown> = {};
    for (const [id, t] of Object.entries<any>(conn.tagmap?.tags ?? {})) {
      tags[id] = { T: t.T, corners: t.corners, size: t.size ?? conn.tagmap.tag_size_m };
    }
    this.worker.postMessage({ type: "map", tags });
  }

  /** Use the host's lens calibration if it matches this resolution, else a typical field of view. */
  private updateIntrinsics(): void {
    const { w, h } = this.size;
    if (!w || !h) return;
    const lens = conn.lens;
    if (lens?.ok && Math.abs(lens.w / lens.h - w / h) < 0.01) {
      const s = w / lens.w;
      const K = lens.K.slice();
      K[0] *= s; K[2] *= s; K[4] *= s; K[5] *= s;
      this.intrinsics = { K, D: lens.D, calibrated: true };
      return;
    }
    const f = w / (2 * Math.tan((DEFAULT_HFOV_DEG * Math.PI) / 360));
    this.intrinsics = { K: [f, 0, w / 2, 0, f, h / 2, 0, 0, 1], D: [0, 0, 0, 0, 0], calibrated: false };
  }

  private async keepAwake(): Promise<void> {
    try {
      this.wakeLock = await (navigator as any).wakeLock?.request("screen");
    } catch {
      /* not supported or denied; tracking still works while the screen is on */
    }
    document.addEventListener("visibilitychange", async () => {
      if (this.running && document.visibilityState === "visible" && !this.wakeLock) {
        try {
          this.wakeLock = await (navigator as any).wakeLock?.request("screen");
        } catch {
          /* ignore */
        }
      }
    });
  }

  // ---- frame loop ---------------------------------------------------------

  private scheduleFrame(): void {
    if (!this.running) return;
    const v = this.video as any;
    if (v.requestVideoFrameCallback) {
      v.requestVideoFrameCallback((now: number, meta: any) => {
        this.onFrame(meta.captureTime ?? meta.presentationTime ?? now);
        this.scheduleFrame();
      });
    } else {
      requestAnimationFrame((now) => {
        this.onFrame(now);
        this.scheduleFrame();
      });
    }
  }

  private onFrame(captureLocal: number): void {
    const cfg = conn.config?.tracking ?? {};
    const minGap = 1000 / (cfg.detect_max_fps ?? 30);
    const lastT = this.frameTimes[this.frameTimes.length - 1] ?? -Infinity;
    if (this.busy || !this.workerReady || !this.intrinsics || captureLocal - lastT < minGap * 0.9) return;
    const { w, h } = this.size;
    if (!w) return;

    this.frameTimes.push(captureLocal);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.frameTimes.length > 1) {
      this.fps = (1000 * (this.frameTimes.length - 1)) / (captureLocal - this.frameTimes[0]);
    }

    const scale = Math.min(1, Math.max(0.25, cfg.detect_scale ?? 1));
    const sw = Math.round(w * scale);
    const sh = Math.round(h * scale);
    if (this.canvas.width !== sw || this.canvas.height !== sh) {
      this.canvas.width = sw;
      this.canvas.height = sh;
    }
    this.ctx.drawImage(this.video, 0, 0, sw, sh);
    const image = this.ctx.getImageData(0, 0, sw, sh);
    this.busy = true;
    this.worker!.postMessage(
      {
        type: "frame", id: ++this.frameId, image, scale, t: conn.toHost(captureLocal),
        K: this.intrinsics.K, D: this.intrinsics.D, track: this.mode === "track",
      },
      [image.data.buffer],
    );
  }

  private handleResult(r: FrameResult): void {
    this.detectMs = r.ms;
    this.last = r;
    const { w, h } = this.size;
    const cfg = conn.config ?? {};

    if (this.mode === "track") {
      if (r.pose?.ok) {
        conn.send({ type: "pose", t: r.t, src: "tags", p: r.pose.p, R: r.pose.R, err: r.pose.err, tags: r.pose.tags });
      }
      const room = r.dets.filter((d) => d.id <= (cfg.tracking?.room_tag_max_id ?? 49));
      const gap = (cfg.mapping?.keyframe_interval_s ?? 0.25) * 1000;
      if (room.length >= (cfg.mapping?.min_tags_per_frame ?? 2) && r.t - this.lastTagsSent >= gap) {
        this.lastTagsSent = r.t;
        conn.send({ type: "tags", mode: "track", t: r.t, w, h, K: this.intrinsics!.K, D: this.intrinsics!.D, dets: room });
      }
    } else {
      // Lens mode: send a board view about every 0.7 s while enough board tags are visible.
      const first = cfg.lens?.board_first_id ?? 200;
      const count = (cfg.lens?.board_cols ?? 5) * (cfg.lens?.board_rows ?? 7);
      const board = r.dets.filter((d) => d.id >= first && d.id < first + count);
      if (board.length >= (cfg.lens?.min_tags_per_view ?? 8) && r.t - this.lastLensSent > 700) {
        this.lastLensSent = r.t;
        conn.send({ type: "tags", mode: "lens", t: r.t, w, h, dets: board });
      }
    }
    this.onResult(r);
  }

  private sendStatus(): void {
    const { w, h } = this.size;
    conn.send({
      type: "status",
      mode: this.running ? this.mode : "idle",
      fps: Math.round(this.fps * 10) / 10,
      detect_ms: Math.round(this.detectMs * 10) / 10,
      tags_visible: this.last?.dets.length ?? 0,
      tracking: !!this.last?.pose?.ok,
      resolution: w ? `${w}x${h}` : null,
      lens_calibrated: !!this.intrinsics?.calibrated,
    });
  }
}
