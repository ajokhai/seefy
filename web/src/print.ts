// Printable AprilTags (36h11): the floor origin tag, wall tags, and the lens-calibration grid.
// Sizes come from the host's settings so prints always match what the solver assumes.

import { h } from "./ui";

// OpenCV.js runs in the tag worker: compiling its 10 MB WebAssembly on the main thread can stall the page.
function startWorker(): Promise<Worker> {
  const w = new Worker("/tag-worker.js");
  return new Promise((resolve, reject) => {
    w.onmessage = (e) => (e.data.type === "ready" ? resolve(w) : reject(new Error(e.data.error)));
    w.postMessage({ type: "init", url: "/vendor/opencv.js", settings: {} });
  });
}

async function markerUrls(w: Worker, ids: number[], px = 400): Promise<Map<number, string>> {
  const urls = new Map<number, string>();
  await new Promise<void>((resolve) => {
    w.onmessage = (e) => {
      if (e.data.type !== "marker") return;
      const { id, pixels } = e.data;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = px;
      const img = canvas.getContext("2d")!.createImageData(px, px);
      for (let i = 0; i < pixels.length; i++) {
        img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = pixels[i];
        img.data[4 * i + 3] = 255;
      }
      canvas.getContext("2d")!.putImageData(img, 0, 0);
      urls.set(id, canvas.toDataURL("image/png"));
      if (urls.size === ids.length) resolve();
    };
    for (const id of ids) w.postMessage({ type: "marker", id, px });
  });
  return urls;
}

const ruler = () => h("div", { class: "ruler" }, "10 cm — check with a ruler");

async function main() {
  const [worker, cfg] = await Promise.all([startWorker(), fetch("/api/config").then((r) => r.json())]);
  const tr = cfg.values.tracking;
  const lens = cfg.values.lens;
  const boardIds = Array.from({ length: lens.board_cols * lens.board_rows }, (_, i) => lens.board_first_id + i);
  const roomIds = Array.from({ length: tr.room_tag_max_id + 1 }, (_, i) => i);
  const urls = await markerUrls(worker, [...roomIds, ...boardIds]);
  const markerImg = (id: number, sizeMm: number) =>
    h("img", { src: urls.get(id)!, style: `width:${sizeMm}mm;height:${sizeMm}mm`, alt: `tag ${id}` });
  const countInput = document.getElementById("count") as HTMLInputElement;
  const pages = document.getElementById("pages")!;

  function render() {
    const n = Math.max(1, Math.min(tr.room_tag_max_id, Number(countInput.value) || 8));
    const out: HTMLElement[] = [];
    const origin = tr.origin_tag_id;

    out.push(h("div", { class: "page" },
      h("div", { class: "tag" },
        markerImg(origin, tr.origin_tag_size_m * 1000),
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
            markerImg(id, tr.tag_size_m * 1000),
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
    for (let i = 0; i < lens.board_cols * lens.board_rows; i++) grid.append(markerImg(lens.board_first_id + i, tagMm));
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
