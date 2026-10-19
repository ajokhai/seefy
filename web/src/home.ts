// Home (docs/UX.md): is anyone moving, the floor plan of the space, and its rooms.
//
// With only the Mac's own WiFi link Seefy knows *that* someone moves, not *where*, so the status
// says "at home" and names no room until per-room sensing exists.

import { conn, isTouch } from "./conn";
import { isActive, jobText, onJobs, progressBar } from "./jobs";
import { scanSpace } from "./onboarding";
import { drawPlan } from "./plan2d";
import { confirmSheet, fmt, h, toast } from "./ui";

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function homeScreen(): { el: HTMLElement; destroy: () => void } {
  const hero = h("section", { class: "home-hero" });
  const canvas = h("canvas", { class: "home-plan" }) as HTMLCanvasElement;
  const planEmpty = h("div", { class: "home-plan-empty" });
  const list = h("div", { class: "home-rooms" });
  const jobEl = h("div"); // map building in the background, if any: tap for the Map tab's controls
  const el = h("div", { class: "home" }, hero, jobEl,
    h("a", { class: "home-map", href: "#map" }, canvas, planEmpty),
    h("h3", { class: "section-title" }, "Rooms"), list);

  let wifi: any = null;
  let quietSince = Date.now();
  let lastMove = 0;
  let map: any = null;

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
    if (!(await confirmSheet("Teach Seefy a still home", "For 20 seconds nobody should move. Leave the room if you can.", "Start"))) return;
    try {
      await conn.api("/api/wifi/baseline", "POST", { seconds: 20 });
    } catch (e: any) {
      toast(`Couldn't start: ${String(e.message ?? e)}`);
    }
  }

  // ---- floor plan of the space -----------------------------------------------
  async function loadMap() {
    const sp = conn.state?.space;
    try {
      map = sp ? (await conn.api(`/api/spaces/${sp.id}/map`)).map ?? null : null;
    } catch {
      map = null;
    }
    drawHome();
    renderRooms();
  }

  function drawHome() {
    const lay = map?.layout;
    planEmpty.replaceChildren();
    planEmpty.hidden = !!lay?.ok;
    if (!lay?.ok) {
      const sp = conn.state?.space;
      planEmpty.append(h("p", {}, sp ? lay?.reason ?? "Your floor plan appears here." : "Map your space to see its floor plan here."),
        sp ? h("button", { class: "primary-sm", onclick: (e: Event) => { e.preventDefault(); extend(); } }, isTouch ? "Extend the map" : "Extend the map with your phone")
          : h("button", { class: "primary-sm", onclick: (e: Event) => { e.preventDefault(); location.hash = "#setup"; } }, "Get started"));
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
    if (!lay?.ok) return;
    const xs = lay.outline.map((p: number[]) => p[0]);
    const ys = lay.outline.map((p: number[]) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 32;
    const s = Math.min((W - 2 * pad) / Math.max(x1 - x0, 1), (H - 2 * pad) / Math.max(y1 - y0, 1), 140);
    const ox = (W - s * (x1 - x0)) / 2;
    const oy = (H - s * (y1 - y0)) / 2;
    const X = (x: number) => ox + (x - x0) * s;
    const Y = (y: number) => H - (oy + (y - y0) * s);
    drawPlan(g, lay, X, Y, s, { labels: false, glow: !!wifi?.moving });
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fg");
    g.font = "600 14px -apple-system, system-ui";
    g.textAlign = "center";
    for (const r of lay.rooms ?? []) if (r.name) g.fillText(r.name, X(r.center[0]), Y(r.center[1]));
    g.textAlign = "start";
  }

  function renderRooms() {
    const rooms: any[] = map?.layout?.ok ? map.layout.rooms ?? [] : [];
    list.replaceChildren(
      ...rooms.map((r: any) => h("a", { class: "home-room", href: "#map" },
        h("span", { class: "home-room-name" }, r.name ?? "Unnamed room"),
        h("span", { class: "muted" }, `${fmt(r.area_m2, 0)} m²`),
        h("span", { class: "chev" }, "›"))),
      h("button", { class: "home-room add", onclick: extend }, "+ Extend the map"),
    );
  }

  async function extend() {
    if (!isTouch) {
      toast("On your phone, open Seefy and tap Extend the map. Settings has the code to scan.");
      return;
    }
    const out = await scanSpace({});
    if (out.action === "saved") loadMap();
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
    conn.on("space_map", () => loadMap()),
    onJobs((jobs) => {
      const live = jobs.filter(isActive);
      const j = live.find((x) => x.state === "running") ?? live[0];
      jobEl.replaceChildren(...(j ? [h("a", { class: "banner busy home-job", href: "#map" },
        h("div", { class: "job-main" },
          h("b", {}, live.length > 1 ? `${j.label} (+${live.length - 1} waiting)` : j.label),
          h("span", {}, jobText(j)), progressBar(j)),
        h("span", { class: "chev" }, "›"))] : []));
    }),
  ];
  conn.api("/api/wifi").then((r: any) => {
    if (!wifi && r) {
      wifi = r;
      renderHero();
    }
  }).catch(() => {});
  renderHero();
  loadMap();
  return { el, destroy: () => { offs.forEach((off) => off()); resize.disconnect(); } };
}
