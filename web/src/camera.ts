// Full-screen camera with floating controls (close, status, hint, shutter), in the style of
// camera apps like Snapchat. Used by both the markerless scan and tag tracking.

import "./camera.css";
import { h } from "./ui";

export interface CameraSheet {
  el: HTMLElement;
  video: HTMLVideoElement;
  overlay: HTMLCanvasElement;
  setStatus(text: string, tone?: "rec" | "ok" | "warn" | ""): void;
  setHint(text: string): void;
  setShutter(state: "idle" | "recording" | "busy" | "hidden"): void;
  setCorner(content: HTMLElement | null): void;
  /** Coverage bar: fill 0..1, a marker where "enough" is, and a label. Hidden when fill is null. */
  setProgress(fill: number | null, enoughAt: number, label: string, level?: "short" | "enough" | "extra"): void;
  /** Turn-speed meter: current speed as a fraction of the limit (1 = at the limit). */
  setMeter(frac: number | null, label?: string): void;
  close(): void;
}

export function openCameraSheet(opts: { onShutter?: () => void; onClose?: () => void; shutterLabel?: string }): CameraSheet {
  const video = h("video", { playsinline: true, muted: true, autoplay: true });
  const overlay = h("canvas", { class: "cam-overlay" });
  const status = h("div", { class: "cam-status" });
  const hint = h("div", { class: "cam-hint" });
  const corner = h("div", { class: "cam-corner" });
  const progFill = h("div", { class: "cam-prog-fill" });
  const progMark = h("div", { class: "cam-prog-mark" });
  const progLabel = h("div", { class: "cam-prog-label" });
  const prog = h("div", { class: "cam-prog" }, h("div", { class: "cam-prog-track" }, progFill, progMark), progLabel);
  const meterFill = h("div", { class: "cam-meter-fill" });
  const meterLabel = h("span", { class: "cam-meter-label" });
  const meter = h("div", { class: "cam-meter" }, h("div", { class: "cam-meter-track" }, meterFill, h("div", { class: "cam-meter-limit" })), meterLabel);
  const shutter = h("button", { class: "cam-shutter", "aria-label": opts.shutterLabel ?? "Record" }, h("span"));
  const closeBtn = h("button", { class: "cam-close", "aria-label": "Close camera" }, "✕");

  const el = h("div", { class: "cam-sheet" },
    video, overlay,
    h("div", { class: "cam-top" }, closeBtn, h("div", { class: "cam-top-mid" }, status, meter), h("span", { class: "cam-spacer" })),
    h("div", { class: "cam-bottom" }, prog, hint, h("div", { class: "cam-controls" }, corner, shutter, h("span", { class: "cam-spacer" }))),
  );
  document.body.append(el);
  document.body.classList.add("cam-open");

  let closed = false;
  const sheet: CameraSheet = {
    el, video, overlay,
    setStatus(text, tone = "") {
      status.textContent = text;
      status.className = `cam-status ${tone}`;
      status.hidden = !text;
    },
    setHint(text) {
      hint.textContent = text;
      hint.hidden = !text;
    },
    setShutter(state) {
      shutter.className = `cam-shutter ${state}`;
      shutter.hidden = state === "hidden";
      shutter.disabled = state === "busy";
    },
    setCorner(content) {
      corner.replaceChildren(...(content ? [content] : []));
    },
    setProgress(fill, enoughAt, label, level = "short") {
      prog.hidden = fill == null;
      if (fill == null) return;
      progFill.style.width = `${Math.round(Math.min(1, Math.max(0, fill)) * 100)}%`;
      progMark.style.left = `${Math.round(enoughAt * 100)}%`;
      progLabel.textContent = label;
      prog.className = `cam-prog ${level}`;
    },
    setMeter(frac, label = "") {
      meter.hidden = frac == null;
      if (frac == null) return;
      // The limit sits at 50% of the track, so up to twice the limit is visible.
      meterFill.style.width = `${Math.round(Math.min(1, frac / 2) * 100)}%`;
      meter.className = `cam-meter ${frac > 2 ? "bad" : frac > 1 ? "warn" : "ok"}`;
      meterLabel.textContent = label;
    },
    close() {
      if (closed) return;
      closed = true;
      el.remove();
      document.body.classList.remove("cam-open");
    },
  };
  shutter.onclick = () => opts.onShutter?.();
  closeBtn.onclick = () => {
    opts.onClose?.();
    sheet.close();
  };
  sheet.setStatus("");
  sheet.setHint("");
  sheet.setProgress(null, 0.7, "");
  sheet.setMeter(null);
  sheet.setShutter(opts.onShutter ? "idle" : "hidden");
  return sheet;
}

/** Ask for motion-sensor access. iOS requires this to be called directly from a tap. */
export function requestMotionPermission(): Promise<boolean> {
  const DME = (window as any).DeviceMotionEvent;
  if (DME && typeof DME.requestPermission === "function") {
    return DME.requestPermission().then((r: string) => r === "granted").catch(() => false);
  }
  return Promise.resolve(typeof DME !== "undefined");
}
