import * as THREE from 'three';
import { PolyPuzzle, type PolyFace, type PolyTile } from './PolyPuzzle';
import type { FaceButton, FaceTurnMove, VisualStyle } from './puzzle';

const COLORS = [0xffd500, 0x009e60, 0xc41e3a, 0x0051ba];
const CSS = ['#FFD500', '#009E60', '#C41E3A', '#0051BA'];
const IDS = ['U', 'L', 'R', 'B'];

/**
 * Facelet projections along a tip axis (solved, |vertex|=2.7) cluster at:
 *   ~1.92 tip (3) · ~1.12 axial wedges (3) · ~0.72 edge band (6) · lower fixed
 * Tip layer = tip only (3): d > TIP_THRESH.
 * Deep / 棱层 = mid-band excluding tip (9): DEEP_THRESH < d ≤ TIP_THRESH.
 * Tips and edges turn independently — deep must not move the vertex tip tiles.
 */
const TIP_THRESH = 1.5;
const DEEP_THRESH = 0.4;
/** Geometry inset for grooves between facelets. */
const STICKER_SHRINK = 0.99;
/** Push facelets outward along face normals so spinning layers clear the core. */
const FACELET_OUTSET = 0.065;
/** Core circumradius — recessed so mid-turn shear gaps do not flash black. */
const CORE_RADIUS = 2.15;

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

    // Recessed soft-gray core: mid-turn shear gaps show plastic, not black clip.
    this.core = new THREE.Mesh(
      new THREE.TetrahedronGeometry(CORE_RADIUS, 0),
      new THREE.MeshStandardMaterial({
        color: 0x8b929c,
        roughness: 0.85,
        metalness: 0.0,
        flatShading: true,
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 2,
      }),
    );
    this.core.renderOrder = -1;
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
      const off = normal.clone().multiplyScalar(FACELET_OUTSET);
      const n = 3;
      const p = (i: number, j: number) =>
        a
          .clone()
          .add(b.clone().sub(a).multiplyScalar(i / n))
          .add(c.clone().sub(a).multiplyScalar(j / n))
          .add(off);

      const addTri = (v0: THREE.Vector3, v1: THREE.Vector3, v2: THREE.Vector3, tipPiece: number) => {
        const centroid = v0.clone().add(v1).add(v2).multiplyScalar(1 / 3);
        const shrink = (v: THREE.Vector3) => centroid.clone().lerp(v, STICKER_SHRINK);
        const geo = new THREE.BufferGeometry().setFromPoints([shrink(v0), shrink(v1), shrink(v2)]);
        geo.setIndex([0, 1, 2]);
        geo.computeVertexNormals();

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
        // Pull stickers in front of the core; avoids z-fight / black flash.
        tile.mesh.material.polygonOffset = true;
        tile.mesh.material.polygonOffsetFactor = -4;
        tile.mesh.material.polygonOffsetUnits = -4;
        tile.mesh.renderOrder = 1;
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

  /**
   * Swipe → tip-axis turn with tip vs deep (角层 / 棱层).
   *
   * Tip axis is resolved at hit time (not stale `turnFace`):
   *   1. `mesh.userData.tipPiece >= 0` → that tip’s axis/id.
   *   2. else if the hit projects `> TIP_THRESH` on some tip axis → that tip.
   *   3. else among tips whose **deep** band currently contains the sticker
   *      (`DEEP_THRESH < d ≤ TIP_THRESH`), pick the one whose ±120° screen
   *      motion best matches the swipe (finger-follows). Always include
   *      `resolveHitFace(point)` as a candidate.
   *
   * Tip vs deep: tip sticker **or** projection on the chosen tip `> TIP_THRESH`
   * → `{ tip: true }` (角层); else deep / 棱层 (`tip` falsy).
   * Direction: ±1 from screen-projected RH tangent about that tip (Y-flip).
   *
   * 底层: stickers near a downward tip / base often sit in more than one deep
   * band. Choosing the tip by membership + swipe score (not only max point·axis)
   * lets that bottom tip’s 角层 and 棱层 turn instead of always the upper mid-band.
   */
  dragToMove(
    mesh: THREE.Mesh,
    normal: THREE.Vector3,
    delta: THREE.Vector2,
    camera: THREE.Camera,
    point: THREE.Vector3,
  ): FaceTurnMove | null {
    if (delta.lengthSq() < 1) return null;
    this.group.updateMatrixWorld(true);

    const tipPiece = Number(mesh.userData.tipPiece ?? -1);
    const p0 = point.clone().project(camera);
    const radial = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const p1 = new THREE.Vector3();

    const scoreOnTip = (f: PolyFace): { steps: 1 | -1; score: number } | null => {
      radial.copy(point).addScaledVector(f.axis, -point.dot(f.axis));
      tangent.crossVectors(f.axis, radial);
      if (tangent.lengthSq() < 1e-8) {
        tangent.crossVectors(f.axis, camera.position.clone().sub(point));
      }
      if (tangent.lengthSq() < 1e-8) return null;
      tangent.normalize();
      let bestSteps: 1 | -1 = 1;
      let bestScore = -Infinity;
      for (const steps of [1, -1] as const) {
        p1.copy(point).addScaledVector(tangent, steps).project(camera);
        let sx = p1.x - p0.x;
        let sy = -(p1.y - p0.y);
        const slen = Math.hypot(sx, sy);
        if (slen < 1e-10) continue;
        sx /= slen;
        sy /= slen;
        const score = delta.x * sx + delta.y * sy;
        if (score > bestScore) {
          bestScore = score;
          bestSteps = steps;
        }
      }
      if (bestScore === -Infinity) return null;
      return { steps: bestSteps, score: bestScore };
    };

    let chosen: PolyFace | null = null;

    if (tipPiece >= 0 && tipPiece < this.faces.length) {
      chosen = this.faces[tipPiece];
    } else {
      let tipByProj: PolyFace | null = null;
      let tipDot = TIP_THRESH;
      for (const f of this.faces) {
        const d = point.dot(f.axis);
        if (d > tipDot) {
          tipDot = d;
          tipByProj = f;
        }
      }
      if (tipByProj) {
        chosen = tipByProj;
      } else {
        const candidates: PolyFace[] = [];
        for (const f of this.faces) {
          const d = point.dot(f.axis);
          if (d > DEEP_THRESH && d <= TIP_THRESH) candidates.push(f);
        }
        const resolved = this.resolveHitFace(point, normal);
        if (resolved && !candidates.some((c) => c.id === resolved.id)) {
          candidates.push(resolved);
        }
        if (!candidates.length) return null;

        let bestScore = -Infinity;
        for (const f of candidates) {
          const r = scoreOnTip(f);
          if (!r) continue;
          if (r.score > bestScore) {
            bestScore = r.score;
            chosen = f;
          }
        }
        if (!chosen) chosen = candidates[0];
      }
    }

    if (!chosen) return null;
    const scored = scoreOnTip(chosen);
    if (!scored || scored.score < 1e-6) return null;

    const proj = point.dot(chosen.axis);
    const tip = tipPiece >= 0 || proj > TIP_THRESH;
    if (mesh.userData) mesh.userData.turnFace = chosen.id;
    return {
      kind: 'face',
      face: chosen.id,
      steps: scored.steps,
      ...(tip ? { tip: true } : {}),
    };
  }

  protected selectLayer(move: FaceTurnMove): PolyTile[] {
    this.group.updateMatrixWorld(true);
    const axis = this.faceOf(move.face).axis;
    if (move.tip) {
      // Tip / 角: only the 3 facelets at that vertex.
      return this.tiles.filter(
        (tile) => this.tileWorldCenter(tile, this.scratch).dot(axis) > TIP_THRESH,
      );
    }
    // Deep / 棱层: C3-closed mid-band excluding tip (edges + axial wedges).
    return this.tiles.filter((tile) => {
      const d = this.tileWorldCenter(tile, this.scratch).dot(axis);
      return d > DEEP_THRESH && d <= TIP_THRESH;
    });
  }

  protected turnAngle(move: FaceTurnMove): number {
    return move.steps * ((Math.PI * 2) / 3);
  }

  protected scrambleLength(): number {
    return 12;
  }

  /**
   * Scramble with mostly deep (edge) tip-axis turns; tip-only twists are rare (~15%).
   * Deep and tip are independent — deep never couples tip stickers.
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
    deepLeavesTip: boolean;
    deepRoundTrip: boolean;
  } {
    this.group.updateMatrixWorld(true);
    const axis = this.faces[0].axis;
    const slots = this.tiles.map((t) => this.tileWorldCenter(t).clone());
    const tip = this.tiles.filter((t) => this.tileWorldCenter(t, this.scratch).dot(axis) > TIP_THRESH);
    const deep = this.tiles.filter((t) => {
      const d = this.tileWorldCenter(t, this.scratch).dot(axis);
      return d > DEEP_THRESH && d <= TIP_THRESH;
    });
    const q = new THREE.Quaternion().setFromAxisAngle(axis, (Math.PI * 2) / 3);
    const closed = (sel: PolyTile[]) =>
      sel.every((t) => {
        const dest = this.tileWorldCenter(t).applyQuaternion(q);
        return slots.some((s) => s.distanceTo(dest) < 0.08);
      });
    // Tip must not include mid-layer tiles.
    const mid = deep;
    const tipSet = new Set(tip);
    const deepSet = new Set(deep);
    const tipLeavesMid = mid.every((t) => !tipSet.has(t));
    // Deep must not include tip tiles.
    const deepLeavesTip = tip.every((t) => !deepSet.has(t));

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
      deepLeavesTip,
      deepRoundTrip: ok,
    };
  }
}
