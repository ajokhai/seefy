/* Tag detection and phone pose, off the main thread.
 *
 * A plain (classic) worker so it can load OpenCV.js with importScripts.
 * Input: grayscale-able camera frames. Output: detected tag corners (full-res
 * pixels) and, when tags from the host's map are visible, the phone's pose in
 * the world frame (z up, origin at the floor tag).
 */
let cv = null;
let detector = null;
let dict = null;
let settings = { refinement: "subpix", roomMaxId: 49, boardFirst: 200, boardCount: 35, minTagPx: 24, maxReprojPx: 4 };
let map = {}; // id -> { T: [16] world_from_tag, corners: [12] world, size }

async function init(url, s) {
  importScripts(url);
  let m = self.cv;
  if (m instanceof Promise) m = await m;
  else if (!m.Mat) await new Promise((r) => (m.onRuntimeInitialized = r));
  cv = m;
  dict = cv.getPredefinedDictionary(cv.DICT_APRILTAG_36h11);
  applySettings(s);
}

function applySettings(s) {
  settings = { ...settings, ...(s || {}) };
  if (!cv) return;
  if (detector) detector.delete();
  const p = new cv.aruco_DetectorParameters();
  p.cornerRefinementMethod =
    {
      none: cv.CORNER_REFINE_NONE,
      subpix: cv.CORNER_REFINE_SUBPIX,
      contour: cv.CORNER_REFINE_CONTOUR,
      apriltag: cv.CORNER_REFINE_APRILTAG,
    }[settings.refinement] ?? cv.CORNER_REFINE_SUBPIX;
  const r = new cv.aruco_RefineParameters(10, 3, true);
  detector = new cv.aruco_ArucoDetector(dict, p, r);
  p.delete();
  r.delete();
}

// ---- small matrix helpers (row-major) ------------------------------------

function mul4(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
  return o;
}

function inv4(T) {
  const R = [T[0], T[1], T[2], T[4], T[5], T[6], T[8], T[9], T[10]];
  const t = [T[3], T[7], T[11]];
  const o = [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, 0, 0, 0, 1];
  for (let i = 0; i < 3; i++) o[i * 4 + 3] = -(o[i * 4] * t[0] + o[i * 4 + 1] * t[1] + o[i * 4 + 2] * t[2]);
  return o;
}

function rvecToR(rvec) {
  const rv = cv.matFromArray(3, 1, cv.CV_64F, rvec);
  const R = new cv.Mat();
  cv.Rodrigues(rv, R);
  const out = Array.from(R.data64F);
  rv.delete();
  R.delete();
  return out;
}

function RtoRvec(R9) {
  const R = cv.matFromArray(3, 3, cv.CV_64F, R9);
  const rv = new cv.Mat();
  cv.Rodrigues(R, rv);
  const out = Array.from(rv.data64F);
  R.delete();
  rv.delete();
  return out;
}

function toT(rvec, tvec) {
  const R = rvecToR(rvec);
  return [R[0], R[1], R[2], tvec[0], R[3], R[4], R[5], tvec[1], R[6], R[7], R[8], tvec[2], 0, 0, 0, 1];
}

function localCorners(size) {
  const h = size / 2;
  return [-h, h, 0, h, h, 0, h, -h, 0, -h, -h, 0];
}

/** Pinhole projection with OpenCV's k1 k2 p1 p2 k3 distortion. */
function project(K, D, Tcw, pw) {
  const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0] = D || [];
  const out = [];
  for (let i = 0; i < pw.length; i += 3) {
    const X = Tcw[0] * pw[i] + Tcw[1] * pw[i + 1] + Tcw[2] * pw[i + 2] + Tcw[3];
    const Y = Tcw[4] * pw[i] + Tcw[5] * pw[i + 1] + Tcw[6] * pw[i + 2] + Tcw[7];
    const Z = Tcw[8] * pw[i] + Tcw[9] * pw[i + 1] + Tcw[10] * pw[i + 2] + Tcw[11];
    if (Z <= 1e-3) return null;
    const x = X / Z, y = Y / Z, r2 = x * x + y * y;
    const rad = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    const xd = x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
    const yd = y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
    out.push(K[0] * xd + K[2], K[4] * yd + K[5]);
  }
  return out;
}

function reprojRms(K, D, Tcw, pw, uv) {
  const p = project(K, D, Tcw, pw);
  if (!p) return Infinity;
  let s = 0;
  for (let i = 0; i < p.length; i += 2) s += (p[i] - uv[i]) ** 2 + (p[i + 1] - uv[i + 1]) ** 2;
  return Math.sqrt(s / (p.length / 2));
}

function area(c) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    a += c[2 * i] * c[2 * j + 1] - c[2 * j] * c[2 * i + 1];
  }
  return Math.abs(a) / 2;
}

// ---- detection and pose --------------------------------------------------

function detect(image, scale) {
  const rgba = cv.matFromImageData(image);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const corners = new cv.MatVector();
  const ids = new cv.Mat();
  const rejected = new cv.MatVector();
  detector.detectMarkers(gray, corners, ids, rejected);
  const dets = [];
  for (let i = 0; i < ids.rows; i++) {
    const m = corners.get(i);
    const c = Array.from(m.data32F, (v) => v / scale);
    m.delete();
    let edge = Infinity;
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      edge = Math.min(edge, Math.hypot(c[2 * j] - c[2 * k], c[2 * j + 1] - c[2 * k + 1]));
    }
    if (edge >= settings.minTagPx) dets.push({ id: ids.data32S[i], c });
  }
  rgba.delete();
  gray.delete();
  corners.delete();
  ids.delete();
  rejected.delete();
  return dets;
}

function solvePose(dets, K, D) {
  const known = dets.filter((d) => map[d.id]);
  if (!known.length) return null;
  const Km = cv.matFromArray(3, 3, cv.CV_64F, K);
  const Dm = cv.matFromArray(1, 5, cv.CV_64F, [0, 0, 0, 0, 0].map((z, i) => (D && D[i]) || z));
  const rvec = new cv.Mat();
  const tvec = new cv.Mat();
  const pw = [];
  const uv = [];
  for (const d of known) {
    pw.push(...map[d.id].corners);
    uv.push(...d.c);
  }
  try {
    // Start from the largest visible mapped tag.
    const best = known.reduce((a, b) => (area(b.c) > area(a.c) ? b : a));
    const obj1 = cv.matFromArray(4, 1, cv.CV_64FC3, localCorners(map[best.id].size));
    const img1 = cv.matFromArray(4, 1, cv.CV_64FC2, best.c);
    cv.solvePnP(obj1, img1, Km, Dm, rvec, tvec, false, cv.SOLVEPNP_IPPE_SQUARE);
    obj1.delete();
    img1.delete();
    let Tcw = mul4(toT(Array.from(rvec.data64F), Array.from(tvec.data64F)), inv4(map[best.id].T));
    let err = reprojRms(K, D, Tcw, pw, uv);

    if (known.length >= 2) {
      // Refine against every visible mapped tag.
      const R9 = [Tcw[0], Tcw[1], Tcw[2], Tcw[4], Tcw[5], Tcw[6], Tcw[8], Tcw[9], Tcw[10]];
      const rv = cv.matFromArray(3, 1, cv.CV_64F, RtoRvec(R9));
      const tv = cv.matFromArray(3, 1, cv.CV_64F, [Tcw[3], Tcw[7], Tcw[11]]);
      const obj = cv.matFromArray(pw.length / 3, 1, cv.CV_64FC3, pw);
      const img = cv.matFromArray(uv.length / 2, 1, cv.CV_64FC2, uv);
      cv.solvePnP(obj, img, Km, Dm, rv, tv, true, cv.SOLVEPNP_ITERATIVE);
      const T2 = toT(Array.from(rv.data64F), Array.from(tv.data64F));
      const err2 = reprojRms(K, D, T2, pw, uv);
      if (err2 < err) {
        Tcw = T2;
        err = err2;
      }
      [rv, tv, obj, img].forEach((m) => m.delete());
    }

    // World pose of the camera: R_wc = R_cw^T, p = -R_cw^T t.
    const Twc = inv4(Tcw);
    return {
      ok: err <= settings.maxReprojPx,
      err,
      tags: known.map((d) => d.id),
      p: [Twc[3], Twc[7], Twc[11]],
      R: [Twc[0], Twc[1], Twc[2], Twc[4], Twc[5], Twc[6], Twc[8], Twc[9], Twc[10]],
    };
  } finally {
    Km.delete();
    Dm.delete();
    rvec.delete();
    tvec.delete();
  }
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      await init(m.url, m.settings);
      self.postMessage({ type: "ready" });
    } else if (m.type === "settings") {
      applySettings(m.settings);
    } else if (m.type === "map") {
      map = m.tags || {};
    } else if (m.type === "frame") {
      const t0 = performance.now();
      const dets = detect(m.image, m.scale);
      const pose = m.track ? solvePose(dets, m.K, m.D) : null;
      self.postMessage({ type: "result", id: m.id, t: m.t, dets, pose, ms: performance.now() - t0 });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, error: String((err && err.message) || err) });
  }
};
