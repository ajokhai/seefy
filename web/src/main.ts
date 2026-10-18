import "./style.css";
import { conn, isTouch } from "./conn";
import { learnScreen } from "./learn";
import { liveScreen } from "./live";
import { sensorsScreen } from "./sensors";
import { h } from "./ui";

const screens = { live: liveScreen, learn: learnScreen, sensors: sensorsScreen } as const;
type Name = keyof typeof screens;

const main = h("main");
const connDot = h("span", { class: "dot" });
const tabs = (Object.keys(screens) as Name[]).map((name) =>
  h("a", { href: `#${name}`, class: "tab" }, name[0].toUpperCase() + name.slice(1)),
);
document.body.append(h("header", {}, h("span", { class: "logo" }, "seefy"), h("nav", {}, ...tabs), connDot), main);

let current: { destroy: () => void } | null = null;

function route(): void {
  const name = (location.hash.slice(1) || (isTouch ? "learn" : "live")) as Name;
  const make = screens[name] ?? screens.live;
  current?.destroy();
  const s = make();
  current = s;
  main.replaceChildren(s.el);
  tabs.forEach((t) => t.classList.toggle("on", t.getAttribute("href") === `#${name}`));
}

conn.on("open", () => connDot.classList.add("on"));
conn.on("close", () => connDot.classList.remove("on"));
// Screens read conn state when built, so build the first one once the host has said hello.
let first = true;
conn.on("welcome", () => {
  if (first) {
    first = false;
    route();
  }
});

// If the live connection never opens, the usual cause is an untrusted certificate: iOS Safari lets the
// page load after "visit this website" but still blocks its WebSocket. Explain how to fix it.
setTimeout(() => {
  if (!first) return;
  const helper = `http://${location.hostname}:8080`;
  main.replaceChildren(
    h("section", { class: "card" },
      h("h3", {}, "Can't open the live connection to Seefy"),
      h("p", {}, "This page loaded, but the browser is blocking its live connection to the Seefy server. " +
        "On iPhone this happens until the phone trusts this computer's certificate. It takes a minute, once:"),
      h("ol", {},
        h("li", {}, "Open ", h("a", { href: `${helper}/ca.crt` }, `${helper}/ca.crt`), " in Safari and tap Allow."),
        h("li", {}, "Settings → Profile Downloaded → Install."),
        h("li", {}, "Settings → General → About → Certificate Trust Settings → turn on “Seefy local CA”."),
        h("li", {}, "Come back and reload this page.")),
      h("p", { class: "muted" }, `Instructions with links: ${helper}. If this is a computer, check that the Seefy server is still running.`)),
  );
}, 5000);
window.addEventListener("hashchange", route);
conn.connect();
