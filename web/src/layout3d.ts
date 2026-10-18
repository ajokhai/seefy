// Room structure in 3D: translucent walls with door gaps cut out, the floor outline, and
// furniture as wireframe boxes. Input is the scan result's `layout` (server/seefy/layout.py).
//
// Seefy's world is z-up (x, y on the floor); three.js is y-up, so (x, y, z) -> (x, z, -y).

import * as THREE from "three";

export interface Layout {
  ok: boolean;
  reason?: string;
  height_m: number;
  outline: number[][];
  walls: { a: number[]; b: number[]; length_m: number; support: number; openings: { from_m: number; to_m: number }[] }[];
  objects: { center: number[]; size: number[]; yaw: number }[];
}

const DOOR_HEIGHT = 2.0;

export function layoutGroup(layout: Layout, dark: boolean): THREE.Group {
  const g = new THREE.Group();
  if (!layout?.ok) return g;
  const wallColor = dark ? 0xd1d1d6 : 0x8e8e93;
  const height = Math.max(2.2, Math.min(layout.height_m, 3.2));

  for (const w of layout.walls) {
    const [ax, ay] = w.a;
    const [bx, by] = w.b;
    const len = Math.hypot(bx - ax, by - ay);
    // A wall is a rectangle in its own plane, with a hole per opening (doors run floor to DOOR_HEIGHT).
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(len, 0), new THREE.Vector2(len, height), new THREE.Vector2(0, height)]);
    for (const o of w.openings) {
      shape.holes.push(new THREE.Path([
        new THREE.Vector2(o.from_m, 0.001), new THREE.Vector2(o.to_m, 0.001),
        new THREE.Vector2(o.to_m, DOOR_HEIGHT), new THREE.Vector2(o.from_m, DOOR_HEIGHT),
      ]));
    }
    const weak = w.support < 0.35;
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({
      color: wallColor, transparent: true, opacity: weak ? 0.08 : 0.18, side: THREE.DoubleSide, depthWrite: false,
    }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),
      weak
        ? new THREE.LineDashedMaterial({ color: wallColor, dashSize: 0.1, gapSize: 0.08 })
        : new THREE.LineBasicMaterial({ color: wallColor }));
    if (weak) edges.computeLineDistances();
    const wall = new THREE.Group().add(mesh, edges);
    wall.position.set(ax, 0, -ay);
    wall.rotation.y = Math.atan2(by - ay, bx - ax);
    g.add(wall);
  }

  const floor = new THREE.Shape(layout.outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const floorMesh = new THREE.Mesh(new THREE.ShapeGeometry(floor), new THREE.MeshBasicMaterial({
    color: 0x0a84ff, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false,
  }));
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = 0.002;
  g.add(floorMesh);

  for (const o of layout.objects) {
    const [w, d, h] = o.size;
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
      new THREE.LineBasicMaterial({ color: 0xff9f0a }));
    box.position.set(o.center[0], h / 2, -o.center[1]);
    box.rotation.y = o.yaw;
    g.add(box);
  }
  return g;
}
