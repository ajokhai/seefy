// Full-screen camera with floating controls (close, status, hint, shutter), in the style of
// camera apps like Snapchat. Used by both the markerless scan and tag tracking.

import { h } from "./ui";

export interface CameraSheet {
  el: HTMLElement;
  video: HTMLVideoElement;
  overlay: HTMLCanvasElement;
  setStatus(text: string, tone?: "rec" | "ok" | "warn" | ""): void;
  setHint(text: string): void;
  setShutter(state: "idle" | "recording" | "busy" | "hidden"): void;
  setCorner(content: HTMLElement | null): void;
  close(): void;
}

export function openCameraSheet(opts: { onShutter?: () => void; onClose?: () => void; shutterLabel?: string }): CameraSheet {
  const video = h("video", { playsinline: true, muted: true, autoplay: true });
  const overlay = h("canvas", { class: "cam-overlay" });
  const status = h("div", { class: "cam-status" });
  const hint = h("div", { class: "cam-hint" });
  const corner = h("div", { class: "cam-corner" });
  const shutter = h("button", { class: "cam-shutter", "aria-label": opts.shutterLabel ?? "Record" }, h("span"));
  const closeBtn = h("button", { class: "cam-close", "aria-label": "Close camera" }, "✕");

  const el = h("div", { class: "cam-sheet" },
    video, overlay,
    h("div", { class: "cam-top" }, closeBtn, status, h("span", { class: "cam-spacer" })),
    h("div", { class: "cam-bottom" }, hint, h("div", { class: "cam-controls" }, corner, shutter, h("span", { class: "cam-spacer" }))),
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
