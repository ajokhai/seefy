// First run (docs/UX.md): one screen, one button at a time.
// Phone: welcome → name the space → before-you-scan tips → the scan flow → map more of it?
// Mac: "set up Seefy on your phone" with a QR code, then follows the phone along until the space is mapped.

import { conn, isTouch } from "./conn";
import { startScan, type ScanOutcome } from "./scanflow";
import { h, toast } from "./ui";

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
const KINDS = ["Home", "Flat", "Office", "Studio"];

/** Scan on this phone into the active space (extending its map). Resolves when the scan flow closes. */
export function scanSpace(opts: { prep?: boolean; resume?: string } = {}): Promise<ScanOutcome> {
  const sp = conn.state?.space;
  return startScan({ skipPrep: opts.prep === false, resumeScanId: opts.resume, ...(sp ? { spaceId: sp.id } : {}) } as any);
}

/** True when the active space has a map: then the app opens on Home instead of setup. */
export function isSetUp(): boolean {
  const sp = conn.state?.space;
  return !!(sp?.scans || sp?.rooms?.some((r: any) => r.scan_id));
}

export function onboardingScreen(): { el: HTMLElement; destroy: () => void } {
  return isTouch ? phoneFlow() : macFollow();
}

function phoneFlow(): { el: HTMLElement; destroy: () => void } {
  const el = h("div", { class: "ob" });
  let name = conn.state?.space?.name ?? "";
  const STEPS = 3;

  // One full screen per step: progress bar on top, content, sticky footer with Back and the main action.
  const page = (step: number, back: (() => void) | null, main: HTMLElement | null, ...kids: (Node | string | null)[]) => {
    el.replaceChildren(...([
      step ? h("div", { class: "ob-progress" }, h("div", { style: `width:${(100 * step) / STEPS}%` })) : null,
      h("div", { class: "ob-page" }, ...kids),
      h("div", { class: "ob-foot" },
        back ? h("button", { class: "link-btn ob-back", onclick: back }, "Back") : h("span"),
        main ?? h("span")),
    ].filter(Boolean) as Node[]));
    window.scrollTo(0, 0);
  };

  function welcome() {
    page(0, null, h("button", { class: "primary", onclick: nameSpace }, "Get started"),
      h("div", { class: "ob-hero" }, h("span", { class: "brand-mark big" })),
      h("h1", {}, "Welcome to Seefy"),
      h("p", { class: "ob-lead" }, "Map your space once with this phone. Then Seefy senses movement using your WiFi, with no cameras left on."));
  }

  function nameSpace() {
    const input = h("input", { type: "text", value: name, placeholder: "My home", autocomplete: "off" }) as HTMLInputElement;
    const chips = KINDS.map((k) => h("button", { class: "ob-chip", onclick: () => { input.value = k; sync(); } }, k));
    const sync = () => chips.forEach((c) => c.classList.toggle("on", c.textContent === input.value.trim()));
    input.oninput = sync;
    page(1, welcome, h("button", { class: "primary", onclick: () => { name = input.value.trim() || "My home"; tips(); } }, "Next"),
      h("h1", {}, "What are you mapping?"),
      h("p", { class: "ob-lead" }, "Give this place a name. A separate place, like your office, can be mapped later as its own space."),
      h("div", { class: "ob-chips" }, ...chips), input);
    sync();
  }

  function tips() {
    page(2, nameSpace, h("button", { class: "primary", onclick: start }, "Start scanning"),
      h("h1", {}, "Before you scan"),
      h("div", { class: "ob-tips" }, ...TIPS.map(([t, d, a]) => h("div", { class: "ob-tip" }, art(a), h("div", {}, h("b", {}, t), h("p", {}, d))))),
      h("p", { class: "ob-lead small" }, "Start with one room. You can extend the map into the rest of the space afterwards."));
  }

  async function start() {
    try {
      const { spaces, active } = await conn.api("/api/spaces");
      let sp = spaces.find((s: any) => s.id === active) ?? spaces[0];
      if (!sp) sp = await conn.api("/api/spaces", "POST", { name });
      else if (name && sp.name !== name) await conn.api(`/api/spaces/${sp.id}`, "PATCH", { name });
      if (sp.id !== active) await conn.api(`/api/spaces/${sp.id}`, "PATCH", { active: true });
    } catch (e: any) {
      toast(`Couldn't start: ${String(e.message ?? e)}`);
      return;
    }
    const out = await scanSpace({ prep: false });
    if (out.action === "saved") more();
  }

  function more() {
    page(3, null, h("button", { class: "primary", onclick: () => (location.hash = "#home") }, "Done"),
      h("div", { class: "ob-hero" }, h("span", { class: "ob-done" }, "✓")),
      h("h1", {}, "Your first area is mapped"),
      h("p", { class: "ob-lead" }, "To map more of this space, start somewhere you've already scanned and walk into the new area. Seefy joins it to your map."),
      h("button", { class: "ob-secondary", onclick: async () => { const o = await scanSpace({ prep: false }); if (o.action === "saved") more(); } }, "Extend the map"));
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
    const name = conn.state?.space?.name;
    let line: [string, string];
    if (isSetUp()) line = ["ok", `${name ?? "Your space"} is mapped ✓`];
    else if (scan?.status === "recording") line = ["busy", `Scanning…${scan.live?.coverage ? ` ${Math.round(100 * Math.min(1, scan.live.coverage.score))}%` : ""}`];
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
