// Copies OpenCV.js into public/vendor so the tag worker and print page can load it as a plain script.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/@techstark/opencv-js/dist/opencv.js");
const dst = join(root, "public/vendor/opencv.js");
mkdirSync(dirname(dst), { recursive: true });
if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) copyFileSync(src, dst);
