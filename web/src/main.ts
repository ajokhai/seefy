import "./style.css";
import { conn } from "./conn";
import { guideScreen } from "./guide";
import { homeScreen } from "./home";
import { inspectScreen } from "./inspect";
import { liveScreen } from "./live";
import { mapScreen } from "./map";
import { isSetUp, onboardingScreen } from "./onboarding";
import { sensorsScreen } from "./sensors";
import { settingsScreen } from "./settings";
import { h } from "./ui";

// Simple line icons in the style of SF Symbols, drawn inline so nothing loads from outside.
const icon = (path: string) => {
  const span = h("span", { class: "icon" });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  return span;
};

const HOME = '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>';
const MAP = '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h9M12 3v18M12 16h9"/>';
const GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>';

// Home, Rooms and Settings are the app (docs/UX.md). The rest is reached from inside it:
// setup on first run, the scan flow, the accuracy check from a room, and Advanced screens from Settings.
const screens = {
  home: { title: "Home", make: homeScreen, icon: HOME, tab: true },
  map: { title: "Map", make: mapScreen, icon: MAP, tab: true },
  settings: { title: "Settings", make: settingsScreen, icon: GEAR, tab: true },
  setup: { title: "", make: onboardingScreen, icon: "", tab: false },
  capture: { title: "Scan a room", make: guideScreen, icon: "", tab: false },
  scan: { title: "Check accuracy", make: inspectScreen, icon: "", tab: false },
  live: { title: "Live tracking", make: liveScreen, icon: "", tab: false },
  details: { title: "Diagnostics", make: sensorsScreen, icon: "", tab: false },
} as const;
type Name = keyof typeof screens;
const aliases: Record<string, Name> = { guide: "capture", learn: "capture", sensors: "details", rooms: "map" };
// Where each hidden screen belongs in the navigation.
const parent: Partial<Record<Name, Name>> = { scan: "map", capture: "settings", live: "settings", details: "settings" };

const title = h("h1", { class: "large-title" });
const connDot = h("span", { class: "dot", title: "Connection to the Seefy server" });
const main = h("main");
// On desktop the sidebar says what the dot means: connected or not, and who else is here.
const statusText = h("b", {}, "Connecting…");
const statusSub = h("span", {}, "");
const status = h("div", { class: "status" }, h("span", { class: "dot" }), h("div", {}, statusText, statusSub));
const tabs = (Object.keys(screens) as Name[]).filter((name) => screens[name].tab).map((name) =>
  h("a", { href: `#${name}`, class: "tab" }, icon(screens[name].icon), h("span", {}, screens[name].title)),
);
document.body.append(
  h("header", { class: "nav-bar" }, h("div", { class: "title-row" }, title, connDot)),
  main,
  h("nav", { class: "tab-bar" },
    h("div", { class: "brand" }, h("span", { class: "brand-mark" }), "seefy"), ...tabs, status),
);

let current: { destroy: () => void } | null = null;

function route(): void {
  const raw = location.hash.slice(1).split("/")[0]; // "#scan/<scan id>" opens that scan
  // Until a room is mapped, everything starts at setup.
  const name: Name = (aliases[raw] ?? (raw in screens ? raw : isSetUp() ? "home" : "setup")) as Name;
  current?.destroy();
  const s = screens[name].make();
  current = s;
  title.textContent = name === "home" ? conn.state?.space?.name ?? "Home" : screens[name].title;
  main.replaceChildren(s.el);
  document.body.dataset.screen = name;
  const tab = parent[name] ?? name;
  tabs.forEach((t) => t.classList.toggle("on", t.getAttribute("href") === `#${tab}`));
}

const setOnline = (on: boolean) => {
  connDot.classList.toggle("on", on);
  status.classList.toggle("on", on);
  statusText.textContent = on ? "Connected" : "Offline";
  if (!on) statusSub.textContent = "Reconnecting to the server";
};
conn.on("open", () => setOnline(true));
conn.on("close", () => setOnline(false));
conn.on("state", (m) => {
  const ds: any[] = m.devices ?? [];
  const phones = ds.filter((d) => d.role === "phone").length;
  statusSub.textContent = phones ? `${phones} phone${phones > 1 ? "s" : ""} connected` : "No phone yet";
});
// Screens read conn state when built, so build the first one once the host has said hello.
let first = true;
conn.on("welcome", () => {
  if (first) {
    first = false;
    route();
  }
});
window.addEventListener("hashchange", () => {
  if (!first) route();
});

// If the live connection never opens, the usual cause is an untrusted certificate: iOS Safari lets the
// page load after "visit this website" but still blocks its WebSocket. Explain how to fix it.
setTimeout(() => {
  if (!first) return;
  const helper = `http://${location.hostname}:8080`;
  title.textContent = "Trust this computer";
  main.replaceChildren(
    h("div", { class: "group" },
      h("div", { class: "cell" },
        h("p", {}, "This page loaded, but your browser is blocking its live connection to the Seefy server. " +
          "On iPhone this happens until the phone trusts this computer. It takes a minute, once:"),
        h("ol", {},
          h("li", {}, "Open ", h("a", { href: `${helper}/ca.crt` }, "this certificate"), " and tap Allow."),
          h("li", {}, "Settings → Profile Downloaded → Install."),
          h("li", {}, "Settings → General → About → Certificate Trust Settings → turn on “Seefy local CA”."),
          h("li", {}, "Come back and reload this page.")))),
    h("p", { class: "footnote" }, `On a computer, check that the Seefy server is still running. Help page: ${helper}`),
  );
}, 5000);
conn.connect();
