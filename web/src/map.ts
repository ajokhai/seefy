// Map (docs/UX.md): one space's floor plan, big. Tap a room to name it; extend the map with another
// scan (it joins automatically where the scans overlap); see the scans it's built from; switch space.
// Data: GET /api/spaces, GET /api/spaces/{id}/map → {space, map, status, pieces}.

import { conn, isTouch } from "./conn";
import { scanSpace } from "./onboarding";
import { drawPlan } from "./plan2d";
import { askText, confirmSheet, fmt, h, sheet, toast } from "./ui";

const when = (t: number) => new Date(t * 1000).toLocaleDateString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function mapScreen(): { el: HTMLElement; destroy: () => void } {
  const el = h("div", { class: "mapscreen" });
  let spaces: any[] = [];
  let active: any = null;
  let data: any = null; // {space, map, status, pieces}
  let view = { s: 1, x0: 0, y0: 0, H: 0, ox: 0, oy: 0 };

  async function load() {
    try {
      const r = await conn.api("/api/spaces");
      spaces = r.spaces ?? [];
      active = spaces.find((s) => s.id === r.active) ?? spaces[0] ?? null;
      data = active ? await conn.api(`/api/spaces/${active.id}/map`) : null;
    } catch {
      el.replaceChildren(h("div", { class: "empty-state" }, h("h2", {}, "Map isn't available"), h("p", { class: "muted" }, "Restart Seefy on this Mac, then reload.")));
      return;
    }
    render();
  }

  function render() {
    if (!active) {
      el.replaceChildren(h("div", { class: "empty-state" },
        h("h2", {}, "No space mapped yet"),
        h("p", { class: "muted" }, isTouch ? "Map your first space with this phone." : "Map your first space with your phone."),
        h("a", { class: "btn primary-sm", href: "#setup" }, "Get started")));
      return;
    }
    const map = data?.map;
    const lay = map?.layout;
    const rooms: any[] = lay?.ok ? lay.rooms ?? [] : [];
    const frames: any[] = map?.frames ?? [];
    const cover = frames.length ? frames[Math.floor(frames.length / 2)] : null;
    const coverScan = cover?.scan ?? map?.id ?? active.scans?.[active.scans.length - 1];
    const pieces: any[] = data?.pieces ?? [];
    const unjoined = pieces.filter((p) => !p.joined).length;

    const facts: string[] = [];
    if (rooms.length) facts.push(`${rooms.length} room${rooms.length === 1 ? "" : "s"}`);
    if (lay?.ok) facts.push(`${fmt(lay.size_m[0], 1)} × ${fmt(lay.size_m[1], 1)} m${map?.quality?.size_source === "measured" ? "" : " (estimated)"}`);

    const canvas = h("canvas", { class: "map-plan" }) as HTMLCanvasElement;
    canvas.onclick = (e) => tapRoom(e, canvas, rooms);

    el.replaceChildren(...([
      h("section", { class: "space-head" },
        cover && coverScan ? h("div", { class: "space-cover", style: `background-image:url("/api/scans/${encodeURIComponent(coverScan)}/frames/${encodeURIComponent(cover.name)}")` }) : null,
        h("div", { class: "space-title" },
          h("div", {},
            h("h2", {}, active.name),
            h("p", { class: "muted" }, facts.join(" · ") || "Map being built")),
          h("button", { class: "pill", onclick: switchSpace }, spaces.length > 1 ? "Switch space" : "Spaces"))),
      data?.status === "joining" ? h("div", { class: "banner busy" }, h("span", { class: "dot" }), "Joining your latest scan to the map…") : null,
      unjoined ? h("div", { class: "banner warn" }, `${unjoined} area${unjoined === 1 ? " isn't" : "s aren't"} joined to the map yet. Scan the place where they meet to join them.`) : null,
      h("section", { class: "map-card" },
        canvas,
        lay && !lay.ok ? h("div", { class: "map-empty" }, h("p", {}, lay.reason)) : null,
        rooms.some((r) => !r.name) ? h("p", { class: "map-hint" }, "Tap a room to name it") : null),
      h("div", { class: "map-actions" },
        h("button", { class: "primary", onclick: extend }, "Extend map"),
        h("button", { class: "ob-secondary", onclick: newSpace }, "Map a different place")),
      scansList(),
    ].filter(Boolean) as Node[]));
    requestAnimationFrame(() => draw(canvas, map));
  }

  function scansList(): HTMLElement {
    const pieces: any[] = data?.pieces ?? [];
    const joinedOf = (sid: string) => pieces.find((p) => p.scans?.includes(sid))?.joined ?? true;
    const ids: string[] = active?.scans_list ?? data?.space?.scans ?? active?.scans ?? [];
    if (!Array.isArray(ids) || !ids.length) return h("span");
    return h("section", {},
      h("h3", { class: "section-title" }, "Built from"),
      h("div", { class: "group list" }, ...ids.map((sid: string, i: number) => {
        const d = sid.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
        const label = d ? when(Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5]) / 1000 + new Date().getTimezoneOffset() * 60) : sid;
        return h("a", { class: "set-row", href: `#scan/${sid}` },
          h("div", { class: "set-text" }, h("b", {}, `Scan ${i + 1}`), h("span", {}, `${label}${joinedOf(sid) ? "" : " · not joined yet"}`)),
          h("span", { class: "muted small" }, "Check accuracy"), h("span", { class: "chev" }, "›"));
      })));
  }

  function draw(c: HTMLCanvasElement, map: any) {
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const lay = map?.layout;
    const pts: number[][] = (map?.points ?? []).filter((q: number[]) => q[2] > 0.15 && q[2] < 2.3);
    const xy: number[][] = lay?.ok ? lay.outline : pts;
    if (!xy.length) return;
    const xs = xy.map((p) => p[0]).sort((a, b) => a - b);
    const ys = xy.map((p) => p[1]).sort((a, b) => a - b);
    const k = lay?.ok ? 0 : Math.floor(xs.length * 0.02);
    const [x0, x1, y0, y1] = [xs[k], xs[xs.length - 1 - k], ys[k], ys[ys.length - 1 - k]];
    const pad = 36;
    const s = Math.min((W - 2 * pad) / Math.max(x1 - x0, 0.5), (H - 2 * pad) / Math.max(y1 - y0, 0.5));
    const ox = (W - s * (x1 - x0)) / 2;
    const oy = (H - s * (y1 - y0)) / 2;
    view = { s, x0, y0, H, ox, oy };
    const X = (x: number) => ox + (x - x0) * s;
    const Y = (y: number) => H - (oy + (y - y0) * s);
    if (lay?.ok) {
      drawPlan(g, lay, X, Y, s);
      const fg = getComputedStyle(document.documentElement).getPropertyValue("--fg");
      const muted = getComputedStyle(document.documentElement).getPropertyValue("--muted");
      g.textAlign = "center";
      g.textBaseline = "middle";
      for (const r of lay.rooms ?? []) {
        g.fillStyle = r.name ? fg : muted;
        g.font = r.name ? "600 15px -apple-system, system-ui" : "500 13px -apple-system, system-ui";
        g.fillText(r.name ?? "Name this room", X(r.center[0]), Y(r.center[1]) - 8);
        g.fillStyle = muted;
        g.font = "12px -apple-system, system-ui";
        g.fillText(`${fmt(r.area_m2, 0)} m²`, X(r.center[0]), Y(r.center[1]) + 10);
      }
      g.textAlign = "start";
      g.textBaseline = "alphabetic";
    } else {
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--scan-point");
      for (const q of pts) g.fillRect(X(q[0]) - 0.75, Y(q[1]) - 0.75, 1.5, 1.5);
    }
  }

  async function tapRoom(e: MouseEvent, c: HTMLCanvasElement, rooms: any[]) {
    const r = c.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const x = view.x0 + (px - view.ox) / view.s;
    const y = view.y0 + (view.H - py - view.oy) / view.s;
    const room = rooms.find((rm) => inside([x, y], rm.outline));
    if (!room) return;
    const name = await askText(room.name ? "Rename room" : "Name this room", {
      value: room.name ?? "", placeholder: "Living room", action: "Save",
      hint: `${fmt(room.area_m2, 0)} m². Names stay with this spot even when the map is rebuilt.`,
    });
    if (!name) return;
    try {
      await conn.api(`/api/spaces/${active.id}`, "PATCH", { region_names: { [`${room.center[0].toFixed(2)},${room.center[1].toFixed(2)}`]: { name, at: room.center } } });
      load();
    } catch (err: any) {
      toast(String(err.message ?? err));
    }
  }

  async function extend() {
    if (!isTouch) {
      sheet((close) => h("div", { class: "sheet-body" },
        h("h2", {}, "Extend the map with your phone"),
        h("p", { class: "muted" }, "Open Seefy on your phone, go to Map and tap Extend map. Start somewhere you've already scanned and walk into the new area."),
        h("img", { class: "ob-qr", src: "/api/qr.svg", alt: "QR code that opens Seefy on your phone", width: 180, height: 180 }),
        h("button", { class: "primary", onclick: close }, "OK")));
      return;
    }
    const out = await scanSpace({});
    if (out.action === "saved") load();
  }

  async function newSpace() {
    const name = await askText("Map a different place", { placeholder: "Office", action: "Create", hint: "A separate place gets its own map. Your current map stays as it is." });
    if (!name) return;
    try {
      const sp = await conn.api("/api/spaces", "POST", { name });
      await conn.api(`/api/spaces/${sp.id}`, "PATCH", { active: true });
      if (isTouch) {
        const out = await scanSpace({});
        if (out.action === "saved") toast(`${name} mapped`);
      } else {
        toast(`${name} created. Scan it with your phone.`);
      }
      load();
    } catch (e: any) {
      toast(String(e.message ?? e));
    }
  }

  function switchSpace() {
    sheet((close) => h("div", { class: "sheet-body" },
      h("h2", {}, "Spaces"),
      h("div", { class: "group list" }, ...spaces.map((s) =>
        h("div", { class: "set-row" },
          h("button", { class: "set-text plain", onclick: async () => { close(); await conn.api(`/api/spaces/${s.id}`, "PATCH", { active: true }); load(); } },
            h("b", {}, s.name), h("span", {}, s.id === active.id ? "Showing now" : "Tap to show")),
          h("button", { class: "link-btn", onclick: async () => {
            close();
            const n = await askText("Rename space", { value: s.name });
            if (n) { await conn.api(`/api/spaces/${s.id}`, "PATCH", { name: n }); load(); }
          } }, "Rename"),
          h("button", { class: "link-btn danger", onclick: async () => {
            close();
            if (await confirmSheet(`Delete ${s.name}?`, "Its map is removed from Seefy. The scans stay on this Mac.", "Delete space", true)) {
              await conn.api(`/api/spaces/${s.id}`, "DELETE");
              load();
            }
          } }, "Delete")))),
      h("button", { class: "primary", onclick: () => { close(); newSpace(); } }, "Map a different place")));
  }

  let sig = "";
  const offs = [
    conn.on("state", (m) => {
      const s = JSON.stringify(m.space ?? null);
      if (s !== sig) {
        if (sig) load();
        sig = s;
      }
    }),
    conn.on("space_map", () => load()),
    conn.on("scan", (m) => m.status === "done" && load()),
  ];
  el.replaceChildren(h("div", { class: "skeleton map-skel" }));
  load();
  return { el, destroy: () => offs.forEach((off) => off()) };
}

function inside([x, y]: number[], poly: number[][]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
