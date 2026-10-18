// Live screen: floor map with tags and tracked phones.

import { conn } from "./conn";
import { MapView } from "./mapview";
import { fmt, h } from "./ui";

export function liveScreen(): { el: HTMLElement; destroy: () => void } {
  const canvas = h("canvas", { class: "map" });
  const side = h("div", { class: "side" });
  const el = h("div", { class: "live" }, canvas, side);
  const view = new MapView(canvas);
  view.setTagmap(conn.tagmap);

  const names = () => new Map((conn.state?.devices ?? []).map((d: any) => [d.id, d.name]));

  function renderSide() {
    const st = conn.state;
    const phones = (st?.devices ?? []).filter((d: any) => d.role === "phone");
    const tm = st?.tagmap;
    side.replaceChildren(
      h("h3", {}, "Movement"),
      h("p", { class: "muted" },
        "Phase 1 shows phone tracking only. WiFi sensing arrives with signal capture (Phase 3)."),
      ...(st?.session
        ? [h("p", { class: "rec" }, `● Recording ${st.session.kind} pass ${st.session.pass} · ${fmt(st.session.duration_s, 0)} s`)]
        : []),
      ...(phones.length
        ? phones.map((d: any) =>
            h("div", { class: "card small" },
              h("b", {}, d.name), " ",
              h("span", { class: "muted" }, d.status?.tracking ? "tracking" : d.mode),
              h("div", { class: "muted" },
                `camera→host ${fmt(d.capture_latency_ms, 0, " ms")} · sync ±${fmt(d.sync?.err_ms, 1, " ms")} · ${fmt(d.rates?.pose, 0)} poses/s`),
            ))
        : [h("p", { class: "muted" }, "No phone connected. Open this page on your phone and go to Learn.")]),
      h("div", { class: "muted" },
        tm ? `Tag map: ${tm.tags} tags · ${tm.frames} frames · ${tm.passes} pass(es)${tm.solving ? " · solving…" : ""}` : ""),
      h("button", { onclick: () => view.clearTrails() }, "Clear trails"),
    );
  }

  const offs = [
    conn.on("pose", (m) => view.addPose(m.device, String(names().get(m.device) ?? "phone"), m)),
    conn.on("tagmap", (m) => view.setTagmap(m.tagmap)),
    conn.on("welcome", (m) => view.setTagmap(m.tagmap)),
    conn.on("state", renderSide),
  ];
  renderSide();

  return {
    el,
    destroy: () => {
      offs.forEach((off) => off());
      view.destroy();
    },
  };
}
