// Settings (docs/UX.md): plain choices first; everything that only matters to builders sits under Advanced.

import { conn } from "./conn";
import { askText, confirmSheet, h, toast } from "./ui";

// resources.py presets. Balanced is the default: half the cores, at low priority.
const PRESETS = [
  { id: "light", label: "Light", about: "About a quarter of the processor, at low priority. The Mac stays quick; maps take longest." },
  { id: "balanced", label: "Balanced", about: "Half the processor, at low priority. Other apps come first." },
  { id: "full", label: "Full", about: "The whole processor. Fastest maps, but the Mac will feel busy while they build." },
];

export function settingsScreen(): { el: HTMLElement; destroy: () => void } {
  const el = h("div", { class: "settings-page" });
  let wifi: any = null;

  const row = (title: string, sub: string | Node | null, action: Node | null, href?: string) =>
    h(href ? "a" : "div", { class: "set-row", ...(href ? { href } : {}) },
      h("div", { class: "set-text" }, h("b", {}, title), sub ? h("span", {}, sub) : null),
      action ?? (href ? h("span", { class: "chev" }, "›") : null));

  function render() {
    const sp = conn.state?.space;
    const phones = (conn.state?.devices ?? []).filter((d: any) => d.role === "phone");
    const taught = wifi?.baseline === "saved";
    el.replaceChildren(
      h("h3", { class: "section-title" }, "Space"),
      h("div", { class: "group list" },
        row("Name", sp?.name ?? "Not set up yet", h("button", { class: "link-btn", onclick: rename, disabled: !sp }, "Rename")),
        row("Map", sp ? "Floor plan, rooms and the scans it's built from" : "None yet", null, "#map")),

      h("h3", { class: "section-title" }, "Movement sensing"),
      h("div", { class: "group list" },
        row("Teach Seefy a still home",
          wifi?.baseline === "recording" ? `Keep still… ${Math.ceil(wifi.calibrate_left_s ?? 0)} s`
            : taught ? "Done. Redo it if movement shows when nobody's there."
            : "Not done yet. Takes 20 seconds with nobody moving.",
          h("button", { class: taught ? "link-btn" : "primary-sm", onclick: teach, disabled: wifi?.baseline === "recording" }, taught ? "Redo" : "Start"))),
      h("p", { class: "footnote" }, "Seefy uses this Mac's own WiFi connection. It notices movement at home; telling rooms apart needs more WiFi devices around the home."),

      h("h3", { class: "section-title" }, "Processing"),
      h("div", { class: "group list" },
        row("How hard this Mac works on maps", PRESETS.find((p) => p.id === preset())?.about ?? "", null),
        h("div", { class: "segmented", role: "radiogroup" }, ...PRESETS.map((p) =>
          h("button", { class: preset() === p.id ? "on" : "", role: "radio", "aria-checked": String(preset() === p.id), onclick: () => setPreset(p.id) }, p.label)))),
      h("p", { class: "footnote" }, "Applies from the next step of a map being built. Pause or stop a build from the Map tab."),

      h("h3", { class: "section-title" }, "Phones"),
      h("div", { class: "group list" },
        row(phones.length ? [...new Set(phones.map((d: any) => d.name))].join(", ") : "No phone connected",
          phones.length ? "Connected" : "Scan the code below with your phone's camera", null),
        h("div", { class: "set-qr" },
          h("img", { src: "/api/qr.svg", alt: "QR code that opens Seefy on a phone", width: 132, height: 132 }),
          h("p", { class: "muted" }, "Same WiFi as this Mac. The first time, the phone asks to trust this computer; follow its steps once."))),

      h("h3", { class: "section-title" }, "Advanced"),
      h("div", { class: "group list" },
        row("Live tracking", "Phone positions, the raw map and the 3D view", null, "#live"),
        row("Diagnostics and tuning", "Devices, timing, recorded passes and every setting", null, "#details"),
        row("Setup with printed tags", "The original guide, for tag-based tracking", null, "#capture"),
        row("Print tags and the lens grid", null, null, "/print.html")),
    );
  }

  const preset = () => conn.config?.processing?.preset ?? "balanced";

  async function setPreset(id: string) {
    try {
      await conn.api("/api/config", "PUT", { processing: { preset: id } });
      conn.config = { ...conn.config, processing: { ...(conn.config?.processing ?? {}), preset: id } };
      render();
    } catch (e: any) {
      toast(String(e.message ?? e));
    }
  }

  async function rename() {
    const sp = conn.state?.space;
    const name = await askText("Rename this space", { value: sp?.name ?? "" });
    if (!sp || !name) return;
    try {
      await conn.api(`/api/spaces/${sp.id}`, "PATCH", { name });
    } catch (e: any) {
      toast(String(e.message ?? e));
    }
  }

  async function teach() {
    if (!(await confirmSheet("Teach Seefy a still home", "For 20 seconds nobody should move. Leave the room if you can.", "Start"))) return;
    try {
      await conn.api("/api/wifi/baseline", "POST", { seconds: 20 });
    } catch (e: any) {
      toast(`Couldn't start: ${String(e.message ?? e)}`);
    }
  }

  let lastBaseline = "";
  const offs = [
    conn.on("state", render),
    conn.on("config", render),
    conn.on("wifi", (m) => {
      wifi = m;
      const key = `${m.baseline}:${m.baseline === "recording" ? Math.ceil(m.calibrate_left_s ?? 0) : ""}`;
      if (key !== lastBaseline) {
        lastBaseline = key;
        render();
      }
    }),
  ];
  conn.api("/api/wifi").then((r: any) => { wifi ??= r; render(); }).catch(() => {});
  render();
  return { el, destroy: () => offs.forEach((off) => off()) };
}
