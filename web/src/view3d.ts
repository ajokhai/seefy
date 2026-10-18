// 3D view of the scanned room: point cloud coloured by height, floor grid, the walked path,
// and markers for people. Drag to orbit, pinch or scroll to zoom, two-finger drag to pan.
//
// Seefy's world is z-up (x, y on the floor); three.js is y-up, so (x, y, z) -> (x, z, -y).

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const toThree = (p: number[]) => new THREE.Vector3(p[0], p[2], -p[1]);

export class View3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);
  private controls: OrbitControls;
  private room = new THREE.Group();
  private people = new Map<string, THREE.Group>();
  private raf = 0;
  private resize: ResizeObserver;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495; // stay above the floor
    this.scene.add(this.room);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
    this.camera.position.set(4, 5, 6);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private fit(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setScan(result: any): void {
    this.room.clear();
    const pts: number[][] = (result?.points ?? []).filter((q: number[]) => q[2] > -0.2 && q[2] < 3);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;

    // Floor grid sized to the room.
    let [x0, x1, y0, y1] = [-2, 2, -2, 2];
    if (pts.length) {
      const xs = pts.map((q) => q[0]).sort((a, b) => a - b);
      const ys = pts.map((q) => q[1]).sort((a, b) => a - b);
      const k = Math.floor(xs.length * 0.02);
      [x0, x1, y0, y1] = [xs[k], xs[xs.length - 1 - k], ys[k], ys[ys.length - 1 - k]];
    }
    const size = Math.ceil(Math.max(x1 - x0, y1 - y0, 3)) + 2;
    const grid = new THREE.GridHelper(size, size, dark ? 0x48484a : 0xc7c7cc, dark ? 0x2c2c2e : 0xe5e5ea);
    grid.position.set((x0 + x1) / 2, 0, -(y0 + y1) / 2);
    this.room.add(grid);

    if (pts.length) {
      // Colour by height: floor blue -> head height orange, so walls and furniture read clearly.
      const pos = new Float32Array(pts.length * 3);
      const col = new Float32Array(pts.length * 3);
      const low = new THREE.Color(0x0a84ff);
      const high = new THREE.Color(0xff9f0a);
      const c = new THREE.Color();
      pts.forEach((q, i) => {
        const v = toThree(q);
        pos.set([v.x, v.y, v.z], i * 3);
        c.copy(low).lerp(high, Math.min(1, Math.max(0, q[2] / 2.4)));
        col.set([c.r, c.g, c.b], i * 3);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      this.room.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.035, vertexColors: true, sizeAttenuation: true })));
    }

    const frames: { p: number[] }[] = result?.frames ?? [];
    if (frames.length > 1) {
      const line = new THREE.BufferGeometry().setFromPoints(frames.map((f) => toThree(f.p)));
      this.room.add(new THREE.Line(line, new THREE.LineDashedMaterial({ color: 0x0a84ff, dashSize: 0.12, gapSize: 0.08 }))
        .computeLineDistances());
    }

    // Look at the room from a raised corner.
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const span = Math.max(x1 - x0, y1 - y0, 3);
    this.controls.target.set(cx, 0.8, -cy);
    this.camera.position.set(cx + span * 0.7, span * 0.9, -cy + span * 0.9);
    this.camera.far = span * 10;
    this.camera.updateProjectionMatrix();
  }

  /** Show a person (body position on the floor, metres). */
  setPerson(id: string, x: number, y: number, stale = false): void {
    let g = this.people.get(id);
    if (!g) {
      g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0xff375f, roughness: 0.5 });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 1.0, 6, 16), mat);
      body.position.y = 0.68;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), mat);
      head.position.y = 1.55;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.36, 40),
        new THREE.MeshBasicMaterial({ color: 0xff375f, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.01;
      g.add(body, head, ring);
      this.scene.add(g);
      this.people.set(id, g);
    }
    g.position.set(x, 0, -y);
    g.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) {
        m.transparent = true;
        m.opacity = stale ? 0.3 : 1;
      }
    });
  }
}
