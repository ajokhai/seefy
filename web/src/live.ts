// Live screen: floor map with tags and tracked phones.

import { conn } from "./conn";
import { MapView } from "./mapview";
import { View3D } from "./view3d";
import { wifiCard } from "./wifi";
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
  const wifi = wifiCard();
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
  let liveScan: { id: string; status: string; live?: any; stage?: string; progress?: number; error?: string } | null = null;
  let liveFetch = 0;
  const showPartial = async (id: string) => {
    if (Date.now() - liveFetch < 1500) return; // at most every 1.5 s
    liveFetch = Date.now();
    try {
      const partial = await conn.api(`/api/scans/${id}/live`);
      if (partial?.points?.length) {
        view.setScan(partial);
        view3d?.setScan(partial, true);
      }
    } catch {
      /* not ready */
    }
  };
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

  function scanCard() {
    const ls = liveScan;
    if (!ls) return null;
    const live = ls.live;
    const cov = live?.coverage && !live.coverage.error ? live.coverage : null;
    const enoughAt = conn.config?.coverage?.enough ?? 0.7;
    const words: Record<string, string> = { short: "Keep scanning", enough: "Enough ✓", extra: "Extra sure ✓✓" };
    const stages: Record<string, string> = { features: "Finding features", matching: "Matching frames", mapping: "Placing frames", aligning: "Finding floor and scale" };
    const title = ls.status === "recording" ? "Scanning now" : ls.status === "done" ? "Scan finished" : ls.status === "failed" ? "Scan failed" : "Building the map";
    return h("section", { class: "side-card scan-card" },
      h("div", { class: "side-head" }, h("h3", {}, title),
        cov ? h("span", { class: `scan-level ${cov.level}` }, words[cov.level] ?? cov.level) : null),
      cov ? h("div", { class: "scan-bar" },
        h("div", { class: "fill", style: `width:${Math.round(100 * Math.min(1, cov.score))}%` }),
        h("div", { class: "enough-marker", style: `left:${Math.round(100 * enoughAt)}%` })) : null,
      live ? h("p", { class: "muted" }, `${live.registered} of ${live.frames} frames placed` +
        (live.room_size_m?.length ? ` · ${fmt(live.room_size_m[0], 1)} × ${fmt(live.room_size_m[1], 1)} m so far` : "")) : null,
      ls.status === "processing" ? h("p", { class: "muted" }, `${stages[ls.stage ?? ""] ?? "Working"}… ${Math.round(100 * (ls.progress ?? 0))}%`) : null,
      ls.status === "failed" ? h("p", { class: "bad" }, ls.error ?? "") : null,
      cov ? h("dl", { class: "scan-components" },
        ...Object.entries<any>(cov.components ?? {}).flatMap(([name, c]) => [
          h("dt", {}, c.label ?? name),
          h("dd", {}, h("span", { class: "comp-bar" }, h("span", { style: `width:${Math.round(100 * (c.value ?? 0))}%` })), " ", c.detail ?? ""),
        ])) : null,
      cov?.hints?.length ? h("p", { class: "scan-hint" }, cov.hints[0]) : null,
    );
  }

  function renderSide() {
    const st = conn.state;
    const phones = (st?.devices ?? []).filter((d: any) => d.role === "phone");
    const tm = st?.tagmap;
    const scanned = !!scanInfo?.points?.length;
    const lay = scanInfo?.layout;
    side.replaceChildren(
      ...(st?.session ? [h("section", { class: "side-card rec-card" },
        h("div", { class: "side-head" }, h("h3", {}, "Recording"), h("span", { class: "rec" }, "●")),
        h("div", { class: "big-num" }, `${fmt(st.session.duration_s, 0)} s`),
        h("p", { class: "muted" }, `${st.session.kind} pass ${st.session.pass}`))] : []),
      ...[scanCard()].filter((x): x is HTMLElement => !!x),
      h("section", { class: "side-card" },
        h("div", { class: "side-head" }, h("h3", {}, "Room"),
          h("span", { class: `badge ${scanned ? "ok" : "off"}` }, scanned ? "Scanned" : "Not scanned")),
        ...(scanned
          ? [h("dl", { class: "stats" },
              h("dt", {}, "Size"), h("dd", {}, lay?.ok ? `${fmt(lay.size_m?.[0], 1)} × ${fmt(lay.size_m?.[1], 1)} m` :
                `${fmt(scanInfo.room_size_m?.[0], 1)} × ${fmt(scanInfo.room_size_m?.[1], 1)} m`),
              h("dt", {}, "Frames placed"), h("dd", {}, `${scanInfo.registered} / ${scanInfo.total}`),
              h("dt", {}, "Fit"), h("dd", {}, scanInfo.reproj_err_px != null ? `${fmt(scanInfo.reproj_err_px, 2)} px` : "–"),
              h("dt", {}, "Scale"), h("dd", {}, scanInfo.scale_method),
              ...(lay?.ok ? [h("dt", {}, "Walls"), h("dd", {}, `${lay.walls?.length ?? 0} · ${lay.walls?.reduce((n: number, w: any) => n + (w.openings?.length ?? 0), 0)} openings · ${lay.objects?.length ?? 0} objects (${lay.confidence})`)] : [])),
            lay && !lay.ok ? h("p", { class: "muted" }, lay.reason ?? "") : h("p", { class: "muted" }, "Dots are fixed features seen from above; the dashed line is the path you walked.")]
          : [h("p", { class: "muted" }, "On your phone, open Guide and scan the room.")])),
      h("section", { class: "side-card" },
        h("div", { class: "side-head" }, h("h3", {}, "Phones"), h("span", { class: "badge off" }, String(phones.length))),
        ...(phones.length
          ? phones.map((d: any) => h("div", { class: "device-row" },
              h("span", { class: `dot ${d.status?.tracking ? "on" : ""}` }),
              h("div", {}, h("b", {}, d.name), h("div", { class: "muted" }, d.status?.tracking ? "Tracking" : d.mode)),
              h("div", { class: "device-metrics" }, `${fmt(d.rates?.pose ?? 0, 0)} poses/s`, h("br"), `sync ±${fmt(d.sync?.err_ms, 1)} ms`)))
          : [h("p", { class: "muted" }, "No phone connected. Open this page on your phone and follow the Guide.")])),
      wifi.el,
      ...(tm && tm.tags ? [h("p", { class: "muted" }, `Tag map: ${tm.tags} tags · ${tm.frames} frames${tm.solving ? " · solving…" : ""}`)] : []),
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
      const prev = liveScan?.id === m.id ? liveScan : null;
      liveScan = { ...(prev ?? {}), ...m, live: m.live ?? prev?.live };
      if (m.status === "recording" && m.live) showPartial(m.id);
      if (m.status === "done") loadScan();
      renderSide();
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
      wifi.destroy();
    },
  };
}
