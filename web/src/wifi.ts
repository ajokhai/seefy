// WiFi movement card (Live side panel, Home): the laptop's own WiFi signal strength, a big
// Moving / Still state, the motion score, and a button to record the still-room reference.
// The server sends a {type: "wifi"} message about 5 times a second; see server/seefy/wifi/live.py.

import { conn } from "./conn";
import { fmt, h, toast } from "./ui";
import "./wifi.css";

const SPAN_MS = 60_000; // sparkline width
const strength = (dbm: number) => (dbm >= -60 ? "Strong" : dbm >= -72 ? "Good" : dbm >= -80 ? "Weak" : "Very weak");

export function wifiCard(): { el: HTMLElement; destroy: () => void } {
  const badge = h("span", { class: "badge off" }, "Waiting");
  const state = h("div", { class: "wifi-state" }, "–");
  const spark = h("canvas", { class: "wifi-spark" });
  const stats = h("dl", { class: "stats" });
  const note = h("p", { class: "muted" });
  const btn = h("button", { class: "wifi-calibrate" }, "Calibrate still room");
  const el = h("section", { class: "side-card wifi-card" },
    h("div", { class: "side-head" }, h("h3", {}, "Movement"), badge), state, spark, stats, note, btn);

  let series: { t: number; rssi: number | null; score: number | null }[] = [];
  let last: any = null;

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await conn.api("/api/wifi/baseline", "POST", { seconds: 20 });
    } catch (e: any) {
      toast(`Couldn't calibrate: ${String(e.message ?? e).replace(/^.*?: \d+ /, "")}`);
      btn.disabled = false;
    }
  };

  function draw() {
    const w = spark.clientWidth;
    const hgt = spark.clientHeight;
    if (!w || !hgt) return;
    const dpr = window.devicePixelRatio || 1;
    spark.width = Math.round(w * dpr);
    spark.height = Math.round(hgt * dpr);
    const ctx = spark.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(el);
    const pts = series.filter((s) => s.rssi != null);
    if (pts.length < 2) return;
    const t1 = pts[pts.length - 1].t;
    const t0 = t1 - SPAN_MS;
    const vals = pts.map((s) => s.rssi!);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi - lo < 4) [lo, hi] = [(lo + hi) / 2 - 2, (lo + hi) / 2 + 2]; // at least 4 dB tall, so 1 dB ticks look small
    const x = (t: number) => ((t - t0) / SPAN_MS) * w;
    const y = (v: number) => hgt - 3 - ((v - lo) / (hi - lo)) * (hgt - 6);
    // Shade the stretches the server called movement.
    ctx.fillStyle = css.getPropertyValue("--wifi-moving-fill");
    const threshold = conn.config?.wifi?.moving_ratio ?? 2;
    for (let i = 1; i < pts.length; i++) {
      if ((pts[i].score ?? 0) >= threshold) ctx.fillRect(x(pts[i - 1].t), 0, x(pts[i].t) - x(pts[i - 1].t) + 0.5, hgt);
    }
    ctx.strokeStyle = css.getPropertyValue("--accent");
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach((s, i) => (i ? ctx.lineTo(x(s.t), y(s.rssi!)) : ctx.moveTo(x(s.t), y(s.rssi!))));
    ctx.stroke();
    ctx.fillStyle = css.getPropertyValue("--muted");
    ctx.font = "11px -apple-system, system-ui, sans-serif";
    ctx.fillText(`${hi.toFixed(0)} dBm`, 4, 12);
    ctx.fillText(`${lo.toFixed(0)}`, 4, hgt - 4);
  }

  function render() {
    const m = last;
    const calibrating = m?.baseline === "recording";
    const learning = m?.baseline === "learning";
    const live = m && m.rssi != null && !m.error;
    el.classList.toggle("moving", !!(live && m.moving));
    el.classList.toggle("still", !!(live && !m.moving && !learning && !calibrating));
    badge.className = `badge ${live ? "ok" : "off"}`;
    badge.textContent = live ? "Live" : m?.error ? "Off" : "Waiting";
    state.textContent = !m ? "–" : m.error && !live ? "Not available" : calibrating
      ? `Calibrating… ${Math.ceil(m.calibrate_left_s)} s` : learning ? "Learning the room…" : m.moving ? "Moving" : "Still";
    stats.replaceChildren(
      h("dt", {}, "WiFi strength"), h("dd", {}, live ? `${strength(m.rssi)} (${fmt(m.rssi, 0)} dBm)` : "–"),
      h("dt", {}, "Movement"), h("dd", {}, m?.score != null ? `${fmt(m.score, 1)}× a still room` : "–"),
      h("dt", {}, "Readings"), h("dd", {}, live ? `${fmt(m.rate_hz, 0)} a second` : "–"),
    );
    note.textContent = m?.error && !live ? m.error
      : calibrating ? "Keep everyone still, or leave the room, until this finishes."
      : m?.baseline === "saved" ? "Walk between this laptop and the router to see it react."
      : "Not calibrated yet: it's guessing the room was still when the server started. Press Calibrate with nobody moving.";
    note.className = m?.error && !live ? "bad" : "muted";
    btn.disabled = !live || calibrating;
    btn.textContent = m?.baseline === "saved" ? "Recalibrate still room" : "Calibrate still room";
  }

  const add = (m: any) => {
    last = m;
    series.push({ t: m.t, rssi: m.rssi, score: m.score });
    const cut = m.t - SPAN_MS;
    if (series.length && series[0].t < cut) series = series.filter((s) => s.t >= cut);
    render();
  };

  let frame = 0;
  const off = conn.on("wifi", (m) => {
    add(m);
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  });
  const ro = new ResizeObserver(draw);
  ro.observe(spark);

  // Fill the sparkline with the last minute so it isn't empty on open.
  conn.api("/api/wifi").then((r) => {
    series = (r.history ?? []).map(([t, rssi, score]: number[]) => ({ t, rssi, score }));
    if (!last) last = r;
    render();
    draw();
  }).catch(() => {
    /* older server without WiFi */
  });
  render();

  return {
    el,
    destroy: () => {
      off();
      ro.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}
