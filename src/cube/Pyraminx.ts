import * as THREE from 'three';
import { PolyPuzzle, type PolyFace, type PolyTile } from './PolyPuzzle';
import type {
  FaceButton,
  FaceTurnMove,
  LayerDragSession,
  PuzzlePick,
  VisualStyle,
} from './puzzle';

const COLORS = [0xffd500, 0x009e60, 0xc41e3a, 0x0051ba];
const CSS = ['#FFD500', '#009E60', '#C41E3A', '#0051BA'];
const IDS = ['U', 'L', 'R', 'B'];

/** Geometry inset for grooves between facelets. */
const STICKER_SHRINK = 0.99;
/** Push facelets outward along face normals so spinning layers clear the core. */
const FACELET_OUTSET = 0.065;
/** Core circumradius — recessed so mid-turn shear gaps do not flash black. */
const CORE_RADIUS = 2.15;
/** Classic N=3 tip / deep cuts (must stay exact for verify + feel). */
const N3_TIP_THRESH = 1.5;
const N3_DEEP_THRESH = 0.4;

interface PyraTile extends PolyTile {
  /** Tip index this facelet belongs to as a trivial tip sticker, or -1. */
  tipPiece: number;
  /** Face index (0..3) the sticker sits on — color source. */
  faceIndex: number;
  /**
   * Discrete tip-axis depth band 0..order-1 for each of the four tips.
   * Built from face-grid row index (not centroid projection), so up- and
   * down-pointing facelets in the same geometric row share one band.
   */
  tipDepth: number[];
}

/**
 * NxN Pyraminx (orders 2–20): turns about the four tip (vertex) axes, 120° each.
 * Depth bands along each tip axis: 0 = tip … order-1 = bottom.
 * N=3 preserves classic tip / 层 / 底 thresholds and labels.
 */
export class Pyraminx extends PolyPuzzle {
  readonly puzzleType = 'pyraminx' as const;
  private readonly order: number;
  /** Cuts between depth bands, high→low. Length = order-1.
   *  depth 0: d > thresh[0]
   *  depth k: thresh[k] < d ≤ thresh[k-1]
   *  depth N-1: d ≤ thresh[N-2]
   */
  private depthThresh: number[] = [];
  private readonly scratch = new THREE.Vector3();
  private readonly pyraTiles: PyraTile[] = [];
  /** Geometric 1:1 angle tracking for continuous layer drag. */
  private layerDragGeom: {
    session: LayerDragSession;
    u: THREE.Vector3;
    v: THREE.Vector3;
    axis: THREE.Vector3;
    lastAtan: number;
    angle: number;
    raycaster: THREE.Raycaster;
    ndc: THREE.Vector2;
  } | null = null;

  constructor(orderOrStyle: number | VisualStyle = 3, style: VisualStyle = 'sticker') {
    const order = typeof orderOrStyle === 'number' ? orderOrStyle : 3;
    const st = typeof orderOrStyle === 'number' ? style : orderOrStyle;
    super(st);
    this.order = THREE.MathUtils.clamp(Math.round(order), 2, 20);
    this.build();
    this.finishBuild();
    this.computeDepthThresholds();
  }

  getOrder(): number {
    return this.order;
  }

  /** Tip cut (depth 0 lower bound). */
  private tipThresh(): number {
    return this.depthThresh[0] ?? N3_TIP_THRESH;
  }

  /** Bottom cut (depth N-1 upper bound). */
  private bottomThresh(): number {
    return this.depthThresh[this.depthThresh.length - 1] ?? N3_DEEP_THRESH;
  }

  /**
   * Resolve move flags → depth index 0..order-1.
   * tip→0, bottom→N-1, bare (N≥3)→1 (classic deep), else depth field.
   */
  private resolveDepth(move: FaceTurnMove): number {
    if (move.depth !== undefined) {
      return THREE.MathUtils.clamp(Math.round(move.depth), 0, this.order - 1);
    }
    if (move.tip) return 0;
    if (move.bottom) return this.order - 1;
    // Classic deep mid-band for N=3; for N=2 default tip; else first mid shell.
    if (this.order <= 2) return 0;
    return 1;
  }

  /** Band membership: depth k contains projection d. */
  private depthOfProjection(d: number): number {
    const t = this.depthThresh;
    if (!t.length) return 0;
    if (d > t[0]) return 0;
    for (let k = 1; k < t.length; k++) {
      if (d > t[k]) return k;
    }
    return this.order - 1;
  }

  private inDepth(d: number, depth: number): boolean {
    return this.depthOfProjection(d) === depth;
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

    this.buildSegmentedCore(vertices);

    const n = this.order;
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
      const p = (i: number, j: number) =>
        a
          .clone()
          .add(b.clone().sub(a).multiplyScalar(i / n))
          .add(c.clone().sub(a).multiplyScalar(j / n))
          .add(off);

      const tipDepthOf = (rowA: number, rowB: number, rowC: number): number[] => {
        const td = [n - 1, n - 1, n - 1, n - 1];
        td[ta] = rowA;
        td[tb] = rowB;
        td[tc] = rowC;
        return td;
      };

      const addTri = (
        v0: THREE.Vector3,
        v1: THREE.Vector3,
        v2: THREE.Vector3,
        tipPiece: number,
        tipDepth: number[],
      ) => {
        const centroid = v0.clone().add(v1).add(v2).multiplyScalar(1 / 3);
        const shrink = (v: THREE.Vector3) => centroid.clone().lerp(v, STICKER_SHRINK);
        const geo = new THREE.BufferGeometry().setFromPoints([shrink(v0), shrink(v1), shrink(v2)]);
        geo.setIndex([0, 1, 2]);
        geo.computeVertexNormals();

        let nearest = 0;
        let best = -Infinity;
        for (let k = 0; k < 4; k++) {
          const d = centroid.dot(this.faces[k].axis);
          if (d > best) {
            best = d;
            nearest = k;
          }
        }

        this.addTile(geo, COLORS[faceIndex], IDS[nearest]);
        const tile = this.tiles[this.tiles.length - 1] as PyraTile;
        tile.tipPiece = tipPiece;
        tile.faceIndex = faceIndex;
        tile.tipDepth = tipDepth;
        tile.mesh.userData.tipPiece = tipPiece;
        tile.mesh.userData.faceIndex = faceIndex;
        tile.mesh.userData.tipDepth = tipDepth;
        tile.mesh.material.polygonOffset = true;
        tile.mesh.material.polygonOffsetFactor = -4;
        tile.mesh.material.polygonOffsetUnits = -4;
        tile.mesh.renderOrder = 1;
        this.pyraTiles.push(tile);
      };

      // Up-pointing cells: corners at (0,0)->tip a, (n,0)->tip b, (0,n)->tip c.
      // Discrete tip-row: from a = i+j; from b = n-1-i; from c = n-1-j.
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n - i; j++) {
          let tipPiece = -1;
          if (i === 0 && j === 0) tipPiece = ta;
          else if (i === n - 1 && j === 0) tipPiece = tb;
          else if (i === 0 && j === n - 1) tipPiece = tc;
          addTri(
            p(i, j),
            p(i + 1, j),
            p(i, j + 1),
            tipPiece,
            tipDepthOf(i + j, n - 1 - i, n - 1 - j),
          );
        }
      }
      // Down-pointing fillers — not tip stickers.
      // Discrete tip-row: from a = i+j+1; from b = n-1-i; from c = n-1-j.
      for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < n - 1 - i; j++) {
          addTri(
            p(i + 1, j),
            p(i + 1, j + 1),
            p(i, j + 1),
            -1,
            tipDepthOf(i + j + 1, n - 1 - i, n - 1 - j),
          );
        }
      }
    }
  }

  /**
   * Build depthThresh from discrete tip-row bands (tipDepth), not equal-fraction
   * analytic planes through sticker centroids.
   * Up/down facelets in one grid row share tipDepth, so cuts sit in the gaps
   * between row slabs and stay planar at high N (centroid planes sawtooth).
   * N=3 keeps classic 1.5 / 0.4 (verify + feel).
   */
  private computeDepthThresholds(): void {
    if (this.order === 3) {
      this.depthThresh = [N3_TIP_THRESH, N3_DEEP_THRESH];
      return;
    }
    this.group.updateMatrixWorld(true);
    const axis = this.faces[0].axis;
    const N = this.order;
    const bandMin = Array.from({ length: N }, () => Infinity);
    const bandMax = Array.from({ length: N }, () => -Infinity);
    for (const tile of this.pyraTiles) {
      const d = this.tileWorldCenter(tile, this.scratch).dot(axis);
      const band = tile.tipDepth[0];
      if (d < bandMin[band]) bandMin[band] = d;
      if (d > bandMax[band]) bandMax[band] = d;
    }
    const thresh: number[] = [];
    for (let k = 0; k < N - 1; k++) {
      const hi = bandMin[k];
      const lo = bandMax[k + 1];
      if (!Number.isFinite(hi) || !Number.isFinite(lo)) {
        // Fallback: analytic tip→face fraction (should not hit when bands are full).
        const tipP = 2.7;
        const faceP = -2.7 / 3;
        thresh.push(tipP + (faceP - tipP) * ((k + 1) / N));
      } else {
        thresh.push((hi + lo) / 2);
      }
    }
    this.depthThresh = thresh;
  }

  /**
   * Lock depth band + tip axis from a hit (no screen delta needed).
   * World tip resolve for depth 0; opposite-face / far-band → bottom; else mid band.
   */
  resolveLayerAtHit(
    mesh: THREE.Mesh,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    camera: THREE.Camera,
  ): { face: string; tip?: boolean; bottom?: boolean; depth: number } | null {
    this.group.updateMatrixWorld(true);

    const tipPiece = Number(mesh.userData.tipPiece ?? -1);
    const faceIndex = Number(mesh.userData.faceIndex ?? -1);
    const camPos = camera.position;
    const tipCut = this.tipThresh();
    const botCut = this.bottomThresh();

    let chosen: PolyFace | null = null;
    let depth = Math.min(1, this.order - 1);

    let tipByPos: PolyFace | null = null;
    let tipDot = tipCut;
    for (const f of this.faces) {
      const d = point.dot(f.axis);
      if (d > tipDot) {
        tipDot = d;
        tipByPos = f;
      }
    }
    if (tipByPos) {
      if (tipPiece >= 0 && tipPiece < this.faces.length) {
        const hinted = this.faces[tipPiece];
        if (hinted.id === tipByPos.id && point.dot(hinted.axis) > tipCut) {
          chosen = hinted;
        } else {
          chosen = tipByPos;
        }
      } else {
        chosen = tipByPos;
      }
      depth = 0;
    } else {
      // Opposite-face non-tip, viewed from outside → bottom about that tip.
      if (faceIndex >= 0 && faceIndex < this.faces.length) {
        const opp = this.faces[faceIndex];
        const align = camPos.dot(opp.axis);
        const viewingOpp =
          align < 0 &&
          this.faces.every(
            (f, i) => i === faceIndex || camPos.dot(f.axis) > align + 1e-6,
          );
        if (viewingOpp) {
          chosen = opp;
          depth = this.order - 1;
        }
      }

      if (!chosen) {
        let up: PolyFace | null = null;
        let upDot = -Infinity;
        let unique = false;
        for (const f of this.faces) {
          const d = camPos.dot(f.axis);
          if (d > upDot + 1e-6) {
            upDot = d;
            up = f;
            unique = true;
          } else if (Math.abs(d - upDot) <= 1e-6) {
            unique = false;
          }
        }
        if (up && unique && point.dot(up.axis) <= botCut) {
          chosen = up;
          depth = this.order - 1;
        }
      }

      if (!chosen) {
        const candidates: PolyFace[] = [];
        for (const f of this.faces) {
          const d = point.dot(f.axis);
          const band = this.depthOfProjection(d);
          if (band > 0 && band < this.order - 1) candidates.push(f);
          else if (this.order === 2 && band === 0) candidates.push(f);
        }
        const resolved = this.resolveHitFace(point, normal);
        if (resolved && !candidates.some((c) => c.id === resolved.id)) {
          candidates.push(resolved);
        }
        if (!candidates.length) {
          // Fallback: any face with a defined mid/non-tip band at hit.
          for (const f of this.faces) {
            const band = this.depthOfProjection(point.dot(f.axis));
            if (band !== 0) candidates.push(f);
          }
        }
        if (!candidates.length) return null;
        if (resolved && candidates.some((c) => c.id === resolved.id)) {
          chosen = resolved;
        } else {
          chosen = candidates[0];
          let best = point.dot(chosen.axis);
          for (const f of candidates) {
            const d = point.dot(f.axis);
            if (d > best) {
              best = d;
              chosen = f;
            }
          }
        }
        depth = this.depthOfProjection(point.dot(chosen.axis));
        if (depth === 0) depth = Math.min(1, this.order - 1);
      }
    }

    if (!chosen) return null;
    if (mesh.userData) mesh.userData.turnFace = chosen.id;
    return this.packLayer(chosen.id, depth);
  }

  private packLayer(
    face: string,
    depth: number,
  ): { face: string; tip?: boolean; bottom?: boolean; depth: number } {
    const d = THREE.MathUtils.clamp(depth, 0, this.order - 1);
    return {
      face,
      depth: d,
      ...(d === 0 ? { tip: true } : {}),
      ...(d === this.order - 1 ? { bottom: true } : {}),
    };
  }

  beginLayerDrag(pick: PuzzlePick, camera: THREE.Camera): LayerDragSession | null {
    if (this.isBusy()) return null;
    const layer = this.resolveLayerAtHit(pick.mesh, pick.point, pick.faceNormal, camera);
    if (!layer) return null;
    if (!this.beginInteractiveTurn(layer)) return null;

    const axis = this.faceOf(layer.face).axis.clone();
    const radial = pick.point.clone().addScaledVector(axis, -pick.point.dot(axis));
    const u = new THREE.Vector3();
    if (radial.lengthSq() > 1e-8) {
      u.copy(radial).normalize();
    } else {
      const view = camera.position.clone().sub(pick.point);
      u.crossVectors(axis, view);
      if (u.lengthSq() < 1e-8) u.set(1, 0, 0).cross(axis);
      if (u.lengthSq() < 1e-8) u.set(0, 1, 0).cross(axis);
      u.normalize();
    }
    const v = new THREE.Vector3().crossVectors(axis, u).normalize();
    const startAtan = Math.atan2(radial.dot(v), radial.dot(u));

    const session: LayerDragSession = {
      face: layer.face,
      depth: layer.depth,
      ...(layer.tip ? { tip: true } : {}),
      ...(layer.bottom ? { bottom: true } : {}),
    };
    this.layerDragGeom = {
      session,
      u,
      v,
      axis,
      lastAtan: startAtan,
      angle: 0,
      raycaster: new THREE.Raycaster(),
      ndc: new THREE.Vector2(),
    };
    return session;
  }

  updateLayerDrag(
    session: LayerDragSession,
    ndcX: number,
    ndcY: number,
    camera: THREE.Camera,
  ): void {
    const g = this.layerDragGeom;
    if (!g || g.session !== session) return;

    g.ndc.set(ndcX, ndcY);
    g.raycaster.setFromCamera(g.ndc, camera);
    const ray = g.raycaster.ray;
    const denom = ray.direction.dot(g.axis);
    if (Math.abs(denom) < 1e-10) return;
    const t = -ray.origin.dot(g.axis) / denom;
    const hit = ray.origin.clone().addScaledVector(ray.direction, t);
    const x = hit.dot(g.u);
    const y = hit.dot(g.v);
    if (x * x + y * y < 1e-12) return;
    const atan = Math.atan2(y, x);
    let delta = atan - g.lastAtan;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    g.lastAtan = atan;
    g.angle += delta;
    this.setInteractiveAngle(g.angle);
  }

  async endLayerDrag(session: LayerDragSession): Promise<void> {
    const g = this.layerDragGeom;
    if (!g || g.session !== session) {
      this.cancelInteractiveTurn();
      this.layerDragGeom = null;
      return;
    }
    const angle = this.getInteractiveAngle();
    this.layerDragGeom = null;

    const step = (Math.PI * 2) / 3;
    const SNAP = Math.PI / 6; // 30°
    let steps = Math.round(angle / step);
    if (Math.abs(angle) < SNAP) {
      steps = 0;
    } else if (steps === 0) {
      steps = angle > 0 ? 1 : -1;
    }
    while (steps > 2) steps -= 3;
    while (steps < -2) steps += 3;

    await this.finishInteractiveTurn(steps);
  }

  cancelLayerDrag(session: LayerDragSession): void {
    if (this.layerDragGeom && this.layerDragGeom.session === session) {
      this.layerDragGeom = null;
    }
    this.cancelInteractiveTurn();
  }

  /**
   * Swipe → tip-axis turn with depth band (尖 / 层… / 底).
   * Same tip / opposite / far-band / mid rules as resolveLayerAtHit, plus swipe scoring.
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
    const faceIndex = Number(mesh.userData.faceIndex ?? -1);
    const p0 = point.clone().project(camera);
    const radial = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    const camPos = camera.position;
    const tipCut = this.tipThresh();
    const botCut = this.bottomThresh();

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
    let depth = Math.min(1, this.order - 1);

    let tipByPos: PolyFace | null = null;
    let tipDot = tipCut;
    for (const f of this.faces) {
      const d = point.dot(f.axis);
      if (d > tipDot) {
        tipDot = d;
        tipByPos = f;
      }
    }
    if (tipByPos) {
      if (tipPiece >= 0 && tipPiece < this.faces.length) {
        const hinted = this.faces[tipPiece];
        if (hinted.id === tipByPos.id && point.dot(hinted.axis) > tipCut) {
          chosen = hinted;
        } else {
          chosen = tipByPos;
        }
      } else {
        chosen = tipByPos;
      }
      depth = 0;
    } else {
      if (faceIndex >= 0 && faceIndex < this.faces.length) {
        const opp = this.faces[faceIndex];
        const align = camPos.dot(opp.axis);
        const viewingOpp =
          align < 0 &&
          this.faces.every(
            (f, i) => i === faceIndex || camPos.dot(f.axis) > align + 1e-6,
          );
        if (viewingOpp) {
          chosen = opp;
          depth = this.order - 1;
        }
      }

      if (!chosen) {
        let up: PolyFace | null = null;
        let upDot = -Infinity;
        let unique = false;
        for (const f of this.faces) {
          const d = camPos.dot(f.axis);
          if (d > upDot + 1e-6) {
            upDot = d;
            up = f;
            unique = true;
          } else if (Math.abs(d - upDot) <= 1e-6) {
            unique = false;
          }
        }
        if (up && unique && point.dot(up.axis) <= botCut) {
          chosen = up;
          depth = this.order - 1;
        }
      }

      if (!chosen) {
        const candidates: PolyFace[] = [];
        for (const f of this.faces) {
          const d = point.dot(f.axis);
          const band = this.depthOfProjection(d);
          if (band > 0 && band < this.order - 1) candidates.push(f);
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
        depth = this.depthOfProjection(point.dot(chosen.axis));
        if (depth === 0) depth = Math.min(1, this.order - 1);
      }
    }

    if (!chosen) return null;
    const scored = scoreOnTip(chosen);
    if (!scored || scored.score < 1e-6) return null;

    if (mesh.userData) mesh.userData.turnFace = chosen.id;
    const packed = this.packLayer(chosen.id, depth);
    return {
      kind: 'face',
      face: packed.face,
      steps: scored.steps,
      depth: packed.depth,
      ...(packed.tip ? { tip: true } : {}),
      ...(packed.bottom ? { bottom: true } : {}),
    };
  }

  /**
   * Subdivide the recessed tetrahedron into small tetras, tagged by band along
   * each tip axis (same thresholds as facelets).
   */
  private buildSegmentedCore(tipVertices: THREE.Vector3[]): void {
    const V = tipVertices.map((v) => v.clone().normalize().multiplyScalar(CORE_RADIUS));
    type Tet = [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
    const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
    const subdivide = (tet: Tet): Tet[] => {
      const [a, b, c, d] = tet;
      const ab = mid(a, b);
      const ac = mid(a, c);
      const ad = mid(a, d);
      const bc = mid(b, c);
      const bd = mid(b, d);
      const cd = mid(c, d);
      return [
        [a, ab, ac, ad],
        [b, ab, bc, bd],
        [c, ac, bc, cd],
        [d, ad, bd, cd],
        [ab, ac, ad, cd],
        [ab, ad, bd, cd],
        [ab, bd, bc, cd],
        [ab, bc, ac, cd],
      ];
    };

    let tets: Tet[] = [[V[0], V[1], V[2], V[3]]];
    // Finer core for higher N so tip bands still get several pieces.
    // Cap at 4 subdivision levels (4096 tets); enough tip-band cores up to N=20.
    const levels = this.order <= 3 ? 3 : 4;
    for (let level = 0; level < levels; level++) tets = tets.flatMap(subdivide);

    const material = new THREE.MeshStandardMaterial({
      color: 0x8b929c,
      roughness: 0.85,
      metalness: 0.0,
      flatShading: true,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });

    const tetGeometry = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
      const centroid = a.clone().add(b).add(c).add(d).multiplyScalar(0.25);
      const pushFace = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, out: THREE.Vector3[]) => {
        const n = new THREE.Vector3().crossVectors(q.clone().sub(p), r.clone().sub(p));
        if (n.dot(p.clone().sub(centroid)) < 0) {
          out.push(p, r, q);
        } else {
          out.push(p, q, r);
        }
      };
      const verts: THREE.Vector3[] = [];
      pushFace(a, b, c, verts);
      pushFace(a, b, d, verts);
      pushFace(a, c, d, verts);
      pushFace(b, c, d, verts);
      const geo = new THREE.BufferGeometry().setFromPoints(verts);
      geo.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      geo.computeVertexNormals();
      return geo;
    };

    for (const [a, b, c, d] of tets) {
      const centroid = a.clone().add(b).add(c).add(d).multiplyScalar(0.25);
      const mesh = new THREE.Mesh(tetGeometry(a, b, c, d), material);
      mesh.renderOrder = -1;
      mesh.userData.coreCentroidLocal = centroid.clone();
      this.group.add(mesh);
      this.corePieces.push({ mesh, initialMatrix: new THREE.Matrix4() });
    }
  }

  private coreWorldCenter(mesh: THREE.Mesh, target = new THREE.Vector3()): THREE.Vector3 {
    const local = mesh.userData.coreCentroidLocal as THREE.Vector3 | undefined;
    if (local) return target.copy(local).applyMatrix4(mesh.matrixWorld);
    const attr = mesh.geometry.getAttribute('position');
    target.set(0, 0, 0);
    for (let i = 0; i < attr.count; i++) {
      target.add(new THREE.Vector3().fromBufferAttribute(attr as THREE.BufferAttribute, i));
    }
    return target.multiplyScalar(1 / Math.max(1, attr.count)).applyMatrix4(mesh.matrixWorld);
  }

  protected selectCore(move: FaceTurnMove): THREE.Object3D[] {
    this.group.updateMatrixWorld(true);
    const axis = this.faceOf(move.face).axis;
    const scratch = this.scratch;
    const depth = this.resolveDepth(move);
    return this.corePieces
      .filter((cp) => {
        const band = this.depthOfProjection(this.coreWorldCenter(cp.mesh, scratch).dot(axis));
        return band === depth;
      })
      .map((cp) => cp.mesh);
  }

  protected selectLayer(move: FaceTurnMove): PolyTile[] {
    this.group.updateMatrixWorld(true);
    const axis = this.faceOf(move.face).axis;
    const depth = this.resolveDepth(move);
    // Thin slice only: depth k turns band k alone (not tip-cap 0..k).
    // Thresholds sit in mid-gaps of discrete tipDepth row slabs, so centroid
    // projection cannot split an up/down pair in the same geometric row —
    // planar cuts without sawtooth even for thin mid rings at high N.
    return this.tiles.filter((tile) => {
      const band = this.depthOfProjection(this.tileWorldCenter(tile, this.scratch).dot(axis));
      return band === depth;
    });
  }

  protected turnAngle(move: FaceTurnMove): number {
    return move.steps * ((Math.PI * 2) / 3);
  }

  protected scrambleLength(): number {
    return Math.min(8 + this.order * 2, 60);
  }

  /** Scramble: random tip + random depth band. */
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
      const depth = Math.floor(Math.random() * this.order);
      const packed = this.packLayer(face, depth);
      moves.push({
        kind: 'face',
        face,
        steps: Math.random() < 0.5 ? 1 : -1,
        depth: packed.depth,
        ...(packed.tip ? { tip: true } : {}),
        ...(packed.bottom ? { bottom: true } : {}),
      });
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
    const buttons: FaceButton[] = [];
    for (let depth = 0; depth < this.order; depth++) {
      for (const f of this.faces) {
        const packed = this.packLayer(f.id, depth);
        let label: string;
        if (this.order === 3) {
          label = depth === 0 ? `${f.label}尖` : depth === 2 ? `${f.label}底` : `${f.label}层`;
        } else if (depth === 0) {
          label = `${f.label}尖`;
        } else if (depth === this.order - 1) {
          label = `${f.label}底`;
        } else {
          label = `${f.label}${depth}`;
        }
        buttons.push({
          id: f.id,
          label,
          color: f.colorCss,
          depth: packed.depth,
          ...(packed.tip ? { tip: true } : {}),
          ...(packed.bottom ? { bottom: true } : {}),
        });
      }
    }
    return buttons;
  }

  /** Test helper: layer sizes and C3 slot closure (no animation). */
  debugVerifyLayers(): {
    tipCount: number;
    deepCount: number;
    bottomCount: number;
    tipClosed: boolean;
    deepClosed: boolean;
    bottomClosed: boolean;
    tipLeavesMid: boolean;
    deepLeavesTip: boolean;
    bottomLeavesTip: boolean;
    bottomLeavesMid: boolean;
    deepRoundTrip: boolean;
    bottomRoundTrip: boolean;
    order: number;
    bandCounts: number[];
    planarCuts: boolean;
    discreteMatch: boolean;
  } {
    this.group.updateMatrixWorld(true);
    const axis = this.faces[0].axis;
    const slots = this.tiles.map((t) => this.tileWorldCenter(t).clone());
    const tip = this.tiles.filter((t) => this.inDepth(this.tileWorldCenter(t, this.scratch).dot(axis), 0));
    const deepDepth = Math.min(1, this.order - 1);
    const deep = this.tiles.filter((t) =>
      this.inDepth(this.tileWorldCenter(t, this.scratch).dot(axis), deepDepth),
    );
    const bottom = this.tiles.filter((t) =>
      this.inDepth(this.tileWorldCenter(t, this.scratch).dot(axis), this.order - 1),
    );
    const q = new THREE.Quaternion().setFromAxisAngle(axis, (Math.PI * 2) / 3);
    const closed = (sel: PolyTile[]) =>
      sel.every((t) => {
        const dest = this.tileWorldCenter(t).applyQuaternion(q);
        return slots.some((s) => s.distanceTo(dest) < 0.08);
      });
    const tipSet = new Set(tip);
    const deepSet = new Set(deep);
    const bottomSet = new Set(bottom);
    const tipLeavesMid = deep.every((t) => !tipSet.has(t));
    const deepLeavesTip = tip.every((t) => !deepSet.has(t));
    const bottomLeavesTip = tip.every((t) => !bottomSet.has(t));
    const bottomLeavesMid = deep.every((t) => !bottomSet.has(t));

    const roundTrip = (sel: PolyTile[]) => {
      for (const t of sel) {
        const c = this.tileWorldCenter(t).clone();
        c.applyQuaternion(q).applyQuaternion(q).applyQuaternion(q);
        if (c.distanceTo(this.tileWorldCenter(t)) > 0.08) return false;
      }
      return true;
    };
    const bandCounts = Array.from({ length: this.order }, (_, d) =>
      this.tiles.filter((t) => this.inDepth(this.tileWorldCenter(t, this.scratch).dot(axis), d)).length,
    );
    // Planar cut check: adjacent bands must not interleave in tip-axis projection.
    let planarCuts = true;
    for (let d = 0; d < this.order - 1; d++) {
      const a = this.tiles
        .filter((t) => this.inDepth(this.tileWorldCenter(t, this.scratch).dot(axis), d))
        .map((t) => this.tileWorldCenter(t, this.scratch).dot(axis));
      const b = this.tiles
        .filter((t) => this.inDepth(this.tileWorldCenter(t, this.scratch).dot(axis), d + 1))
        .map((t) => this.tileWorldCenter(t, this.scratch).dot(axis));
      if (!a.length || !b.length) {
        planarCuts = false;
        break;
      }
      if (Math.min(...a) <= Math.max(...b)) {
        planarCuts = false;
        break;
      }
    }
    // Discrete tipDepth vs projection band agreement (solved state).
    let discreteMatch = true;
    for (const tile of this.pyraTiles) {
      const projBand = this.depthOfProjection(this.tileWorldCenter(tile, this.scratch).dot(axis));
      if (tile.tipDepth[0] !== projBand) {
        discreteMatch = false;
        break;
      }
    }
    return {
      tipCount: tip.length,
      deepCount: deep.length,
      bottomCount: bottom.length,
      tipClosed: closed(tip),
      deepClosed: closed(deep),
      bottomClosed: closed(bottom),
      tipLeavesMid,
      deepLeavesTip,
      bottomLeavesTip,
      bottomLeavesMid,
      deepRoundTrip: roundTrip(deep),
      bottomRoundTrip: roundTrip(bottom),
      order: this.order,
      bandCounts,
      planarCuts,
      discreteMatch,
    };
  }

  /** Threshold accessors for verify scripts. */
  debugThresholds(): { tip: number; bottom: number; all: number[] } {
    return { tip: this.tipThresh(), bottom: this.bottomThresh(), all: [...this.depthThresh] };
  }
}
