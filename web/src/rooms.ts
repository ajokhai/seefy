// Rooms screen: the home (a space) and its rooms. Each room card shows a small floor plan, how
// good its scan is, and what you can do with it: rename, rescan, check accuracy, delete.
// Data comes from the spaces API (server/seefy/spaces.py): GET /api/spaces, GET /api/spaces/{id}/map.

import { conn, isTouch } from "./conn";
import { mapEditor } from "./editor";
import { drawPlan } from "./plan2d";
import { fmt, h, toast } from "./ui";

const LEVEL: Record<string, [string, string]> = {
  short: ["Needs more scanning", "warn"],
  enough: ["Good scan", "ok"],
  extra: ["Great scan", "ok"],
};

export function roomsScreen(): { el: HTMLElement; destroy: () => void } {
  const el = h("div", { class: "rooms" });
  let spaces: any[] = [];
  let activeId: string | null = null;
  let maps = new Map<string, any>(); // room id -> active scan result
  let busy = false;

  const space = () => spaces.find((s) => s.id === activeId) ?? null;

  async function load() {
    try {
      const r = await conn.api("/api/spaces");
      spaces = r.spaces ?? [];
      activeId = r.active ?? spaces[0]?.id ?? null;
      maps = new Map();
      if (activeId) {
        const m = await conn.api(`/api/spaces/${activeId}/map`);
        for (const { room, map } of m.rooms ?? []) maps.set(room.id, map);
      }
    } catch (e: any) {
      el.replaceChildren(h("div", { class: "card empty" }, h("h2", {}, "Rooms aren't available"),
        h("p", { class: "muted" }, "The Seefy server on this computer needs updating. Restart it, then reload this page.")));
      return;
    }
    render();
  }

  async function act(fn: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e: any) {
      toast(String(e.message ?? e));
    }
    busy = false;
    await load();
  }

  const ask = (q: string, v = "") => {
    const a = prompt(q, v);
    return a && a.trim() ? a.trim() : null;
  };

  function render() {
    const sp = space();
    if (!sp) {
      // First run: name the home, then the first room.
      const name = h("input", { type: "text", placeholder: "My home", value: "" }) as HTMLInputElement;
      el.replaceChildren(h("div", { class: "card empty" },
        h("h2", {}, "Map your home"),
        h("p", { class: "muted" }, "Seefy maps each room once with your phone's camera, then watches for movement using WiFi."),
        h("div", { class: "row" }, name,
          h("button", { class: "primary", onclick: () => act(async () => {
            const s = await conn.api("/api/spaces", "POST", { name: name.value.trim() || "My home" });
            await conn.api(`/api/spaces/${s.id}/rooms`, "POST", { name: "Living room" });
          }) }, "Create"))));
      return;
    }

    const head = h("div", { class: "rooms-head" },
      h("div", {},
        h("h2", {}, sp.name),
        h("p", { class: "muted" }, `${sp.rooms.length} room${sp.rooms.length === 1 ? "" : "s"} · ` +
          `${sp.rooms.filter((r: any) => r.scan_id).length} scanned`)),
      h("div", { class: "row" },
        spaces.length > 1
          ? (() => {
              const sel = h("select", { onchange: () => act(() => conn.api(`/api/spaces/${sel.value}`, "PATCH", { active: true })) },
                ...spaces.map((s) => h("option", { value: s.id }, s.name))) as HTMLSelectElement;
              sel.value = sp.id;
              return sel;
            })()
          : null,
        h("button", { onclick: () => { const n = ask("Rename this home", sp.name); if (n) act(() => conn.api(`/api/spaces/${sp.id}`, "PATCH", { name: n })); } }, "Rename"),
        h("button", { onclick: () => { const n = ask("Name the new home"); if (n) act(async () => {
          const s = await conn.api("/api/spaces", "POST", { name: n });
          await conn.api(`/api/spaces/${s.id}`, "PATCH", { active: true });
        }); } }, "New home"),
        h("button", { class: "danger", onclick: () => {
          if (confirm(`Delete “${sp.name}” and its rooms? The scans stay on this computer.`)) act(() => conn.api(`/api/spaces/${sp.id}`, "DELETE"));
        } }, "Delete")));

    const cards = [...sp.rooms].sort((a: any, b: any) => a.order - b.order).map((r: any) => roomCard(sp, r));
    const add = h("button", { class: "room-card add", onclick: () => { const n = ask("Name the room", `Room ${sp.rooms.length + 1}`); if (n) act(() => conn.api(`/api/spaces/${sp.id}/rooms`, "POST", { name: n })); } },
      h("span", { class: "plus" }, "+"), "Add a room");
    el.replaceChildren(head, h("div", { class: "room-grid" }, ...cards, add));
  }

  function roomCard(sp: any, r: any): HTMLElement {
    const map = maps.get(r.id);
    const lay = r.layout ?? map?.layout;
    const [label, tone] = r.scan?.level ? LEVEL[r.scan.level] ?? [r.scan.level, "off"] : r.scan_id ? ["Scanned", "off"] : ["Not scanned yet", "off"];
    const active = sp.active_room === r.id;
    const canvas = h("canvas", { class: "room-plan" }) as HTMLCanvasElement;
    requestAnimationFrame(() => drawMini(canvas, map, lay));

    const facts: string[] = [];
    if (lay?.ok) {
      facts.push(`${fmt(lay.size_m[0], 1)} × ${fmt(lay.size_m[1], 1)} m`);
      const doors = lay.walls.reduce((n: number, w: any) => n + w.openings.length, 0);
      facts.push(`${doors} door${doors === 1 ? "" : "s"}`, `${lay.objects.length} furniture`);
    } else if (r.scan?.room_size_m?.length) {
      facts.push(`about ${fmt(r.scan.room_size_m[0], 1)} × ${fmt(r.scan.room_size_m[1], 1)} m`);
    }

    const rescan = () => act(async () => {
      await conn.api(`/api/spaces/${sp.id}`, "PATCH", { active_room: r.id });
      if (isTouch) location.hash = "#guide";
      else toast(`Open Seefy on your phone and scan. The scan will be saved to ${r.name}.`);
    });

    return h("section", { class: `room-card ${active ? "active" : ""}` },
      h("div", { class: "room-plan-wrap" }, canvas,
        !r.scan_id ? h("div", { class: "room-plan-empty" }, "No map yet") : null),
      h("div", { class: "room-body" },
        h("div", { class: "side-head" },
          h("h3", {}, r.name),
          h("span", { class: `badge ${tone}` }, label)),
        h("p", { class: "muted" }, facts.join(" · ") || (r.scan_id ? "Map ready" : "Scan this room with your phone to map it.")),
        lay && !lay.ok && r.scan_id ? h("p", { class: "room-hint" }, lay.reason) : null,
        r.edited ? h("p", { class: "muted" }, "Includes your edits") : null,
        h("div", { class: "room-actions" },
          h("button", { class: r.scan_id ? "" : "primary-sm", onclick: rescan }, r.scan_id ? "Rescan" : "Scan"),
          lay?.ok && !isTouch ? h("button", { onclick: () => openEditor(sp, r) }, "Edit map") : null,
          r.scan_id && !isTouch ? h("a", { class: "btn", href: `#scan/${r.scan_id}` }, "Check accuracy") : null,
          h("button", { onclick: () => { const n = ask("Rename the room", r.name); if (n) act(() => conn.api(`/api/spaces/${sp.id}/rooms/${r.id}`, "PATCH", { name: n })); } }, "Rename"),
          h("button", { class: "danger", onclick: () => {
            if (confirm(`Delete ${r.name}? Its scans stay on this computer.`)) act(() => conn.api(`/api/spaces/${sp.id}/rooms/${r.id}`, "DELETE"));
          } }, "Delete"))));
  }

  // The editor works on the scan's own layout plus the room's edits. Edits replace whole keys, so
  // the room's merged layout gives them back exactly.
  async function openEditor(sp: any, r: any) {
    let base: any;
    try {
      base = (await conn.api(`/api/scans/${r.scan_id}`)).result?.layout;
    } catch (e: any) {
      toast(String(e.message ?? e));
      return;
    }
    if (!base?.ok && !r.layout?.ok) return toast("This room has no walls to edit yet. Rescan it first.");
    const keys = ["outline", "size_m", "walls", "objects"];
    const overrides = r.edited && r.layout ? Object.fromEntries(keys.filter((k) => k in r.layout).map((k) => [k, r.layout[k]])) : null;
    let ed: { el: HTMLElement; destroy: () => void } | null = null;
    const close = () => {
      ed?.destroy();
      sheet.remove();
      document.removeEventListener("keydown", onKey);
      load();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    ed = mapEditor({
      layout: base?.ok ? base : r.layout,
      overrides: base?.ok ? overrides : null,
      points: maps.get(r.id)?.points,
      save: async (ov) => {
        await conn.api(`/api/spaces/${sp.id}/rooms/${r.id}`, "PATCH", { layout_overrides: ov ?? {} });
        toast(ov ? "Map saved" : "Back to the scanned map");
      },
    });
    const sheet = h("div", { class: "editor-sheet" },
      h("div", { class: "editor-panel" },
        h("div", { class: "side-head" }, h("h2", {}, `Edit ${r.name}`), h("button", { onclick: close }, "Done")),
        ed.el));
    sheet.addEventListener("click", (e) => e.target === sheet && close());
    document.addEventListener("keydown", onKey);
    document.body.append(sheet);
  }

  // Reload when a scan finishes or the rooms change elsewhere (another tab, the phone).
  let sig = "";
  const offs = [
    conn.on("state", (m) => {
      const s = JSON.stringify(m.space ?? null);
      if (s !== sig) {
        if (sig) load();
        sig = s;
      }
    }),
    conn.on("scan", (m) => {
      if (m.status === "done" || m.status === "failed") load();
    }),
  ];
  el.replaceChildren(h("p", { class: "muted" }, "Loading rooms…"));
  load();
  return { el, destroy: () => offs.forEach((off) => off()) };
}

/** A room's floor plan (or its points, until walls are found), fitted to a small canvas. */
function drawMini(c: HTMLCanvasElement, map: any, lay: any): void {
  const W = c.clientWidth;
  const H = c.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pts: number[][] = (map?.points ?? []).filter((q: number[]) => q[2] > 0.15 && q[2] < 2.3);
  const xy: number[][] = lay?.ok ? lay.outline : pts;
  if (!xy.length) return;
  const xs = xy.map((p) => p[0]).sort((a, b) => a - b);
  const ys = xy.map((p) => p[1]).sort((a, b) => a - b);
  const k = lay?.ok ? 0 : Math.floor(xs.length * 0.02);
  const [x0, x1, y0, y1] = [xs[k], xs[xs.length - 1 - k], ys[k], ys[ys.length - 1 - k]];
  const pad = 22;
  const s = Math.min((W - 2 * pad) / Math.max(x1 - x0, 0.5), (H - 2 * pad) / Math.max(y1 - y0, 0.5));
  const ox = (W - s * (x1 - x0)) / 2;
  const oy = (H - s * (y1 - y0)) / 2;
  const X = (x: number) => ox + (x - x0) * s;
  const Y = (y: number) => H - (oy + (y - y0) * s);
  if (lay?.ok) drawPlan(g, lay, X, Y, s);
  g.globalAlpha = lay?.ok ? 0.25 : 0.6;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--scan-point");
  for (const q of pts) g.fillRect(X(q[0]) - 0.6, Y(q[1]) - 0.6, 1.2, 1.2);
  g.globalAlpha = 1;
}
