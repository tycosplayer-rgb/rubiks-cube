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
/** Even-N star tip radius (fraction from face center toward edge midpoint). */
const STAR_TIP_SCALE = 0.44;
/** Even-N star dent radius (fraction from face center toward vertex). */
const STAR_DENT_SCALE = 0.20;
/** Even-N split between inner ring band and outer edge band (0=at star, 1=at outer edge). */
const STAR_BAND_T = 0.48;
/** Geometry inset for grooves (keep gaps via mesh, not styleScale). */
const STICKER_SHRINK = 0.992;
/** Push facelets outward along normals so spinning layers clear the core. */
const FACELET_OUTSET = 0.065;
/** Core circumradius — smaller than sticker shell to avoid mid-turn peek / clip. */
const CORE_RADIUS = 2.32;
/** Merge dodecahedron vertices closer than this into one canonical point. */
const VERT_EPS = 1e-4;
/**
 * Stickers currently on a face project ~2.21 onto the face axis; adjacent-face
 * stickers sit lower (≤~2.06 even at N=6). Threshold midway selects on-face only.
 */
const FACE_LAYER_THRESH = 2.12;

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
 * N≥4 odd: barycentric sector grid with fixed center pentagon + rings.
 * N≥4 even: star-cut — black five-pointed star void (tips→edge midpoints),
 *       colored pieces in the bays; outer has N stickers/side (N−2 mid-edges).
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

    // Even orders: near-black core so the star-shaped sticker void reads as a
    // solid black ★ (tips→edge midpoints). Odd/N=3 keep neutral gray plastic.
    const coreColor = this.order % 2 === 0 ? 0x0a0a0a : 0x8b929c;
    this.core = new THREE.Mesh(
      new THREE.DodecahedronGeometry(CORE_RADIUS, 0),
      new THREE.MeshStandardMaterial({
        color: coreColor,
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

    // N ≥ 4: odd = center pentagon grid; even = star-cut (black star void).
    this.buildHigherFace(N, faceId, points, c, raw, vertId, edgeId, addPoly);
  }

  /**
   * Higher-order face geometry (N≥4).
   *
   * Odd N: triangular barycentric grid with fixed center pentagon + face-local
   * rings + outer corners/(N−2) mid-edges (Gigaminx / Teraminx style).
   *
   * Even N: explicit star-cut (generalizes N=3 INNER_SCALE / CORNER_EDGE_T):
   * - Innermost five-pointed star region has NO colored facelets so the
   *   near-black core shows through as a ★ (tips→edge midpoints), matching
   *   classic Megaminx / SENGSO 四阶五魔方 orientation (corners in notches).
   * - 2 face-local ring stickers per edge-bay wrap around each star tip.
   * - Outer band: 5 corners + (N−2) mid-edge stickers/side (exactly N along edge).
   * - Extra intermediate ring bands for N≥6 between star bay and outer band.
   */
  private buildHigherFace(
    N: number,
    faceId: string,
    points: THREE.Vector3[],
    c: THREE.Vector3,
    raw: THREE.Vector3[],
    vertId: Map<THREE.Vector3, number>,
    edgeId: (a: THREE.Vector3, b: THREE.Vector3) => string,
    addPoly: (poly: THREE.Vector3[], pieceId: string, kind: MegaTile['kind']) => void,
  ): void {
    if (N % 2 === 0) {
      this.buildEvenStarFace(N, faceId, points, c, raw, vertId, edgeId, addPoly);
      return;
    }
    this.buildOddHigherFace(N, faceId, points, c, raw, vertId, edgeId, addPoly);
  }

  /** Odd N≥5: center pentagon + barycentric rings + outer band. */
  private buildOddHigherFace(
    N: number,
    faceId: string,
    points: THREE.Vector3[],
    c: THREE.Vector3,
    raw: THREE.Vector3[],
    vertId: Map<THREE.Vector3, number>,
    edgeId: (a: THREE.Vector3, b: THREE.Vector3) => string,
    addPoly: (poly: THREE.Vector3[], pieceId: string, kind: MegaTile['kind']) => void,
  ): void {
    const m = N - 1;
    const P: THREE.Vector3[][][] = [];
    for (let i = 0; i < 5; i++) {
      const Vi = points[i];
      const Vi1 = points[(i + 1) % 5];
      P[i] = [];
      for (let r = 0; r <= m; r++) {
        P[i][r] = [];
        for (let k = 0; k <= r; k++) {
          P[i][r][k] = new THREE.Vector3()
            .addScaledVector(c, m - r)
            .addScaledVector(Vi, r - k)
            .addScaledVector(Vi1, k)
            .multiplyScalar(1 / m);
        }
      }
    }

    // N=5 → outerStart 2; N=7 → 4
    const outerStart = N <= 5 ? 2 : Math.min(m - 1, 4);

    const centerPent = [0, 1, 2, 3, 4].map((i) => P[i][1][0]);
    addPoly(centerPent, `center:${faceId}`, 'center');

    for (let r = 1; r < outerStart; r++) {
      for (let i = 0; i < 5; i++) {
        const innerL = P[i][r][0];
        const innerR = P[i][r][r];
        const outerL = P[i][r + 1][0];
        const outerR = P[i][r + 1][r + 1];
        const midInner =
          r >= 1 ? P[i][r][Math.floor(r / 2)] : innerL.clone().lerp(innerR, 0.5);
        const midOuter = P[i][r + 1][Math.floor((r + 1) / 2)];
        addPoly(
          [outerL, midOuter, midInner, innerL],
          `ring:${faceId}:${r}:a:${i}`,
          'ring',
        );
        addPoly(
          [midOuter, outerR, innerR, midInner],
          `ring:${faceId}:${r}:b:${i}`,
          'ring',
        );
      }
    }

    this.addOuterBand(N, points, raw, vertId, edgeId, P, outerStart, addPoly);
  }

  /**
   * Even N: star-cut face. Black star void (tips→edge midpoints) + bay rings + outer.
   * N=4: 5 corners + 10 mid-edges + 10 bay rings = 25 colored stickers/face.
   * N=6: same star + extra intermediate rings so edge shows 6 stickers.
   */
  private buildEvenStarFace(
    N: number,
    faceId: string,
    points: THREE.Vector3[],
    c: THREE.Vector3,
    raw: THREE.Vector3[],
    vertId: Map<THREE.Vector3, number>,
    edgeId: (a: THREE.Vector3, b: THREE.Vector3) => string,
    addPoly: (poly: THREE.Vector3[], pieceId: string, kind: MegaTile['kind']) => void,
  ): void {
    // Classic orientation: tips toward edge midpoints M[i]=lerp(V[i],V[i+1],0.5);
    // dents toward vertices (corners sit in the notches between star points).
    // Equivalent to a π/5 (36°) offset relative to vertex-aimed rays.
    const dent = points.map((p) => c.clone().lerp(p, STAR_DENT_SCALE));
    const tip: THREE.Vector3[] = [];
    for (let i = 0; i < 5; i++) {
      const mid = points[i].clone().lerp(points[(i + 1) % 5], 0.5);
      tip.push(c.clone().lerp(mid, STAR_TIP_SCALE));
    }

    // Star void: no colored facelets inside tip/dent outline — black core shows
    // through as a five-pointed ★ (tips toward edge midpoints).

    const onEdge = (a: THREE.Vector3, b: THREE.Vector3, t: number) => a.clone().lerp(b, t);

    // Corners: nestle into star notches (inner point = dent toward vertex).
    for (let i = 0; i < 5; i++) {
      const i0 = (i + 4) % 5;
      const i1 = (i + 1) % 5;
      const Vi = points[i];
      const cutNext = onEdge(Vi, points[i1], 1 / N);
      const cutPrev = onEdge(Vi, points[i0], 1 / N);
      addPoly(
        [Vi, cutNext, dent[i], cutPrev],
        `corner:${vertId.get(raw[i])}`,
        'corner',
      );
    }

    // Circumferential bands between star and outer edge (excl. the edge band itself).
    // N=4: 1 bay band. N=6: 2 bands so density grows with order.
    const ringBands = Math.max(1, N / 2 - 1);
    const splits: number[] = [];
    if (N === 4) {
      splits.push(STAR_BAND_T);
    } else {
      for (let b = 1; b <= ringBands; b++) splits.push(b / (ringBands + 1));
    }

    for (let i = 0; i < 5; i++) {
      const i1 = (i + 1) % 5;
      const Vi = points[i];
      const Vi1 = points[i1];
      // Bay star boundary: dent@Vi — tip@edgeMid — dent@Vi1 (tip points into edge).
      const L = dent[i];
      const T = tip[i];
      const R = dent[i1];

      // Outer-edge cut points at k/N (corners own 0 and N; mid-edges own 1..N-2).
      const E: THREE.Vector3[] = [];
      for (let k = 1; k <= N - 1; k++) E.push(onEdge(Vi, Vi1, k / N));

      // Star-boundary polyline for this bay: L — T — R.
      // Map each outer cut E[k] back to a point on that polyline by normalized t.
      const onStar = (tEdge: number): THREE.Vector3 => {
        // tEdge in [1/N, (N-1)/N]; midpoint 0.5 → tip, near ends → dents at vertices
        if (tEdge <= 0.5) {
          const u = (tEdge - 1 / N) / (0.5 - 1 / N);
          return L.clone().lerp(T, Math.min(1, Math.max(0, u)));
        }
        const u = (tEdge - 0.5) / ((N - 1) / N - 0.5);
        return T.clone().lerp(R, Math.min(1, Math.max(0, u)));
      };

      // Build concentric polylines at each split (and at the outer edge).
      // Level 0 = star, levels 1..ringBands = ring interfaces, level ringBands+1 = edge.
      const levels: THREE.Vector3[][] = [];
      const starPts = E.map((_, ki) => onStar((ki + 1) / N));
      levels.push(starPts);
      for (const s of splits) {
        levels.push(E.map((e, ki) => starPts[ki].clone().lerp(e, s)));
      }
      levels.push(E);

      // Face-local rings: each band × each mid-edge slot (N-2 slots).
      for (let b = 0; b < ringBands; b++) {
        const inner = levels[b];
        const outer = levels[b + 1];
        for (let s = 0; s < N - 2; s++) {
          addPoly(
            [inner[s], inner[s + 1], outer[s + 1], outer[s]],
            `ring:${faceId}:b${b}:s${s}:e${i}`,
            'ring',
          );
        }
      }

      // Mid-edge stickers (outermost band).
      const innerE = levels[ringBands];
      const ia = vertId.get(raw[i])!;
      const ib = vertId.get(raw[i1])!;
      const eKey = edgeId(raw[i], raw[i1]);
      for (let s = 0; s < N - 2; s++) {
        const slot = ia < ib ? s : N - 3 - s;
        addPoly(
          [innerE[s], innerE[s + 1], E[s + 1], E[s]],
          `edge:${eKey}:${slot}`,
          'edge',
        );
      }
    }
  }

  /** Shared outer corners + mid-edges for odd higher-order faces. */
  private addOuterBand(
    N: number,
    points: THREE.Vector3[],
    raw: THREE.Vector3[],
    vertId: Map<THREE.Vector3, number>,
    edgeId: (a: THREE.Vector3, b: THREE.Vector3) => string,
    P: THREE.Vector3[][][],
    outerStart: number,
    addPoly: (poly: THREE.Vector3[], pieceId: string, kind: MegaTile['kind']) => void,
  ): void {
    const sampleChord = (row: THREE.Vector3[], t: number): THREE.Vector3 => {
      const nSeg = row.length - 1;
      if (nSeg <= 0) return row[0].clone();
      const f = Math.min(nSeg, Math.max(0, t * nSeg));
      const j = Math.min(nSeg - 1, Math.floor(f));
      return row[j].clone().lerp(row[j + 1], f - j);
    };
    const onEdge = (a: THREE.Vector3, b: THREE.Vector3, t: number) => a.clone().lerp(b, t);

    for (let i = 0; i < 5; i++) {
      const iPrev = (i + 4) % 5;
      const i1 = (i + 1) % 5;
      const Hin = P[i][outerStart];
      const Vi = points[i];
      const Vi1 = points[i1];
      const Vprev = points[iPrev];

      addPoly(
        [Vi, onEdge(Vi, Vi1, 1 / N), Hin[0], onEdge(Vi, Vprev, 1 / N)],
        `corner:${vertId.get(raw[i])}`,
        'corner',
      );

      const ia = vertId.get(raw[i])!;
      const ib = vertId.get(raw[i1])!;
      const eKey = edgeId(raw[i], raw[i1]);
      for (let s = 0; s < N - 2; s++) {
        const t0 = (s + 1) / N;
        const t1 = (s + 2) / N;
        const u0 = (s + 1) / (N - 1);
        const u1 = (s + 2) / (N - 1);
        const slot = ia < ib ? s : N - 3 - s;
        addPoly(
          [
            onEdge(Vi, Vi1, t0),
            onEdge(Vi, Vi1, t1),
            sampleChord(Hin, u1),
            sampleChord(Hin, u0),
          ],
          `edge:${eKey}:${slot}`,
          'edge',
        );
      }
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
    // Even star-cut: no center sticker; 5 corners + 5·(N−2) edges + rings.
    // N=4: 5+10+10 = 25. N=6: 5+20+40 = 65 (2 bands × 4 slots × 5).
    if (N % 2 === 0) {
      const midEdges = 5 * (N - 2);
      const ringBands = Math.max(1, N / 2 - 1);
      const rings = ringBands * 5 * (N - 2);
      return 5 + midEdges + rings;
    }
    // Odd: 5·⌊N/2⌋·⌈N/2⌉ + 1 → N=5/7 → 31/61
    return 5 * Math.floor(N / 2) * Math.ceil(N / 2) + 1;
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
    } else if (this.order === 4) {
      // Star void (no center): 5 corners + 10 edges + 10 bay rings / face → 25
      // Totals: corner stickers 60, edge 120, ring 120; graph edge×2, corner×3, ring×1
      pieceGraphOk =
        pieceGraphOk &&
        kinds.center === 0 &&
        kinds.corner === 60 &&
        kinds.edge === 120 &&
        kinds.ring === 120 &&
        this.expectedPerFace() === 25;
    } else if (this.order === 5) {
      pieceGraphOk =
        pieceGraphOk &&
        kinds.center === 12 &&
        kinds.corner === 60 &&
        kinds.edge === 180 &&
        kinds.ring === 120 &&
        this.expectedPerFace() === 31;
    } else if (this.order === 6) {
      // Star void: 5 corners + 20 edges + 40 rings / face → 65
      pieceGraphOk =
        pieceGraphOk &&
        kinds.center === 0 &&
        kinds.corner === 60 &&
        kinds.edge === 240 &&
        kinds.ring === 480 &&
        this.expectedPerFace() === 65;
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
