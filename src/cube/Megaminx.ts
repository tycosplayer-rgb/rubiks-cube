import * as THREE from 'three';
import { PolyPuzzle, type PolyFace, type PolyTile } from './PolyPuzzle';
import type { AnyMove, FaceTurnMove, VisualStyle } from './puzzle';

const COLORS = [
  0xf5f5f5, 0xc41e3a, 0x1646c4, 0xffd500, 0x7b2cbf, 0x009e60,
  0xff8c00, 0x69d2e7, 0xff69b4, 0x8b4513, 0x9acd32, 0x808080,
];
const CSS = COLORS.map((c) => `#${c.toString(16).padStart(6, '0')}`);
const IDS = ['U', 'R', 'FR', 'DR', 'D', 'DL', 'L', 'FL', 'BR', 'B', 'BL', 'DB'];

/** Center pentagon radius as fraction of outer vertex distance from face center (N=3). */
const INNER_SCALE_N3 = 0.40;
/** Corner tip depth along each outer edge (fraction of edge length from the vertex). */
const CORNER_EDGE_T = 0.32;
/** Geometry inset for grooves (keep gaps via mesh, not styleScale). */
const STICKER_SHRINK = 0.992;
/** Push facelets outward along normals so spinning layers clear the core. */
const FACELET_OUTSET = 0.065;
/** Core circumradius — smaller than sticker shell to avoid mid-turn peek / clip. */
const CORE_RADIUS = 2.32;
/** Merge dodecahedron vertices closer than this into one canonical point. */
const VERT_EPS = 1e-4;
/**
 * Stickers currently on a face project ~2.19 onto the face axis; the next
 * band (adjacent-face ring) is ~1.84. Midway cut selects the on-face stickers.
 */
const FACE_LAYER_THRESH = 2.0;

interface FoundFace {
  normal: THREE.Vector3;
  points: THREE.Vector3[];
}

interface MegaTile extends PolyTile {
  pieceId: string;
  kind: 'center' | 'edge' | 'corner' | 'ring';
  faceIndex: number;
}

/**
 * Dodecahedron Megaminx, orders 2–7.
 * N=3: classic star-cut (1 center + 5 edges + 5 corners).
 * N=2: Junior-like corners only.
 * N≥4: center + inner face-local rings + outer shared corners/edges.
 * Face turns 72°; one outer face layer per turn (whole on-face stickers + piece expand).
 */
export class Megaminx extends PolyPuzzle {
  readonly puzzleType = 'megaminx' as const;
  private readonly order: number;
  private readonly megaTiles: MegaTile[] = [];
  private readonly scratch = new THREE.Vector3();

  constructor(orderOrStyle: number | VisualStyle = 3, style: VisualStyle = 'sticker') {
    const order = typeof orderOrStyle === 'number' ? orderOrStyle : 3;
    const st = typeof orderOrStyle === 'number' ? style : orderOrStyle;
    super(st);
    this.order = THREE.MathUtils.clamp(Math.round(order), 2, 7);
    this.build();
    this.finishBuild();
  }

  getOrder(): number {
    return this.order;
  }

  /** No styleScale inflate — avoids full-color z-fighting; grooves come from inset. */
  protected styleScale(): number {
    return 1;
  }

  private build(): void {
    const source = new THREE.DodecahedronGeometry(2.7, 0);
    const pos = source.getAttribute('position');

    const canon: THREE.Vector3[] = [];
    const snap = (v: THREE.Vector3): THREE.Vector3 => {
      for (const c of canon) {
        if (c.distanceToSquared(v) < VERT_EPS * VERT_EPS) return c;
      }
      const n = v.clone();
      canon.push(n);
      return n;
    };

    const found: FoundFace[] = [];
    for (let i = 0; i < pos.count; i += 3) {
      const a = snap(new THREE.Vector3().fromBufferAttribute(pos, i));
      const b = snap(new THREE.Vector3().fromBufferAttribute(pos, i + 1));
      const c = snap(new THREE.Vector3().fromBufferAttribute(pos, i + 2));
      const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
      if (n.dot(a) < 0) n.negate();
      let face = found.find((f) => f.normal.dot(n) > 0.999);
      if (!face) {
        face = { normal: n.clone(), points: [] };
        found.push(face);
      }
      for (const v of [a, b, c]) {
        if (!face.points.includes(v)) face.points.push(v);
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
      new THREE.DodecahedronGeometry(CORE_RADIUS, 0),
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

    const vertId = new Map<THREE.Vector3, number>();
    canon.forEach((v, i) => vertId.set(v, i));
    const edgeId = (a: THREE.Vector3, b: THREE.Vector3): string => {
      const ia = vertId.get(a)!;
      const ib = vertId.get(b)!;
      return ia < ib ? `${ia}-${ib}` : `${ib}-${ia}`;
    };

    found.forEach((f, faceIndex) => {
      this.buildFace(f, faceIndex, vertId, edgeId);
    });
  }

  private buildFace(
    f: FoundFace,
    faceIndex: number,
    vertId: Map<THREE.Vector3, number>,
    edgeId: (a: THREE.Vector3, b: THREE.Vector3) => string,
  ): void {
    const faceId = IDS[faceIndex];
    const center = f.points
      .reduce((sum, p) => sum.add(p), new THREE.Vector3())
      .multiplyScalar(1 / f.points.length);
    const normal = f.normal.clone().normalize();
    const u = f.points[0].clone().sub(center).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();

    const raw = [...f.points].sort((a, b) => {
      const aa = Math.atan2(a.clone().sub(center).dot(v), a.clone().sub(center).dot(u));
      const bb = Math.atan2(b.clone().sub(center).dot(v), b.clone().sub(center).dot(u));
      return aa - bb;
    });

    const points = raw.map((p) => p.clone().addScaledVector(normal, FACELET_OUTSET));
    const c = center.clone().addScaledVector(normal, FACELET_OUTSET);

    const addPoly = (
      poly: THREE.Vector3[],
      pieceId: string,
      kind: MegaTile['kind'],
    ) => {
      const mid = poly.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / poly.length);
      const inset = poly.map((p) => mid.clone().lerp(p, STICKER_SHRINK));
      const verts: THREE.Vector3[] = [];
      for (let k = 1; k < inset.length - 1; k++) verts.push(inset[0], inset[k], inset[k + 1]);
      const geo = new THREE.BufferGeometry().setFromPoints(verts);
      geo.computeVertexNormals();
      this.addTile(geo, COLORS[faceIndex], faceId);
      const tile = this.tiles[this.tiles.length - 1] as MegaTile;
      tile.pieceId = pieceId;
      tile.kind = kind;
      tile.faceIndex = faceIndex;
      tile.mesh.userData.pieceId = pieceId;
      tile.mesh.userData.kind = kind;
      tile.mesh.userData.faceIndex = faceIndex;
      tile.mesh.material.polygonOffset = true;
      tile.mesh.material.polygonOffsetFactor = -4;
      tile.mesh.material.polygonOffsetUnits = -4;
      tile.mesh.renderOrder = 1;
      this.megaTiles.push(tile);
    };

    const N = this.order;

    if (N === 2) {
      // Junior-like: 5 corner kites meeting at center (no separate center/edges).
      for (let i = 0; i < 5; i++) {
        const i0 = (i + 4) % 5;
        const i1 = (i + 1) % 5;
        const Vi = points[i];
        const midPrev = Vi.clone().lerp(points[i0], 0.5);
        const midNext = Vi.clone().lerp(points[i1], 0.5);
        const cornerId = `corner:${vertId.get(raw[i])}`;
        addPoly([Vi, midNext, c, midPrev], cornerId, 'corner');
      }
      return;
    }

    if (N === 3) {
      // Exact classic star cut.
      const inner = points.map((p) => c.clone().lerp(p, INNER_SCALE_N3));
      const centerId = `center:${faceId}`;
      addPoly(inner, centerId, 'center');

      for (let i = 0; i < 5; i++) {
        const i1 = (i + 1) % 5;
        const i0 = (i + 4) % 5;
        const Vi = points[i];
        const Vprev = points[i0];
        const Vnext = points[i1];

        const cutPrev = Vi.clone().lerp(Vprev, CORNER_EDGE_T);
        const cutNext = Vi.clone().lerp(Vnext, CORNER_EDGE_T);
        const cutNearI = Vi.clone().lerp(points[i1], CORNER_EDGE_T);
        const cutNearI1 = points[i1].clone().lerp(Vi, CORNER_EDGE_T);

        const cornerId = `corner:${vertId.get(raw[i])}`;
        addPoly([Vi, cutNext, inner[i], cutPrev], cornerId, 'corner');

        const eId = `edge:${edgeId(raw[i], raw[i1])}`;
        addPoly([cutNearI, cutNearI1, inner[i1], inner[i]], eId, 'edge');
      }
      return;
    }

    // N ≥ 4: center + (N-3) inner face-local rings + outer shared corners/edges.
    // Ring scales from center outward; outer ring uses classic corner/edge cut.
    const ringCount = N - 2; // number of inset boundaries before outer (incl. center edge)
    // scales[0] = center outer edge; scales[ringCount-1] = outer-ring inner edge
    const scales: number[] = [];
    for (let k = 1; k <= ringCount; k++) {
      // Spread from ~0.22 toward ~0.55 so outer corners stay similar size to N=3.
      scales.push(0.18 + (0.55 - 0.18) * (k / ringCount));
    }
    const inners = scales.map((s) => points.map((p) => c.clone().lerp(p, s)));

    // Center pentagon
    addPoly(inners[0], `center:${faceId}`, 'center');

    // Intermediate rings (face-local): trapezoids between consecutive scales.
    for (let r = 0; r < ringCount - 1; r++) {
      const inner = inners[r];
      const outer = inners[r + 1];
      for (let i = 0; i < 5; i++) {
        const i1 = (i + 1) % 5;
        // Split each trapezoid into an "edge" quad + optional — keep one quad per sector
        // for density ~O(N), plus corner wedges for star look.
        const midOuter = outer[i].clone().lerp(outer[i1], 0.5);
        const midInner = inner[i].clone().lerp(inner[i1], 0.5);
        // Edge-ish mid piece
        addPoly(
          [outer[i], midOuter, midInner, inner[i]],
          `ring:${faceId}:${r}:a:${i}`,
          'ring',
        );
        addPoly(
          [midOuter, outer[i1], inner[i1], midInner],
          `ring:${faceId}:${r}:b:${i}`,
          'ring',
        );
      }
    }

    // Outer ring: shared corners + edges against innermost = inners[last]
    const inner = inners[ringCount - 1];
    for (let i = 0; i < 5; i++) {
      const i1 = (i + 1) % 5;
      const i0 = (i + 4) % 5;
      const Vi = points[i];
      const Vprev = points[i0];
      const Vnext = points[i1];

      const cutPrev = Vi.clone().lerp(Vprev, CORNER_EDGE_T);
      const cutNext = Vi.clone().lerp(Vnext, CORNER_EDGE_T);
      const cutNearI = Vi.clone().lerp(points[i1], CORNER_EDGE_T);
      const cutNearI1 = points[i1].clone().lerp(Vi, CORNER_EDGE_T);

      const cornerId = `corner:${vertId.get(raw[i])}`;
      addPoly([Vi, cutNext, inner[i], cutPrev], cornerId, 'corner');

      const eId = `edge:${edgeId(raw[i], raw[i1])}`;
      addPoly([cutNearI, cutNearI1, inner[i1], inner[i]], eId, 'edge');
    }
  }

  /**
   * Current face under the finger: prefer outward normal alignment, then
   * hit-point projection. Never use build-time userData.turnFace after moves.
   */
  protected resolveHitFace(point: THREE.Vector3, normal?: THREE.Vector3): PolyFace | null {
    if (!this.faces.length) return null;
    if (normal && normal.lengthSq() > 1e-12) {
      const n = normal.clone().normalize();
      let best = this.faces[0];
      let bestDot = -Infinity;
      for (const f of this.faces) {
        const d = f.axis.dot(n);
        if (d > bestDot) {
          bestDot = d;
          best = f;
        }
      }
      return best;
    }
    let best = this.faces[0];
    let bestDot = -Infinity;
    for (const f of this.faces) {
      const d = point.dot(f.axis);
      if (d > bestDot) {
        bestDot = d;
        best = f;
      }
    }
    return best;
  }

  /**
   * Swipe → which face to turn (edge → side face / 棱→侧面).
   * For N=2 (corners only) and ring stickers, fall back to front-face turn.
   */
  dragToMove(
    mesh: THREE.Mesh,
    normal: THREE.Vector3,
    delta: THREE.Vector2,
    camera: THREE.Camera,
    point: THREE.Vector3,
  ): AnyMove | null {
    if (delta.lengthSq() < 1) return null;

    const pieceId = String(mesh.userData.pieceId ?? '');
    const stickerKind = mesh.userData.kind as MegaTile['kind'] | undefined;
    const front = this.resolveHitFace(point, normal);
    if (!front && !pieceId) return null;

    this.group.updateMatrixWorld(true);
    const containing: PolyFace[] = [];
    if (pieceId) {
      const pieceTiles = this.megaTiles.filter((t) => t.pieceId === pieceId);
      for (const f of this.faces) {
        if (pieceTiles.some((t) => this.tileWorldCenter(t, this.scratch).dot(f.axis) > FACE_LAYER_THRESH)) {
          containing.push(f);
        }
      }
    }

    let chosen: PolyFace | null = null;
    let scoreCandidates: PolyFace[] | null = null;

    if (stickerKind === 'center' || stickerKind === 'ring' || (!stickerKind && front)) {
      chosen = front ?? containing[0] ?? null;
    } else if (stickerKind === 'edge') {
      const sides = containing.filter((f) => !front || f.id !== front.id);
      if (sides.length === 1) {
        chosen = sides[0];
      } else if (sides.length > 1) {
        scoreCandidates = sides;
      } else {
        return null;
      }
    } else if (stickerKind === 'corner') {
      const sides = containing.filter((f) => !front || f.id !== front.id);
      if (sides.length) scoreCandidates = sides;
      else chosen = front;
    } else {
      chosen = front;
    }

    const p0 = point.clone().project(camera);
    const radial = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const p1 = new THREE.Vector3();

    const scoreStepsOnFace = (f: PolyFace): { steps: 1 | -1; score: number } | null => {
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

    let bestFace: PolyFace | null = null;
    let bestSteps: 1 | -1 = 1;
    let bestScore = 0;

    if (scoreCandidates) {
      for (const f of scoreCandidates) {
        const r = scoreStepsOnFace(f);
        if (!r) continue;
        if (r.score > bestScore) {
          bestScore = r.score;
          bestFace = f;
          bestSteps = r.steps;
        }
      }
    } else if (chosen) {
      const r = scoreStepsOnFace(chosen);
      if (r) {
        bestFace = chosen;
        bestSteps = r.steps;
        bestScore = r.score;
      }
    }

    if (!bestFace || bestScore < 1e-6) return null;
    if (mesh.userData) mesh.userData.turnFace = bestFace.id;
    return { kind: 'face', face: bestFace.id, steps: bestSteps };
  }

  /**
   * Select stickers currently on the turned face (axis projection), then expand
   * to every sticker sharing those piece ids.
   */
  protected selectLayer(move: FaceTurnMove): PolyTile[] {
    this.group.updateMatrixWorld(true);
    const axis = this.faceOf(move.face).axis;
    const onFace = this.megaTiles.filter(
      (t) => this.tileWorldCenter(t, this.scratch).dot(axis) > FACE_LAYER_THRESH,
    );
    const pieces = new Set(onFace.map((t) => t.pieceId));
    return this.megaTiles.filter((t) => pieces.has(t.pieceId));
  }

  protected turnAngle(move: FaceTurnMove): number {
    return move.steps * ((Math.PI * 2) / 5);
  }

  protected scrambleLength(): number {
    return 16 + this.order * 4;
  }

  getFitDistance(): number {
    return 8.2;
  }

  getFloorY(): number {
    return -3.05;
  }

  /** Stickers whose centers currently sit on a face (proj > thresh). */
  stickersOnFace(faceId: string): MegaTile[] {
    this.group.updateMatrixWorld(true);
    const axis = this.faceOf(faceId).axis;
    return this.megaTiles.filter(
      (t) => this.tileWorldCenter(t, this.scratch).dot(axis) > FACE_LAYER_THRESH,
    );
  }

  /** Expected on-face sticker count for this order (solved). */
  expectedPerFace(): number {
    const N = this.order;
    if (N === 2) return 5;
    if (N === 3) return 11;
    // center + (N-3) rings × 10 + 5 corners + 5 edges
    return 1 + (N - 3) * 10 + 10;
  }

  /** Test helper: counts and C5 closure (no animation). */
  debugVerifyLayers(): {
    tiles: number;
    perFace: number;
    layerCount: number;
    centers: number;
    edges: number;
    corners: number;
    rings: number;
    layerClosed: boolean;
    fiveTurnClosed: boolean;
    pieceGraphOk: boolean;
    order: number;
  } {
    this.group.updateMatrixWorld(true);
    const faceId = this.faces[0].id;
    const axis = this.faces[0].axis;
    const selected = this.selectLayer({ kind: 'face', face: faceId, steps: 1 });
    const slots = this.tiles.map((t) => this.tileWorldCenter(t).clone());
    const q = new THREE.Quaternion().setFromAxisAngle(axis, (Math.PI * 2) / 5);
    const layerClosed = selected.every((t) => {
      const dest = this.tileWorldCenter(t).applyQuaternion(q);
      return slots.some((s) => s.distanceTo(dest) < 0.12);
    });
    let fiveTurnClosed = true;
    for (const t of selected) {
      const c = this.tileWorldCenter(t).clone();
      for (let i = 0; i < 5; i++) c.applyQuaternion(q);
      if (c.distanceTo(this.tileWorldCenter(t)) > 0.12) fiveTurnClosed = false;
    }
    const kinds = { center: 0, edge: 0, corner: 0, ring: 0 };
    for (const t of this.megaTiles) kinds[t.kind]++;

    const byPiece = new Map<string, number>();
    for (const t of this.megaTiles) byPiece.set(t.pieceId, (byPiece.get(t.pieceId) ?? 0) + 1);
    let pieceGraphOk = true;
    for (const [id, n] of byPiece) {
      if (id.startsWith('center:') && n !== 1) pieceGraphOk = false;
      if (id.startsWith('edge:') && n !== 2) pieceGraphOk = false;
      if (id.startsWith('corner:') && n !== 3) pieceGraphOk = false;
      if (id.startsWith('ring:') && n !== 1) pieceGraphOk = false;
    }
    if (this.order === 3) {
      pieceGraphOk =
        pieceGraphOk &&
        kinds.center === 12 &&
        byPiece.size === 12 + 30 + 20;
    } else if (this.order === 2) {
      pieceGraphOk = pieceGraphOk && kinds.corner === 60 && kinds.center === 0 && kinds.edge === 0;
    }

    const onFace = this.stickersOnFace(faceId).length;
    return {
      tiles: this.tiles.length,
      perFace: onFace,
      layerCount: selected.length,
      centers: kinds.center,
      edges: kinds.edge,
      corners: kinds.corner,
      rings: kinds.ring,
      layerClosed,
      fiveTurnClosed,
      pieceGraphOk,
      order: this.order,
    };
  }
}
