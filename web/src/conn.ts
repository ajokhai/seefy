// Connection to the host: WebSocket with reconnect, plus clock sync.
//
// Clock sync: the phone sends ping {t0} (its performance.now()), the host
// answers with its own clock, and the phone notes the arrival time t3.
// offset = host - (t0 + t3) / 2. Samples with the shortest round trips are the
// most trustworthy, so the offset is the median of those, and half the
// shortest round trip bounds the error.

type Handler = (msg: any) => void;

export interface SyncInfo {
  offset_ms: number;
  rtt_ms: number;
  err_ms: number;
  samples: number;
}

function deviceId(): string {
  try {
    let id = localStorage.getItem("seefy.device");
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem("seefy.device", id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Browser";
}

// Each tab gets its own id (kept across reloads of that tab), so two open tabs don't
// replace each other's connection.
function tabId(): string {
  try {
    let id = sessionStorage.getItem("seefy.tab");
    if (!id) {
      id = Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem("seefy.tab", id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 8);
  }
}

export const isTouch = matchMedia("(pointer: coarse)").matches;

export class Conn {
  readonly id = deviceId();
  readonly name = deviceName();
  readonly tab = tabId();
  ws: WebSocket | null = null;
  connected = false;

  config: any = null;
  tagmap: any = null;
  lens: any = null;
  session: any = null;
  state: any = null;
  sync: SyncInfo | null = null;

  private offset = 0;
  private samples: { offset: number; rtt: number }[] = [];
  private pingId = 0;
  private listeners = new Map<string, Set<Handler>>();
  private syncTimer = 0;

  connect(): void {
    // Never run two sockets at once: a stray second socket makes the server replace the first,
    // whose close would then trigger yet another reconnect, and so on.
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const q = new URLSearchParams({ role: isTouch ? "phone" : "viewer", device: this.id, name: this.name, tab: this.tab });
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${q}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.emit("open", {});
      this.startSync();
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return; // an old socket; a newer one is already in charge
      this.connected = false;
      window.clearTimeout(this.syncTimer);
      this.emit("close", {});
      if (e.code === 4000) return; // replaced by this same tab elsewhere (e.g. a reload)
      window.setTimeout(() => this.connect(), 1000);
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
  }

  on(type: string, fn: Handler): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
    return () => this.listeners.get(type)!.delete(fn);
  }

  private emit(type: string, msg: any): void {
    this.listeners.get(type)?.forEach((fn) => fn(msg));
  }

  /** Host-clock time now, in ms. */
  hostNow(): number {
    return performance.now() + this.offset;
  }

  /** Convert a local performance.now()-based timestamp to host time. */
  toHost(local: number): number {
    return local + this.offset;
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...msg, ts: this.hostNow() }));
    }
  }

  async api(path: string, method = "GET", body?: unknown): Promise<any> {
    const r = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case "welcome":
        this.config = msg.config;
        this.tagmap = msg.tagmap;
        this.lens = msg.lens;
        this.session = msg.session;
        break;
      case "pong":
        this.onPong(msg);
        return;
      case "config":
        this.config = msg.config;
        break;
      case "tagmap":
        this.tagmap = msg.tagmap;
        break;
      case "lens":
        this.lens = msg.lens;
        break;
      case "session":
        this.session = msg.session;
        break;
      case "state":
        this.state = msg;
        this.session = msg.session;
        break;
    }
    this.emit(msg.type, msg);
  }

  // ---- clock sync ---------------------------------------------------------

  private startSync(): void {
    const burst = () => {
      const s = this.config?.sync ?? { interval_s: 2, burst: 5 };
      for (let i = 0; i < s.burst; i++) {
        window.setTimeout(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "ping", id: ++this.pingId, t0: performance.now() }));
          }
        }, i * 40);
      }
      window.setTimeout(() => this.reportSync(), s.burst * 40 + 300);
      // Burst faster until a few samples are in, so tracking can start quickly.
      this.syncTimer = window.setTimeout(burst, this.samples.length < 15 ? 300 : s.interval_s * 1000);
    };
    burst();
  }

  private onPong(msg: { t0: number; host: number }): void {
    const t3 = performance.now();
    const rtt = t3 - msg.t0;
    this.samples.push({ offset: msg.host - (msg.t0 + t3) / 2, rtt });
    const window_ = this.config?.sync?.window ?? 60;
    if (this.samples.length > window_) this.samples.splice(0, this.samples.length - window_);

    const slack = this.config?.sync?.rtt_slack_ms ?? 2;
    const minRtt = Math.min(...this.samples.map((s) => s.rtt));
    const trusted = this.samples.filter((s) => s.rtt <= minRtt + slack).map((s) => s.offset).sort((a, b) => a - b);
    this.offset = trusted[Math.floor(trusted.length / 2)];
    this.sync = { offset_ms: this.offset, rtt_ms: minRtt, err_ms: minRtt / 2, samples: this.samples.length };
    this.emit("sync", this.sync);
  }

  private reportSync(): void {
    if (this.sync) this.send({ type: "sync", ...this.sync });
  }
}

export const conn = new Conn();
