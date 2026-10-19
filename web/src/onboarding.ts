// First run (docs/UX.md): one screen, one button at a time.
// Phone: welcome → name the home → pick the first room → before-you-scan tips → the scan flow.
// Mac: "set up Seefy on your phone" with a QR code, then follows the phone along until a room is mapped.

import { conn, isTouch } from "./conn";
import { h, toast } from "./ui";

const ROOMS = ["Living room", "Bedroom", "Kitchen", "Office", "Dining room", "Kids' room"];

// SF Symbols-style line art for the tips.
const art = (path: string) => {
  const span = h("span", { class: "ob-art" });
  span.innerHTML = `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  return span;
};
const TIPS: [string, string, string][] = [
  ["Turn the lights on", "The camera needs to see detail. Dim rooms map badly.",
    '<circle cx="24" cy="20" r="9"/><path d="M20 33h8M21 38h6M24 4v3M8 20H5M43 20h-3M12 8l2 2M36 8l-2 2"/>'],
  ["Move slowly, phone steady", "Walk at half your normal pace and turn gently. Blurry frames are thrown away.",
    '<rect x="17" y="6" width="14" height="28" rx="3"/><path d="M22 30h4M10 40h28M14 44h20"/>'],
  ["Walk around, point across", "Go around the room pointing the phone across it, at furniture, corners and doors, not at a blank wall.",
    '<rect x="6" y="8" width="36" height="32" rx="2"/><path d="M14 32l6-6 5 5 9-11"/><circle cx="14" cy="32" r="2"/>'],
];

/** Scan a room on this phone. The room must already be the active one.
 * The scan flow (camera, coaching, review) lives in the Guide until scanflow.ts replaces it. */
export function scanRoom(_roomId: string, _opts: { prep?: boolean; resume?: string } = {}): void {
  location.hash = "#capture";
}

/** True when this home has at least one mapped room: then the app opens on Home instead. */
export function isSetUp(): boolean {
  const sp = conn.state?.space;
  return !!sp?.rooms?.some((r: any) => r.scan_id);
}

export function onboardingScreen(): { el: HTMLElement; destroy: () => void } {
  return isTouch ? phoneFlow() : macFollow();
}

function phoneFlow(): { el: HTMLElement; destroy: () => void } {
  const el = h("div", { class: "ob" });
  let home = conn.state?.space?.name ?? "";
  let room = "";

  const page = (...kids: (Node | string | null)[]) => {
    el.replaceChildren(h("div", { class: "ob-page" }, ...kids));
    el.scrollTo?.(0, 0);
  };

  function welcome() {
    page(
      h("div", { class: "ob-hero" }, h("span", { class: "brand-mark big" })),
      h("h1", {}, "Welcome to Seefy"),
      h("p", { class: "ob-lead" }, "Map your home once with this phone. Then Seefy senses movement using your WiFi, with no cameras left on."),
      h("div", { class: "ob-actions" }, h("button", { class: "primary", onclick: nameHome }, "Get started")),
    );
  }

  function nameHome() {
    const input = h("input", { type: "text", value: home || "My home", autocomplete: "off" }) as HTMLInputElement;
    page(
      h("p", { class: "ob-step" }, "1 of 3"),
      h("h1", {}, "Name your home"),
      h("p", { class: "ob-lead" }, "You can map more than one place later."),
      input,
      h("div", { class: "ob-actions" }, h("button", { class: "primary", onclick: () => {
        home = input.value.trim() || "My home";
        pickRoom();
      } }, "Continue")),
    );
  }

  function pickRoom() {
    const other = h("input", { type: "text", placeholder: "Another name", autocomplete: "off" }) as HTMLInputElement;
    const next = h("button", { class: "primary", disabled: true, onclick: tips }, "Continue") as HTMLButtonElement;
    const chips = ROOMS.map((name) => {
      const c = h("button", { class: "ob-chip", onclick: () => choose(name, c) }, name);
      return c;
    });
    const choose = (name: string, c?: HTMLElement) => {
      room = name;
      chips.forEach((x) => x.classList.toggle("on", x === c));
      next.disabled = !room;
    };
    other.oninput = () => choose(other.value.trim());
    page(
      h("p", { class: "ob-step" }, "2 of 3"),
      h("h1", {}, "Which room first?"),
      h("p", { class: "ob-lead" }, "Start with the room you're in."),
      h("div", { class: "ob-chips" }, ...chips),
      other,
      h("div", { class: "ob-actions" }, next),
    );
  }

  function tips() {
    page(
      h("p", { class: "ob-step" }, "3 of 3"),
      h("h1", {}, "Before you scan"),
      h("div", { class: "ob-tips" }, ...TIPS.map(([t, d, a]) => h("div", { class: "ob-tip" }, art(a), h("div", {}, h("b", {}, t), h("p", {}, d))))),
      h("p", { class: "ob-lead small" }, "It takes about a minute. The phone tells you when it has seen enough."),
      h("div", { class: "ob-actions" }, h("button", { class: "primary", onclick: start }, `Scan the ${room.toLowerCase()}`)),
    );
  }

  // Create the home and room (or reuse them), make the room active, then hand over to the scan flow.
  async function start() {
    try {
      const { spaces, active } = await conn.api("/api/spaces");
      let sp = spaces.find((s: any) => s.id === active) ?? spaces[0];
      if (!sp) sp = await conn.api("/api/spaces", "POST", { name: home });
      else if (home && sp.name !== home) await conn.api(`/api/spaces/${sp.id}`, "PATCH", { name: home });
      let r = sp.rooms?.find((x: any) => x.name.toLowerCase() === room.toLowerCase() && !x.scan_id)
        ?? sp.rooms?.find((x: any) => !x.scan_id && /^Room \d+$/.test(x.name));
      if (r && r.name !== room) r = await conn.api(`/api/spaces/${sp.id}/rooms/${r.id}`, "PATCH", { name: room });
      if (!r) r = await conn.api(`/api/spaces/${sp.id}/rooms`, "POST", { name: room });
      await conn.api(`/api/spaces/${sp.id}`, "PATCH", { active: true, active_room: r.id });
      scanRoom(r.id, { prep: false });
    } catch (e: any) {
      toast(`Couldn't start: ${String(e.message ?? e)}`);
    }
  }

  welcome();
  return { el, destroy: () => {} };
}

function macFollow(): { el: HTMLElement; destroy: () => void } {
  const status = h("div", { class: "ob-status" });
  const el = h("div", { class: "ob mac" },
    h("div", { class: "ob-page" },
      h("h1", {}, "Set up Seefy on your phone"),
      h("p", { class: "ob-lead" }, "Scan this code with your phone's camera. Your phone needs to be on the same WiFi as this Mac."),
      h("img", { class: "ob-qr", src: "/api/qr.svg", alt: "QR code that opens Seefy on your phone", width: 220, height: 220 }),
      status,
      h("p", { class: "muted" }, "Scanning happens on the phone. This Mac builds the map and shows it here as you go.")));
  let scan: any = null;

  function render() {
    const phone = (conn.state?.devices ?? []).some((d: any) => d.role === "phone");
    const room = conn.state?.space?.rooms?.find((r: any) => r.id === conn.state?.space?.active_room);
    let line: [string, string];
    if (isSetUp()) line = ["ok", `${room?.name ?? "Your room"} is mapped ✓`];
    else if (scan?.status === "recording") line = ["busy", `Scanning ${room?.name?.toLowerCase() ?? "the room"}…${scan.live?.coverage ? ` ${Math.round(100 * Math.min(1, scan.live.coverage.score))}%` : ""}`];
    else if (scan?.status === "processing" || scan?.status === "queued") line = ["busy", "Building the map…"];
    else if (phone) line = ["ok", "Phone connected ✓ · Follow the steps on your phone"];
    else line = ["wait", "Waiting for your phone…"];
    status.className = `ob-status ${line[0]}`;
    status.replaceChildren(h("span", { class: "dot" }), line[1],
      ...(isSetUp() ? [h("a", { class: "btn primary-sm", href: "#home" }, "Open Home")] : []));
  }

  const offs = [conn.on("state", render), conn.on("scan", (m) => { scan = m; render(); })];
  render();
  return { el, destroy: () => offs.forEach((off) => off()) };
}
