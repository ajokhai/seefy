// Printable AprilTags (36h11): the floor origin tag, wall tags, and the lens-calibration grid.
// Sizes come from the host's settings so prints always match what the solver assumes.

import { h } from "./ui";

declare global {
  interface Window {
    cv: any;
  }
}

async function loadCv(): Promise<any> {
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/opencv.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("could not load OpenCV.js"));
    document.head.append(s);
  });
  let cv = window.cv;
  if (cv instanceof Promise) cv = await cv;
  else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  return cv;
}

function markerImg(cv: any, dict: any, id: number, sizeMm: number): HTMLImageElement {
  const mat = new cv.Mat();
  cv.generateImageMarker(dict, id, 400, mat, 1); // whole image = the black square the solver measures
  const canvas = document.createElement("canvas");
  cv.imshow(canvas, mat);
  mat.delete();
  return h("img", { src: canvas.toDataURL("image/png"), style: `width:${sizeMm}mm;height:${sizeMm}mm`, alt: `tag ${id}` });
}

const ruler = () => h("div", { class: "ruler" }, "10 cm — check with a ruler");

async function main() {
  const [cv, cfg] = await Promise.all([loadCv(), fetch("/api/config").then((r) => r.json())]);
  const tr = cfg.values.tracking;
  const lens = cfg.values.lens;
  const dict = cv.getPredefinedDictionary(cv.DICT_APRILTAG_36h11);
  const countInput = document.getElementById("count") as HTMLInputElement;
  const pages = document.getElementById("pages")!;

  function render() {
    const n = Math.max(1, Math.min(tr.room_tag_max_id, Number(countInput.value) || 8));
    const out: HTMLElement[] = [];
    const origin = tr.origin_tag_id;

    out.push(h("div", { class: "page" },
      h("div", { class: "tag" },
        markerImg(cv, dict, origin, tr.origin_tag_size_m * 1000),
        h("div", { class: "label" },
          h("b", {}, `Tag ${origin} · FLOOR ORIGIN`), h("br"),
          `${tr.origin_tag_size_m * 100} cm black square. Lay it flat on the floor in a spot the camera sees often.`, h("br"),
          "The room's x axis runs to the right of this page, y toward its top edge.")),
      ruler()));

    const wallIds = Array.from({ length: n }, (_, i) => i + 1).filter((id) => id !== origin);
    for (let i = 0; i < wallIds.length; i += 2) {
      out.push(h("div", { class: "page" },
        ...wallIds.slice(i, i + 2).map((id) =>
          h("div", { class: "tag" },
            markerImg(cv, dict, id, tr.tag_size_m * 1000),
            h("div", { class: "label" }, h("b", {}, `Tag ${id}`), h("br"),
              `${tr.tag_size_m * 100} cm. Stick upright on a wall, flat, roughly chest height. Spread tags around each room.`))),
        ruler()));
    }

    const tagMm = 25;
    const gapMm = tagMm * lens.board_gap_ratio;
    const grid = h("div", {
      class: "grid",
      style: `grid-template-columns:repeat(${lens.board_cols},${tagMm}mm);gap:${gapMm}mm;padding:${gapMm}mm`,
    });
    for (let i = 0; i < lens.board_cols * lens.board_rows; i++) grid.append(markerImg(cv, dict, lens.board_first_id + i, tagMm));
    out.push(h("div", { class: "page" },
      h("div", { class: "label" }, h("b", {}, "Lens calibration grid"), h("br"),
        "Tape it flat to a table or wall. Any print scale works for the lens, but keep it flat."),
      grid));

    pages.replaceChildren(...out);
  }

  countInput.oninput = render;
  document.getElementById("print")!.onclick = () => window.print();
  render();
}

main().catch((e) => {
  document.getElementById("pages")!.textContent = `Failed: ${e.message}`;
});
