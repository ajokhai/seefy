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
window.addEventListener("hashchange", route);
conn.connect();
