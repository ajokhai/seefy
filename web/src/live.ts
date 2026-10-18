// Live screen: floor map with tags and tracked phones.

import { conn } from "./conn";
import { MapView } from "./mapview";
import { View3D } from "./view3d";
import { fmt, h } from "./ui";

export function liveScreen(): { el: HTMLElement; destroy: () => void } {
  const canvas = h("canvas", { class: "map" });
  const box3d = h("div", { class: "map map3d", hidden: true });
  const side = h("div", { class: "side" });
  const btnPlan = h("button", { class: "seg on" }, "Blueprint");
  const btn3d = h("button", { class: "seg" }, "3D");
  const stage = h("div", { class: "stage" }, h("div", { class: "segs floating" }, btnPlan, btn3d), canvas, box3d);
  const el = h("div", { class: "live" }, stage, side);
  const view = new MapView(canvas);
  let view3d: View3D | null = null;
  const setMode = (m: "plan" | "3d") => {
    btnPlan.classList.toggle("on", m === "plan");
    btn3d.classList.toggle("on", m === "3d");
    canvas.hidden = m !== "plan";
    box3d.hidden = m !== "3d";
    if (m === "3d" && !view3d) {
      view3d = new View3D(box3d);
      view3d.setScan(scanInfo);
    }
    try {
      localStorage.setItem("seefy.live.view", m);
    } catch {
      /* fine */
    }
  };
  btnPlan.onclick = () => setMode("plan");
  btn3d.onclick = () => setMode("3d");
  view.setTagmap(conn.tagmap);
  let scanInfo: any = null;
  const loadScan = async () => {
    try {
      scanInfo = await conn.api("/api/scans/latest");
      view.setScan(scanInfo);
      view3d?.setScan(scanInfo);
      renderSide();
    } catch {
      /* no scan yet */
    }
  };

  const names = () => new Map((conn.state?.devices ?? []).map((d: any) => [d.id, d.name]));

  function renderSide() {
    const st = conn.state;
    const phones = (st?.devices ?? []).filter((d: any) => d.role === "phone");
    const tm = st?.tagmap;
    side.replaceChildren(
      h("h3", {}, "Room"),
      scanInfo?.points?.length
        ? h("p", {}, `Scanned: ${scanInfo.registered} of ${scanInfo.total} frames mapped, about ` +
            `${fmt(scanInfo.room_size_m?.[0], 1)} × ${fmt(scanInfo.room_size_m?.[1], 1)} m. ` +
            `Dots are the room's fixed features seen from above; the dashed line is the path you walked.`,
            h("div", { class: "muted" }, `Scale: ${scanInfo.scale_method}`))
        : h("p", { class: "muted" }, "No room scan yet. On your phone, open Guide and scan the room."),
      h("h3", {}, "Movement"),
      h("p", { class: "muted" }, "WiFi sensing arrives with signal capture (Phase 3)."),
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
        : [h("p", { class: "muted" }, "No phone connected. Open this page on your phone and follow the Guide.")]),
      h("div", { class: "muted" },
        tm ? `Tag map: ${tm.tags} tags · ${tm.frames} frames · ${tm.passes} pass(es)${tm.solving ? " · solving…" : ""}` : ""),
      h("button", { onclick: () => view.clearTrails() }, "Clear trails"),
    );
  }

  const offs = [
    conn.on("pose", (m) => {
      view.addPose(m.device, String(names().get(m.device) ?? "phone"), m);
      view3d?.setPerson(m.device, m.body[0], m.body[1]);
    }),
    conn.on("tagmap", (m) => view.setTagmap(m.tagmap)),
    conn.on("welcome", (m) => view.setTagmap(m.tagmap)),
    conn.on("state", renderSide),
    conn.on("scan", (m) => {
      if (m.status === "done") loadScan();
    }),
  ];
  renderSide();
  loadScan();
  let saved = "plan";
  try {
    saved = localStorage.getItem("seefy.live.view") ?? "plan";
  } catch {
    /* fine */
  }
  setMode(saved === "3d" ? "3d" : "plan");

  return {
    el,
    destroy: () => {
      offs.forEach((off) => off());
      view.destroy();
      view3d?.destroy();
    },
  };
}
