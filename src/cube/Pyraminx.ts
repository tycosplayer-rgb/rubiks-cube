import * as THREE from 'three';
import { PolyPuzzle, type PolyTile } from './PolyPuzzle';
import type { FaceButton, FaceTurnMove, VisualStyle } from './puzzle';

const COLORS = [0xffd500, 0x009e60, 0xc41e3a, 0x0051ba];
const CSS = ['#FFD500', '#009E60', '#C41E3A', '#0051BA'];
const IDS = ['U', 'L', 'R', 'B'];

/**
 * Facelet projections along a tip axis (solved, |vertex|=2.7) cluster at:
 *   ~1.92 tip (3) · ~1.12 axial wedges (3) · ~0.72 edge band (6) · lower fixed
 * Tip layer = tip only (3). Deep layer = tip+axial+edge = 12 (C3-closed).
 * The old deep cut at -0.7 selected 27 tiles (three full faces) and split the
 * three opposite tip pieces — illegal motion that looked like broken animation.
 */
const TIP_THRESH = 1.5;
const DEEP_THRESH = 0.4;

interface PyraTile extends PolyTile {
  /** Tip index this facelet belongs to as a trivial tip sticker, or -1. */
  tipPiece: number;
  /** Face index (0..3) the sticker sits on — color source. */
  faceIndex: number;
}

/** 3-layer Pyraminx: turns about the four tip (vertex) axes, 120° each. */
export class Pyraminx extends PolyPuzzle {
  readonly puzzleType = 'pyraminx' as const;
  private readonly scratch = new THREE.Vector3();
  private readonly pyraTiles: PyraTile[] = [];

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

    // faces[i] = tip axis through vertex i (not a face normal). Turns = tip twists.
    this.faces = vertices.map((axis, i) => ({
      id: IDS[i],
      label: IDS[i],
      axis: axis.clone().normalize(),
      color: COLORS[i],
      colorCss: CSS[i],
    }));

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

    for (let faceIndex = 0; faceIndex < 4; faceIndex++) {
      // Face opposite tip `faceIndex` — colored by that face's color (same index).
      const fv = vertices.filter((_, i) => i !== faceIndex);
      const tipIndices = [0, 1, 2, 3].filter((i) => i !== faceIndex);
      let [a, b, c] = fv;
      let [ta, tb, tc] = tipIndices;
      let normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
      const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      if (normal.dot(center) < 0) {
        [b, c] = [c, b];
        [tb, tc] = [tc, tb];
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

      const addTri = (v0: THREE.Vector3, v1: THREE.Vector3, v2: THREE.Vector3, tipPiece: number) => {
        const centroid = v0.clone().add(v1).add(v2).multiplyScalar(1 / 3);
        const shrink = (v: THREE.Vector3) => centroid.clone().lerp(v, 0.97);
        const geo = new THREE.BufferGeometry().setFromPoints([shrink(v0), shrink(v1), shrink(v2)]);
        geo.setIndex([0, 1, 2]);

        // Drag / gesture: nearest tip axis (tip-centric, not face-normal).
        let nearest = 0;
        let best = -Infinity;
        for (let k = 0; k < 4; k++) {
          const d = centroid.dot(this.faces[k].axis);
          if (d > best) {
            best = d;
            nearest = k;
          }
        }

        // Color by the triangular face this sticker sits on (not by nearest tip).
        this.addTile(geo, COLORS[faceIndex], IDS[nearest]);
        const tile = this.tiles[this.tiles.length - 1] as PyraTile;
        tile.tipPiece = tipPiece;
        tile.faceIndex = faceIndex;
        tile.mesh.userData.tipPiece = tipPiece;
        tile.mesh.userData.faceIndex = faceIndex;
        this.pyraTiles.push(tile);
      };

      // Up-pointing cells: corners at (0,0)->tip a, (n,0)->tip b, (0,n)->tip c.
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n - i; j++) {
          let tipPiece = -1;
          if (i === 0 && j === 0) tipPiece = ta;
          else if (i === n - 1 && j === 0) tipPiece = tb;
          else if (i === 0 && j === n - 1) tipPiece = tc;
          addTri(p(i, j), p(i + 1, j), p(i, j + 1), tipPiece);
        }
      }
      // Down-pointing fillers (edge/axial band) — not tip stickers.
      for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < n - 1 - i; j++) {
          addTri(p(i + 1, j), p(i + 1, j + 1), p(i, j + 1), -1);
        }
      }
    }
  }

  protected selectLayer(move: FaceTurnMove): PolyTile[] {
    this.group.updateMatrixWorld(true);
    const axis = this.faceOf(move.face).axis;
    const thresh = move.tip ? TIP_THRESH : DEEP_THRESH;
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

  /**
   * Scramble with mostly deep tip-axis turns; tip-only twists are rare (~15%).
   * Overrides PolyPuzzle so we can set `tip` occasionally.
   */
  async scramble(): Promise<void> {
    if (this.isBusy()) return;
    this.stopped = false;
    this.locked = true;
    this.emit({ type: 'busy', busy: true });
    this.history = [];
    this.emit({ type: 'move', notation: '', historyLen: 0 });
    const length = this.scrambleLength();
    const moves: FaceTurnMove[] = [];
    let previous = '';
    for (let i = 0; i < length; i++) {
      let face = this.faces[Math.floor(Math.random() * this.faces.length)].id;
      while (face === previous) face = this.faces[Math.floor(Math.random() * this.faces.length)].id;
      previous = face;
      const tip = Math.random() < 0.15;
      moves.push({ kind: 'face', face, steps: Math.random() < 0.5 ? 1 : -1, tip });
    }
    this.emit({ type: 'scramble', text: moves.map((m) => this.notation(m)).join(' '), length });
    this.emit({ type: 'status', message: `打乱中… (${length} 步)` });
    try {
      for (const m of moves) {
        if (this.stopped) break;
        await this.applyMove(m, true);
      }
      if (!this.stopped) this.emit({ type: 'status', message: `打乱完成 · ${length} 步` });
    } finally {
      this.locked = false;
      this.emit({ type: 'busy', busy: false });
    }
  }

  getFitDistance(): number {
    return 7.2;
  }

  getFloorY(): number {
    return -2.35;
  }

  getFaceButtons(): FaceButton[] {
    return [
      ...this.faces.map((f) => ({
        id: f.id,
        label: `${f.label}层`,
        color: f.colorCss,
      })),
      ...this.faces.map((f) => ({
        id: f.id,
        label: `${f.label}尖`,
        color: f.colorCss,
        tip: true,
      })),
    ];
  }

  /** Test helper: layer sizes and C3 slot closure (no animation). */
  debugVerifyLayers(): {
    tipCount: number;
    deepCount: number;
    tipClosed: boolean;
    deepClosed: boolean;
    tipLeavesMid: boolean;
    deepRoundTrip: boolean;
  } {
    this.group.updateMatrixWorld(true);
    const axis = this.faces[0].axis;
    const slots = this.tiles.map((t) => this.tileWorldCenter(t).clone());
    const tip = this.tiles.filter((t) => this.tileWorldCenter(t, this.scratch).dot(axis) > TIP_THRESH);
    const deep = this.tiles.filter((t) => this.tileWorldCenter(t, this.scratch).dot(axis) > DEEP_THRESH);
    const q = new THREE.Quaternion().setFromAxisAngle(axis, (Math.PI * 2) / 3);
    const closed = (sel: PolyTile[]) =>
      sel.every((t) => {
        const dest = this.tileWorldCenter(t).applyQuaternion(q);
        return slots.some((s) => s.distanceTo(dest) < 0.08);
      });
    // Tip must not include mid-layer (0.4 < d <= 1.5) tiles.
    const mid = this.tiles.filter((t) => {
      const d = this.tileWorldCenter(t, this.scratch).dot(axis);
      return d > DEEP_THRESH && d <= TIP_THRESH;
    });
    const tipSet = new Set(tip);
    const tipLeavesMid = mid.every((t) => !tipSet.has(t));

    // Three deep U turns: centers return (apply virtual rotations to copies).
    let ok = true;
    for (const t of deep) {
      const c = this.tileWorldCenter(t).clone();
      c.applyQuaternion(q).applyQuaternion(q).applyQuaternion(q);
      if (c.distanceTo(this.tileWorldCenter(t)) > 0.08) ok = false;
    }
    return {
      tipCount: tip.length,
      deepCount: deep.length,
      tipClosed: closed(tip),
      deepClosed: closed(deep),
      tipLeavesMid,
      deepRoundTrip: ok,
    };
  }
}
