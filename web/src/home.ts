// Home (docs/UX.md): is anyone moving at home, the floor plan of the home, and its rooms.
//
// With only the Mac's own WiFi link Seefy knows *that* someone moves, not *where*, so the status
// says "at home" and names no room until per-room sensing exists.

import { conn, isTouch } from "./conn";
import { scanRoom } from "./onboarding";
import { drawPlan } from "./plan2d";
import { h, toast } from "./ui";

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function homeScreen(): { el: HTMLElement; destroy: () => void } {
  const hero = h("section", { class: "home-hero" });
  const canvas = h("canvas", { class: "home-plan" }) as HTMLCanvasElement;
  const planEmpty = h("div", { class: "home-plan-empty" });
  const list = h("div", { class: "home-rooms" });
  const el = h("div", { class: "home" }, hero,
    h("section", { class: "home-map" }, canvas, planEmpty),
    h("h3", { class: "section-title" }, "Rooms"), list);

  let wifi: any = null;
  let quietSince = Date.now();
  let lastMove = 0;
  let rooms: { room: any; map: any }[] = [];

  // ---- status -----------------------------------------------------------------
  function renderHero() {
    const m = wifi;
    let tone = "off";
    let big = "Starting…";
    let small = "Connecting to this Mac's WiFi";
    let action: HTMLElement | null = null;
    if (m?.error) {
      big = "Movement sensing is off";
      small = "This Mac couldn't read its WiFi signal. Check that WiFi is on.";
    } else if (m?.baseline === "recording") {
      tone = "busy";
      big = `Keep still… ${Math.ceil(m.calibrate_left_s ?? 0)}`;
      small = "Learning what a still home looks like. Leave the room if you can.";
    } else if (m) {
      if (m.moving) {
        tone = "moving";
        big = "Movement at home";
        small = "Right now";
      } else {
        tone = "quiet";
        big = "All quiet";
        small = lastMove ? `Since ${clock(quietSince)}` : "No movement since Seefy started";
      }
      if (m.baseline !== "saved") {
        small += " · Not taught yet, so it may be jumpy";
        action = h("button", { onclick: teach }, "Teach Seefy a still home");
      }
    }
    hero.className = `home-hero ${tone}`;
    hero.replaceChildren(h("span", { class: "pulse" }), h("div", {}, h("div", { class: "big" }, big), h("div", { class: "small" }, small)), ...(action ? [action] : []));
  }

  async function teach() {
    if (!confirm("For 20 seconds nobody should move. Leave the room if you can. Start?")) return;
    try {
      await conn.api("/api/wifi/baseline", "POST", { seconds: 20 });
    } catch (e: any) {
      toast(`Couldn't start: ${String(e.message ?? e)}`);
    }
  }

  // ---- plan of the whole home -------------------------------------------------
  async function loadMap() {
    const sp = conn.state?.space;
    if (!sp) {
      rooms = [];
    } else {
      try {
        rooms = (await conn.api(`/api/spaces/${sp.id}/map`)).rooms ?? [];
      } catch {
        rooms = [];
      }
    }
    drawHome();
    renderRooms();
  }

  function drawHome() {
    const mapped = rooms.filter((r) => r.map?.layout?.ok);
    planEmpty.replaceChildren();
    planEmpty.hidden = mapped.length > 0;
    if (!mapped.length) {
      planEmpty.append(h("p", {}, rooms.length ? "No room has walls yet." : "Your home's floor plan appears here."),
        h("button", { class: "primary-sm", onclick: addRoom }, isTouch ? "Map a room" : "Map a room with your phone"));
    }
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const g = canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!mapped.length) return;
    // Each room sits at its placement (rooms aren't stitched yet; the server lays them side by side).
    const place = (r: any, [x, y]: number[]) => {
      const p = r.room.placement ?? { x: 0, y: 0, yaw: 0 };
      const c = Math.cos(p.yaw ?? 0), s = Math.sin(p.yaw ?? 0);
      return [p.x + c * x - s * y, p.y + s * x + c * y];
    };
    const pts = mapped.flatMap((r) => r.map.layout.outline.map((q: number[]) => place(r, q)));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 40;
    const sc = Math.min((W - 2 * pad) / Math.max(x1 - x0, 1), (H - 2 * pad) / Math.max(y1 - y0, 1), 140);
    const ox = (W - sc * (x1 - x0)) / 2;
    const oy = (H - sc * (y1 - y0)) / 2;
    const moving = !!wifi?.moving;
    for (const r of mapped) {
      const p = r.room.placement ?? { x: 0, y: 0, yaw: 0 };
      g.save();
      // World (x, y) -> canvas: flip y, then the room's own placement.
      g.translate(ox + (p.x - x0) * sc, H - oy - (p.y - y0) * sc);
      g.rotate(-(p.yaw ?? 0));
      drawPlan(g, r.map.layout, (x) => x * sc, (y) => -y * sc, sc, { labels: false, glow: moving });
      const o = r.map.layout.outline;
      const cx = o.reduce((a: number, q: number[]) => a + q[0], 0) / o.length;
      const cy = o.reduce((a: number, q: number[]) => a + q[1], 0) / o.length;
      g.restore();
      const [wx, wy] = place(r, [cx, cy]);
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fg");
      g.font = "600 14px -apple-system, system-ui";
      g.textAlign = "center";
      g.fillText(r.room.name, ox + (wx - x0) * sc, H - oy - (wy - y0) * sc);
    }
    g.textAlign = "start";
  }

  function renderRooms() {
    const sp = conn.state?.space;
    const all = rooms.length ? rooms.map((r) => r.room) : sp?.rooms ?? [];
    list.replaceChildren(
      ...all.map((r: any) => {
        const level = r.scan?.level ?? r.level;
        const state = !r.scan_id ? ["Not mapped yet", "off"] : level === "short" ? ["Partly mapped", "warn"] : ["Mapped", "ok"];
        return h("a", { class: "home-room", href: "#rooms" },
          h("span", { class: "home-room-name" }, r.name),
          h("span", { class: `badge ${state[1]}` }, state[0]),
          h("span", { class: "chev" }, "›"));
      }),
      h("button", { class: "home-room add", onclick: addRoom }, "+ Add a room"),
    );
  }

  async function addRoom() {
    if (!isTouch) {
      toast("Open Seefy on your phone and choose Add a room. Settings has the code to scan.");
      return;
    }
    const name = prompt("Name the room", "Bedroom")?.trim();
    const sp = conn.state?.space;
    if (!name || !sp) return;
    try {
      const r = await conn.api(`/api/spaces/${sp.id}/rooms`, "POST", { name });
      scanRoom(r.id);
    } catch (e: any) {
      toast(String(e.message ?? e));
    }
  }

  let sig = "";
  const resize = new ResizeObserver(() => drawHome());
  resize.observe(canvas);
  const offs = [
    conn.on("wifi", (m) => {
      const was = !!wifi?.moving;
      wifi = m;
      if (m.moving) lastMove = Date.now();
      if (was && !m.moving) quietSince = Date.now();
      renderHero();
      if (was !== !!m.moving) drawHome();
    }),
    conn.on("state", (m) => {
      const s = JSON.stringify(m.space ?? null);
      if (s !== sig) {
        sig = s;
        loadMap();
      }
    }),
    conn.on("scan", (m) => {
      if (m.status === "done") loadMap();
    }),
  ];
  conn.api("/api/wifi").then((r: any) => {
    if (!wifi && r) {
      wifi = r.latest ?? r;
      renderHero();
    }
  }).catch(() => {});
  renderHero();
  loadMap();
  return { el, destroy: () => { offs.forEach((off) => off()); resize.disconnect(); } };
}
