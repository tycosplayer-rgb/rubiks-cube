import * as THREE from 'three';
import { PolyPuzzle, type PolyTile } from './PolyPuzzle';
import type { FaceButton, FaceTurnMove, VisualStyle } from './puzzle';

const COLORS = [0xffd500, 0x009e60, 0xc41e3a, 0x0051ba];
const CSS = ['#FFD500', '#009E60', '#C41E3A', '#0051BA'];
const IDS = ['U', 'L', 'R', 'B'];

/** 3-layer Pyraminx facelet model: tip / deep layers about four vertex axes. */
export class Pyraminx extends PolyPuzzle {
  readonly puzzleType = 'pyraminx' as const;
  private readonly scratch = new THREE.Vector3();

  constructor(style: VisualStyle = 'sticker') {
    super(style);
    this.build();
    this.finishBuild();
  }

  private build(): void {
    const vertices = [
      new THREE.Vector3(1, 1, 1),
      new THREE.Vector3(1, -1, -1),
      new THREE.Vector3(-1, 1, -1),
      new THREE.Vector3(-1, -1, 1),
    ].map((v) => v.normalize().multiplyScalar(2.7));

    this.faces = vertices.map((axis, i) => ({
      id: IDS[i],
      label: IDS[i],
      axis: axis.clone().normalize(),
      color: COLORS[i],
      colorCss: CSS[i],
    }));

    // Muted plastic core (not near-black) so any residual gaps read as grooves, not broken tiles.
    this.core = new THREE.Mesh(
      new THREE.TetrahedronGeometry(2.55, 0),
      new THREE.MeshStandardMaterial({
        color: 0x3a3f4a,
        roughness: 0.78,
        metalness: 0.02,
        flatShading: true,
      }),
    );
    this.group.add(this.core);

    for (let opposite = 0; opposite < 4; opposite++) {
      const fv = vertices.filter((_, i) => i !== opposite);
      let [a, b, c] = fv;
      let normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
      const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      if (normal.dot(center) < 0) {
        [b, c] = [c, b];
        normal.negate();
      }
      const off = normal.clone().multiplyScalar(0.045);
      const n = 3;
      const p = (i: number, j: number) =>
        a
          .clone()
          .add(b.clone().sub(a).multiplyScalar(i / n))
          .add(c.clone().sub(a).multiplyScalar(j / n))
          .add(off);

      const addTri = (v0: THREE.Vector3, v1: THREE.Vector3, v2: THREE.Vector3) => {
        const centroid = v0.clone().add(v1).add(v2).multiplyScalar(1 / 3);
        const shrink = (v: THREE.Vector3) => centroid.clone().lerp(v, 0.97);
        const geo = new THREE.BufferGeometry().setFromPoints([shrink(v0), shrink(v1), shrink(v2)]);
        geo.setIndex([0, 1, 2]);
        let nearest = 0;
        let best = -Infinity;
        for (let k = 0; k < 4; k++) {
          const d = centroid.dot(this.faces[k].axis);
          if (d > best) {
            best = d;
            nearest = k;
          }
        }
        this.addTile(geo, COLORS[opposite], IDS[nearest]);
      };

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n - i; j++) addTri(p(i, j), p(i + 1, j), p(i, j + 1));
      }
      for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < n - 1 - i; j++) addTri(p(i + 1, j), p(i + 1, j + 1), p(i, j + 1));
      }
    }
  }

  protected selectLayer(move: FaceTurnMove): PolyTile[] {
    this.group.updateMatrixWorld(true);
    const axis = this.faceOf(move.face).axis;
    // Solved-state projections cluster with clear gaps (~1.92 tip / ~1.12 / ~0.72 / … / ~-0.95 opposite face).
    // Tip: only the 3 facelets at that vertex. Deep: everything above the opposite face (3 faces × 9).
    // Fixed count ranking (top 15) cut through a tied mid band and left holes → black patches.
    const thresh = move.tip ? 1.5 : -0.7;
    return this.tiles.filter(
      (tile) => this.tileWorldCenter(tile, this.scratch).dot(axis) > thresh,
    );
  }

  protected turnAngle(move: FaceTurnMove): number {
    return move.steps * ((Math.PI * 2) / 3);
  }

  protected scrambleLength(): number {
    return 12;
  }

  getFitDistance(): number {
    return 7.2;
  }

  getFloorY(): number {
    return -2.35;
  }

  getFaceButtons(): FaceButton[] {
    return [
      ...super.getFaceButtons(),
      ...this.faces.map((f) => ({
        id: f.id,
        label: `${f.label}尖`,
        color: f.colorCss,
        tip: true,
      })),
    ];
  }
}
