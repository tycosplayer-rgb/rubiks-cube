import * as THREE from 'three';
import { PolyPuzzle, type PolyTile } from './PolyPuzzle';
import type { FaceTurnMove, VisualStyle } from './puzzle';

const COLORS = [
  0xf5f5f5, 0xc41e3a, 0x1646c4, 0xffd500, 0x7b2cbf, 0x009e60,
  0xff8c00, 0x69d2e7, 0xff69b4, 0x8b4513, 0x9acd32, 0x808080,
];
const CSS = COLORS.map((c) => `#${c.toString(16).padStart(6, '0')}`);
const IDS = ['U', 'R', 'FR', 'DR', 'D', 'DL', 'L', 'FL', 'BR', 'B', 'BL', 'DB'];

interface FoundFace {
  normal: THREE.Vector3;
  points: THREE.Vector3[];
}

/** Dodecahedron facelet Megaminx: 12 faces × (center + 5 petals), 72° turns. */
export class Megaminx extends PolyPuzzle {
  readonly puzzleType = 'megaminx' as const;
  private readonly scratch = new THREE.Vector3();

  constructor(style: VisualStyle = 'sticker') {
    super(style);
    this.build();
    this.finishBuild();
  }

  private build(): void {
    const source = new THREE.DodecahedronGeometry(2.7, 0);
    const pos = source.getAttribute('position');
    const found: FoundFace[] = [];
    for (let i = 0; i < pos.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(pos, i);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1);
      const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
      const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
      if (n.dot(a) < 0) n.negate();
      let face = found.find((f) => f.normal.dot(n) > 0.999);
      if (!face) {
        face = { normal: n.clone(), points: [] };
        found.push(face);
      }
      for (const v of [a, b, c]) {
        if (!face.points.some((p) => p.distanceToSquared(v) < 1e-8)) face.points.push(v.clone());
      }
    }
    source.dispose();

    found.sort(
      (a, b) =>
        b.normal.y - a.normal.y ||
        Math.atan2(a.normal.z, a.normal.x) - Math.atan2(b.normal.z, b.normal.x),
    );
    this.faces = found.map((f, i) => ({
      id: IDS[i],
      label: IDS[i],
      axis: f.normal.clone().normalize(),
      color: COLORS[i],
      colorCss: CSS[i],
    }));

    this.core = new THREE.Mesh(
      new THREE.DodecahedronGeometry(2.67, 0),
      new THREE.MeshStandardMaterial({
        color: 0x101116,
        roughness: 0.65,
        metalness: 0.04,
        flatShading: true,
      }),
    );
    this.group.add(this.core);

    found.forEach((f, faceIndex) => {
      const center = f.points
        .reduce((sum, p) => sum.add(p), new THREE.Vector3())
        .multiplyScalar(1 / f.points.length);
      const normal = f.normal.clone().normalize();
      const u = f.points[0].clone().sub(center).normalize();
      const v = new THREE.Vector3().crossVectors(normal, u).normalize();
      const points = [...f.points]
        .sort((a, b) => {
          const aa = Math.atan2(a.clone().sub(center).dot(v), a.clone().sub(center).dot(u));
          const bb = Math.atan2(b.clone().sub(center).dot(v), b.clone().sub(center).dot(u));
          return aa - bb;
        })
        .map((p) => p.clone().addScaledVector(normal, 0.045));
      const c = center.clone().addScaledVector(normal, 0.045);
      const inner = points.map((p) => c.clone().lerp(p, 0.42));

      const addPoly = (poly: THREE.Vector3[]) => {
        const mid = poly.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / poly.length);
        const inset = poly.map((p) => mid.clone().lerp(p, 0.93));
        const verts: THREE.Vector3[] = [];
        for (let k = 1; k < inset.length - 1; k++) verts.push(inset[0], inset[k], inset[k + 1]);
        const geo = new THREE.BufferGeometry().setFromPoints(verts);
        this.addTile(geo, COLORS[faceIndex], IDS[faceIndex]);
      };

      addPoly(inner);
      for (let i = 0; i < 5; i++) {
        addPoly([inner[i], inner[(i + 1) % 5], points[(i + 1) % 5], points[i]]);
      }
    });
  }

  protected selectLayer(move: FaceTurnMove): PolyTile[] {
    this.group.updateMatrixWorld(true);
    const axis = this.faceOf(move.face).axis;
    return this.tiles
      .map((tile) => ({ tile, d: this.tileWorldCenter(tile, this.scratch).dot(axis) }))
      .sort((a, b) => b.d - a.d)
      .slice(0, 11)
      .map((x) => x.tile);
  }

  protected turnAngle(move: FaceTurnMove): number {
    return move.steps * ((Math.PI * 2) / 5);
  }

  protected scrambleLength(): number {
    return 24;
  }

  getFitDistance(): number {
    return 8.2;
  }

  getFloorY(): number {
    return -3.05;
  }
}
