import * as THREE from 'three';
import { PolyPuzzle, type PolyFace, type PolyTile } from './PolyPuzzle';
import type { AnyMove, FaceButton, FaceTurnMove, VisualStyle } from './puzzle';

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
/** Even-N star tip: 1 = meet outer edge at midpoint (挨到棱). Shrink leaves a thin groove. */
const STAR_TIP_SCALE = 1;
/** Even-N star dent radius (fraction from face center toward vertex).
 *  Smaller → sharper ★ points (内角往中心缩). Classic pentagram ≈0.30; pointed ★ ≈0.20. */
const STAR_DENT_SCALE = 0.20;
/** Even-N split between inner ring band and outer edge band (0=at star, 1=at outer edge). */
const STAR_BAND_T = 0.55;
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
 * stickers sit lower (≤~2.13 even at N=6 with tips on edges). Midway ~2.17.
 */
const FACE_LAYER_THRESH = 2.17;

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
 * N=4: star-cut — black five-pointed ★ void in face center (tips→edge midpoints,
 *       挨到棱 via STAR_TIP_SCALE=1; sharpened dents via STAR_DENT_SCALE≈0.20).
 *       Colored pieces in the bays; 5 corners + 10 mid-edges + 10 rings = 25/face.
 * N≥5: parallel-to-edge lattice (N stickers/edge; filled center pentagon; no ★ void).
 *       Even: (N−2) parallels/dir. Odd: outermost (N−1)/2
 *       (N=5 Gigaminx → 2/dir → 31/face; N=7 Teraminx → 3/dir → 61/face).
 *
 * Face turns 72°. Turnable layers per face axis: L = ⌊N/2⌋ (depth 0 = outer face;
 * depth 1..L-1 = successive inner bands by axis projection). N=2/3 → outer only.
 */
export class Megaminx extends PolyPuzzle {
  readonly puzzleType = 'megaminx' as const;
  private readonly order: number;
  private readonly megaTiles: MegaTile[] = [];
  private readonly scratch = new THREE.Vector3();
  /**
   * Equal-width parallel-slab cuts along a face axis (high→low).
   * Length = L = ⌊N/2⌋:
   *   depth 0: d > thresh[0]  (thresh[0] = FACE_LAYER_THRESH)
   *   depth k: thresh[k] < d ≤ thresh[k-1]
   * Deepest band lower-bounded by thresh[L-1] = 0 (equator).
   */
  private depthThresh: number[] = [FACE_LAYER_THRESH];

  constructor(orderOrStyle: number | VisualStyle = 3, style: VisualStyle = 'sticker') {
    const order = typeof orderOrStyle === 'number' ? orderOrStyle : 3;
    const st = typeof orderOrStyle === 'number' ? style : orderOrStyle;
    super(st);
    this.order = THREE.MathUtils.clamp(Math.round(order), 2, 7);
    this.build();
    this.finishBuild();
    this.computeDepthThresholds();
  }

  getOrder(): number {
    return this.order;
  }

  /** Turnable layers per face axis: ⌊N/2⌋. */
  layerCount(): number {
    return Math.max(1, Math.floor(this.order / 2));
  }

  /** Resolve move.depth → 0..L-1 (default outer). */
  private resolveDepth(move: FaceTurnMove): number {
    const L = this.layerCount();
    if (move.depth === undefined) return 0;
    return THREE.MathUtils.clamp(Math.round(move.depth), 0, L - 1);
  }

  /**
   * Band membership from axis projection (piece maxProj or sticker/hit proj).
   * Returns -1 when below the deepest turnable band (opposite hemisphere).
   */
  private depthOfProjection(d: number): number {
    const t = this.depthThresh;
    const L = this.layerCount();
    if (!t.length) return d > FACE_LAYER_THRESH ? 0 : -1;
    if (d > t[0]) return 0;
    for (let k = 1; k < L; k++) {
      if (d > t[k]) return k;
    }
    return -1;
  }

  /** Max sticker projection of a piece onto an axis. */
  private pieceMaxProjOnAxis(pieceId: string, axis: THREE.Vector3): number {
    let maxP = -Infinity;
    for (const t of this.megaTiles) {
      if (t.pieceId !== pieceId) continue;
      maxP = Math.max(maxP, this.tileWorldCenter(t, this.scratch).dot(axis));
    }
    return maxP;
  }

  /**
   * Build depthThresh as equal-width geometric slabs parallel to the face
   * (Master Kilominx / Gigaminx SSE layer model).
   *
   * Region from the outer-face cut (FACE_LAYER_THRESH) down to the equator
   * (proj≈0) is partitioned into (L−1) equal-width bands for depths 1..L−1.
   * Depth 0 stays the outer face (stickers with proj > FACE_LAYER_THRESH).
   *
   *   depth 0: d > thresh[0]   (thresh[0] = FACE_LAYER_THRESH)
   *   depth k: thresh[k] < d ≤ thresh[k−1]
   * Deepest lower bound thresh[L−1] = 0 (equator).
   *
   * Cuts are constant projection on the face axis — NOT 72° orbit clustering.
   */
  private computeDepthThresholds(): void {
    const L = this.layerCount();
    if (L <= 1) {
      this.depthThresh = [FACE_LAYER_THRESH];
      return;
    }
    const thresh: number[] = [FACE_LAYER_THRESH];
    const innerCount = L - 1;
    for (let k = 1; k <= innerCount; k++) {
      // Equal-width: k=1 → just below outer; k=innerCount → equator (0).
      thresh.push(FACE_LAYER_THRESH * ((innerCount - k) / innerCount));
    }
    this.depthThresh = thresh;
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

    // N=4: near-black core so the ★ sticker void reads solid. N≥5: dark grooves.
    // N=2/3 keep neutral gray plastic.
    const coreColor = this.order >= 4 ? 0x0a0a0a : 0x8b929c;
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

    // N=4: black ★ center void (tips 挨到棱). N≥5: parallel lattice (filled center).
    if (N === 4) {
      this.buildEvenStarFace(N, faceId, points, c, raw, vertId, edgeId, addPoly);
      return;
    }
    this.buildParallelFace(N, faceId, points, c, raw, vertId, edgeId, addPoly);
  }

  /**
   * N=4 star-cut face: black five-pointed ★ void (no center sticker) + bay rings + outer.
   * Tips aim at edge midpoints and meet the outer edge (STAR_TIP_SCALE=1 → 挨到棱).
   * Dents pull toward center (STAR_DENT_SCALE≈0.20) for a sharpened ★.
   * Per face: 5 corners + 10 mid-edges + 10 bay rings = 25 colored stickers.
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
    // Tips → edge midpoints; dents → vertices (corners nestle in notches).
    const dent = points.map((p) => c.clone().lerp(p, STAR_DENT_SCALE));
    const tip: THREE.Vector3[] = [];
    for (let i = 0; i < 5; i++) {
      const mid = points[i].clone().lerp(points[(i + 1) % 5], 0.5);
      tip.push(c.clone().lerp(mid, STAR_TIP_SCALE));
    }

    // Star void: no colored facelets inside tip/dent outline — black core shows ★.

    const onEdge = (a: THREE.Vector3, b: THREE.Vector3, t: number) => a.clone().lerp(b, t);

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

    // N=4: one bay band between star and outer edge.
    const ringBands = Math.max(1, N / 2 - 1);
    const splits: number[] = [];
    if (N === 4) {
      splits.push(STAR_BAND_T);
    } else {
      for (let b = 1; b <= ringBands; b++) splits.push(b / (ringBands + 1));
    }

    // Drop consecutive duplicates so tip-on-edge columns become triangles
    // (STAR_TIP_SCALE=1 → tip coincides with edge mid).
    const addClean = (pts: THREE.Vector3[], pieceId: string, kind: MegaTile['kind']) => {
      const clean: THREE.Vector3[] = [];
      for (const p of pts) {
        if (!clean.length || clean[clean.length - 1].distanceToSquared(p) > 1e-16) {
          clean.push(p);
        }
      }
      if (
        clean.length >= 2 &&
        clean[0].distanceToSquared(clean[clean.length - 1]) < 1e-16
      ) {
        clean.pop();
      }
      if (clean.length >= 3) addPoly(clean, pieceId, kind);
    };

    for (let i = 0; i < 5; i++) {
      const i1 = (i + 1) % 5;
      const Vi = points[i];
      const Vi1 = points[i1];
      const L = dent[i];
      const T = tip[i];
      const R = dent[i1];

      const E: THREE.Vector3[] = [];
      for (let k = 1; k <= N - 1; k++) E.push(onEdge(Vi, Vi1, k / N));

      const onStar = (tEdge: number): THREE.Vector3 => {
        if (tEdge <= 0.5) {
          const u = (tEdge - 1 / N) / (0.5 - 1 / N);
          return L.clone().lerp(T, Math.min(1, Math.max(0, u)));
        }
        const u = (tEdge - 0.5) / ((N - 1) / N - 0.5);
        return T.clone().lerp(R, Math.min(1, Math.max(0, u)));
      };

      const levels: THREE.Vector3[][] = [];
      const starPts = E.map((_, ki) => onStar((ki + 1) / N));
      levels.push(starPts);
      for (const s of splits) {
        levels.push(E.map((e, ki) => starPts[ki].clone().lerp(e, s)));
      }
      levels.push(E);

      for (let b = 0; b < ringBands; b++) {
        const inner = levels[b];
        const outer = levels[b + 1];
        for (let s = 0; s < N - 2; s++) {
          addClean(
            [inner[s], inner[s + 1], outer[s + 1], outer[s]],
            `ring:${faceId}:b${b}:s${s}:e${i}`,
            'ring',
          );
        }
      }

      const innerE = levels[ringBands];
      const ia = vertId.get(raw[i])!;
      const ib = vertId.get(raw[i1])!;
      const eKey = edgeId(raw[i], raw[i1]);
      for (let s = 0; s < N - 2; s++) {
        const slot = ia < ib ? s : N - 3 - s;
        addClean(
          [innerE[s], innerE[s + 1], E[s + 1], E[s]],
          `edge:${eKey}:${slot}`,
          'edge',
        );
      }
    }
  }

  /**
   * Parallel-to-edge lattice face geometry (N≥5; also unused N≥4 even except N=4 star).
   *
   * On each outer edge mark equal points at t=k/N (k=1..N-1). For each of the
   * 5 edge directions, take distinct interior offsets of those lattice points
   * projected onto that edge's outward normal, then keep:
   *   • even N: all (N−2) offsets (N=4 → 2/dir; N=6 → 4/dir)
   *   • odd  N: outermost (N−1)/2 (N=5 → 2/dir → 31/face Gigaminx;
   *             N=7 → 3/dir → 61/face Teraminx)
   * Full odd offsets over-subdivide (N=5 ALL → 66 cells); the cap matches
   * physical Gigaminx sticker count while keeping N stickers along each edge
   * (cross-direction lines still hit edge k/N points).
   *
   * Arrangement cells fill the face (center included; no oversized ★ void).
   * Outer band: 5 corners + (N−2) mid-edge stickers/side (exactly N along edge).
   * Interior cells are face-local rings; grooves may show the core.
   */
  private buildParallelFace(
    N: number,
    faceId: string,
    points: THREE.Vector3[],
    c: THREE.Vector3,
    raw: THREE.Vector3[],
    vertId: Map<THREE.Vector3, number>,
    edgeId: (a: THREE.Vector3, b: THREE.Vector3) => string,
    addPoly: (poly: THREE.Vector3[], pieceId: string, kind: MegaTile['kind']) => void,
  ): void {
    type V2 = { x: number; y: number };
    const eps = 1e-9;

    // Orthonormal face basis (origin at face center c).
    const u = points[0].clone().sub(c).normalize();
    const nrm = new THREE.Vector3()
      .crossVectors(points[1].clone().sub(points[0]), points[2].clone().sub(points[0]))
      .normalize();
    if (nrm.dot(c) < 0) nrm.negate();
    const v = new THREE.Vector3().crossVectors(nrm, u).normalize();

    const to2 = (p: THREE.Vector3): V2 => ({
      x: p.clone().sub(c).dot(u),
      y: p.clone().sub(c).dot(v),
    });
    const to3 = (q: V2): THREE.Vector3 =>
      c.clone().addScaledVector(u, q.x).addScaledVector(v, q.y);

    const verts2 = points.map(to2);

    // Outward edge normals + apothems in 2D.
    const edges2: { a: V2; b: V2; ox: number; oy: number; A: number; tx: number; ty: number; len: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const a = verts2[i];
      const b = verts2[(i + 1) % 5];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const tx = dx / len;
      const ty = dy / len;
      let ox = ty;
      let oy = -tx;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (mx * ox + my * oy < 0) {
        ox = -ox;
        oy = -oy;
      }
      const A = mx * ox + my * oy;
      edges2.push({ a, b, ox, oy, A, tx, ty, len });
    }

    // Lattice points at k/N on every edge.
    const lattice: { x: number; y: number; ei: number; k: number }[] = [];
    for (let ei = 0; ei < 5; ei++) {
      const e = edges2[ei];
      for (let k = 1; k < N; k++) {
        const t = k / N;
        lattice.push({
          x: e.a.x + (e.b.x - e.a.x) * t,
          y: e.a.y + (e.b.y - e.a.y) * t,
          ei,
          k,
        });
      }
    }

    // Cut lines: for each edge direction, distinct interior positive offsets
    // of lattice points on other edges → (N−2) parallels per direction.
    type Line2 = { ox: number; oy: number; dist: number; ei: number };
    const lines: Line2[] = [];
    for (let ei = 0; ei < 5; ei++) {
      const e = edges2[ei];
      // Collect interior offsets. Odd N: cluster near-equal projections —
      // dodeca FP noise can split one offset into two toFixed(10) buckets,
      // which made keep=(N-1)/2 pick the same line twice (N=5 → 14 cells).
      // Even N: keep prior toFixed(10) Set (N=4/6 band orbits already tuned).
      let sorted: number[];
      if (N % 2 === 1) {
        const dists: number[] = [];
        const mergeEps = Math.max(1e-6, e.A * 1e-5);
        for (const p of lattice) {
          if (p.ei === ei) continue;
          const d = p.x * e.ox + p.y * e.oy;
          if (d <= 1e-8 || d >= e.A - 1e-8) continue;
          if (!dists.some((x) => Math.abs(x - d) < mergeEps)) dists.push(d);
        }
        sorted = dists.sort((a, b) => b - a);
      } else {
        const dists = new Set<number>();
        for (const p of lattice) {
          if (p.ei === ei) continue;
          const d = p.x * e.ox + p.y * e.oy;
          if (d > 1e-8 && d < e.A - 1e-8) dists.add(+d.toFixed(10));
        }
        sorted = [...dists].sort((a, b) => b - a);
      }
      // Even: all offsets (=N−2). Odd: outermost (N−1)/2 (Gigaminx/Teraminx).
      const keep = N % 2 === 0 ? sorted.length : (N - 1) / 2;
      for (const d of sorted.slice(0, keep)) lines.push({ ox: e.ox, oy: e.oy, dist: d, ei });
    }

    const side = (p: V2, L: Line2) => p.x * L.ox + p.y * L.oy - L.dist;

    const dedupeRing = (ring: V2[]): V2[] => {
      const out: V2[] = [];
      for (const p of ring) {
        if (!out.length || Math.hypot(out[out.length - 1].x - p.x, out[out.length - 1].y - p.y) > 1e-10) {
          out.push(p);
        }
      }
      if (
        out.length >= 2 &&
        Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-10
      ) {
        out.pop();
      }
      return out;
    };

    /** Split convex polygon by line p·n = dist into (≤0) and (≥0) halves. */
    const splitPoly = (poly: V2[], L: Line2): [V2[], V2[]] => {
      const neg: V2[] = [];
      const pos: V2[] = [];
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        const sa = side(a, L);
        const sb = side(b, L);
        if (sa <= eps) neg.push(a);
        if (sa >= -eps) pos.push(a);
        if ((sa > eps && sb < -eps) || (sa < -eps && sb > eps)) {
          const t = sa / (sa - sb);
          const ip = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          neg.push(ip);
          pos.push(ip);
        }
      }
      return [dedupeRing(neg), dedupeRing(pos)];
    };

    const polyArea2 = (poly: V2[]): number => {
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const j = (i + 1) % poly.length;
        a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
      }
      return Math.abs(a) / 2;
    };
    // Face area ≈ 5 * (side) * apothem / 2; reject numerical slivers.
    const faceArea = polyArea2(verts2);
    const minCellArea = faceArea * 1e-6;

    // Successive clipping yields all arrangement cells.
    let cells: V2[][] = [verts2];
    for (const L of lines) {
      const next: V2[][] = [];
      for (const poly of cells) {
        const [neg, pos] = splitPoly(poly, L);
        if (neg.length >= 3 && polyArea2(neg) > minCellArea) next.push(neg);
        if (pos.length >= 3 && polyArea2(pos) > minCellArea) next.push(pos);
      }
      cells = next;
    }

    const centroid = (poly: V2[]): V2 => {
      let x = 0;
      let y = 0;
      for (const p of poly) {
        x += p.x;
        y += p.y;
      }
      return { x: x / poly.length, y: y / poly.length };
    };
    const area = (poly: V2[]): number => {
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const j = (i + 1) % poly.length;
        a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
      }
      return Math.abs(a) / 2;
    };
    const containsOrigin = (poly: V2[]): boolean => {
      // Ray cast
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x;
        const yi = poly[i].y;
        const xj = poly[j].x;
        const yj = poly[j].y;
        const intersect = yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi + 0.0) + xi;
        if (intersect) inside = !inside;
      }
      return inside;
    };
    const nearVert = (p: V2, vi: number) =>
      Math.hypot(p.x - verts2[vi].x, p.y - verts2[vi].y) < 1e-4;
    const polyTouchesVert = (poly: V2[], vi: number) => poly.some((p) => nearVert(p, vi));
    const edgeDist = (p: V2, ei: number) => {
      const e = edges2[ei];
      return e.A - (p.x * e.ox + p.y * e.oy);
    };
    /** Positive-length contact of poly with outer edge ei (not a mere tip point). */
    const polyEdgeSpan = (poly: V2[], ei: number): number => {
      const e = edges2[ei];
      const ts: number[] = [];
      for (const p of poly) {
        if (Math.abs(edgeDist(p, ei)) > 1e-4) continue;
        const t = ((p.x - e.a.x) * e.tx + (p.y - e.a.y) * e.ty) / e.len;
        ts.push(t);
      }
      if (ts.length < 2) return 0;
      return Math.max(...ts) - Math.min(...ts);
    };

    type Classified = {
      poly: V2[];
      cen: V2;
      kind: MegaTile['kind'];
      pieceId: string;
    };
    const classified: Classified[] = [];
    const usedCorner = new Set<number>();
    const usedEdgeSlot = new Set<string>();

    // Pass 1: corners (touch an outer vertex).
    for (const poly of cells) {
      if (area(poly) < minCellArea) continue;
      let vi = -1;
      for (let i = 0; i < 5; i++) {
        if (polyTouchesVert(poly, i)) {
          vi = i;
          break;
        }
      }
      if (vi < 0 || usedCorner.has(vi)) continue;
      usedCorner.add(vi);
      classified.push({
        poly,
        cen: centroid(poly),
        kind: 'corner',
        pieceId: `corner:${vertId.get(raw[vi])}`,
      });
    }

    // Pass 2: mid-edge stickers (touch exactly one outer edge, not a corner).
    const cornerPolys = new Set(classified.map((c) => c.poly));
    for (const poly of cells) {
      if (cornerPolys.has(poly) || area(poly) < 1e-12) continue;
      // Mid-edge stickers own a positive-length segment of exactly one outer edge.
      // (Interior cells may only tip-touch an edge midpoint — those are rings.)
      const touch: number[] = [];
      for (let ei = 0; ei < 5; ei++) {
        if (polyEdgeSpan(poly, ei) > 1e-4) touch.push(ei);
      }
      if (touch.length !== 1) continue;
      const ei = touch[0];
      const e = edges2[ei];
      const cen = centroid(poly);
      const t =
        ((cen.x - e.a.x) * e.tx + (cen.y - e.a.y) * e.ty) / e.len; // 0..1
      // Slots 0..N-3 for the N-2 mid-edge pieces between the two corners.
      let slot = Math.floor(t * N) - 1;
      if (slot < 0) slot = 0;
      if (slot > N - 3) slot = N - 3;
      const ia = vertId.get(raw[ei])!;
      const ib = vertId.get(raw[(ei + 1) % 5])!;
      const eKey = edgeId(raw[ei], raw[(ei + 1) % 5]);
      const canonSlot = ia < ib ? slot : N - 3 - slot;
      const pid = `edge:${eKey}:${canonSlot}`;
      if (usedEdgeSlot.has(pid)) continue;
      usedEdgeSlot.add(pid);
      classified.push({ poly, cen, kind: 'edge', pieceId: pid });
    }

    // Pass 3: center (contains origin) + rings.
    const taken = new Set(classified.map((c) => c.poly));
    const leftovers = cells.filter((p) => !taken.has(p) && area(p) > minCellArea);
    let centerPoly: V2[] | null = null;
    for (const poly of leftovers) {
      if (containsOrigin(poly)) {
        centerPoly = poly;
        break;
      }
    }
    // Fallback: leftover closest to origin.
    if (!centerPoly && leftovers.length) {
      centerPoly = leftovers.reduce((best, p) => {
        const c0 = centroid(p);
        const c1 = centroid(best);
        return c0.x * c0.x + c0.y * c0.y < c1.x * c1.x + c1.y * c1.y ? p : best;
      });
    }
    if (centerPoly) {
      classified.push({
        poly: centerPoly,
        cen: centroid(centerPoly),
        kind: 'center',
        pieceId: `center:${faceId}`,
      });
      taken.add(centerPoly);
    }

    // Remaining = face-local rings, sorted by angle then radius for stable IDs.
    const rings = leftovers
      .filter((p) => !taken.has(p))
      .map((poly) => ({ poly, cen: centroid(poly) }))
      .sort((a, b) => {
        const aa = Math.atan2(a.cen.y, a.cen.x);
        const bb = Math.atan2(b.cen.y, b.cen.x);
        if (Math.abs(aa - bb) > 1e-6) return aa - bb;
        return a.cen.x * a.cen.x + a.cen.y * a.cen.y - (b.cen.x * b.cen.x + b.cen.y * b.cen.y);
      });
    rings.forEach((r, idx) => {
      classified.push({
        poly: r.poly,
        cen: r.cen,
        kind: 'ring',
        pieceId: `ring:${faceId}:${idx}`,
      });
    });

    for (const cell of classified) {
      // Ensure CCW winding for consistent normals.
      const poly = cell.poly.slice();
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const j = (i + 1) % poly.length;
        a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
      }
      if (a < 0) poly.reverse();
      addPoly(
        poly.map(to3),
        cell.pieceId,
        cell.kind,
      );
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
   * N≥4: depth from hit sticker / piece projection on the chosen turn axis
   * (on-face stickers → depth 0; inner bands from adjacent-face stickers).
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
    const L = this.layerCount();
    const containing: PolyFace[] = [];
    if (pieceId) {
      for (const f of this.faces) {
        const maxP = this.pieceMaxProjOnAxis(pieceId, f.axis);
        // Outer face membership (N=2/3 + depth 0) or any inner band (N≥4).
        if (maxP > FACE_LAYER_THRESH || (L > 1 && this.depthOfProjection(maxP) >= 0)) {
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

    // Depth on chosen turn axis: on-face hit → 0; else piece maxProj band.
    let depth = 0;
    if (L > 1) {
      const hitProj = point.dot(bestFace.axis);
      if (hitProj > FACE_LAYER_THRESH) {
        depth = 0;
      } else if (pieceId) {
        depth = this.depthOfProjection(this.pieceMaxProjOnAxis(pieceId, bestFace.axis));
        if (depth < 0) depth = this.depthOfProjection(hitProj);
      } else {
        depth = this.depthOfProjection(hitProj);
      }
      if (depth < 0) return null;
    }

    return {
      kind: 'face',
      face: bestFace.id,
      steps: bestSteps,
      ...(depth > 0 ? { depth } : {}),
    };
  }

  /**
   * Select stickers in the move depth band along the face axis, then expand
   * to every sticker sharing those piece ids.
   * Depth 0: on-face stickers (proj > FACE_LAYER_THRESH) — N=2/3 compatible.
   * Depth k≥1: pieces whose maxProj falls in that inner band.
   */
  protected selectLayer(move: FaceTurnMove): PolyTile[] {
    this.group.updateMatrixWorld(true);
    const axis = this.faceOf(move.face).axis;
    const depth = this.resolveDepth(move);

    if (depth === 0) {
      const onFace = this.megaTiles.filter(
        (t) => this.tileWorldCenter(t, this.scratch).dot(axis) > FACE_LAYER_THRESH,
      );
      const pieces = new Set(onFace.map((t) => t.pieceId));
      return this.megaTiles.filter((t) => pieces.has(t.pieceId));
    }

    // Inner band: by piece maxProj. Skip face-centers of other faces — they
    // sit mid-projection but must stay fixed (only their own face turns them).
    const pieceMax = new Map<string, { maxProj: number; kind: MegaTile['kind'] }>();
    for (const t of this.megaTiles) {
      const p = this.tileWorldCenter(t, this.scratch).dot(axis);
      const cur = pieceMax.get(t.pieceId);
      if (!cur) pieceMax.set(t.pieceId, { maxProj: p, kind: t.kind });
      else cur.maxProj = Math.max(cur.maxProj, p);
    }
    const pieces = new Set<string>();
    for (const [id, info] of pieceMax) {
      if (info.kind === 'center') continue;
      if (this.depthOfProjection(info.maxProj) === depth) pieces.add(id);
    }
    return this.megaTiles.filter((t) => pieces.has(t.pieceId));
  }

  protected turnAngle(move: FaceTurnMove): number {
    return move.steps * ((Math.PI * 2) / 5);
  }

  protected scrambleLength(): number {
    return 16 + this.order * 4;
  }

  /** Megaminx notation: U / 2U / 3U for depth 0 / 1 / 2 (2U = inner; U2 = 144°). */
  protected notation(m: FaceTurnMove): string {
    const d = m.depth ?? 0;
    const face = d > 0 ? `${d + 1}${m.face}` : m.face;
    const abs = Math.abs(m.steps);
    const twice = abs === 2 ? '2' : '';
    return `${face}${twice}${m.steps < 0 ? "'" : ''}`;
  }

  getFaceButtons(): FaceButton[] {
    const L = this.layerCount();
    const buttons: FaceButton[] = [];
    for (let depth = 0; depth < L; depth++) {
      for (const f of this.faces) {
        // Master Kilominx / 4×4 style: U = outer, 2U = inner (里层), 3U…
        const label = depth === 0 ? f.label : `${depth + 1}${f.label}`;
        buttons.push({
          id: f.id,
          label,
          color: f.colorCss,
          ...(depth > 0 ? { depth } : {}),
        });
      }
    }
    return buttons;
  }

  /** Scramble: random face + random depth band (N≥4). */
  async scramble(): Promise<void> {
    if (this.isBusy()) return;
    const L = this.layerCount();
    if (L <= 1) {
      await super.scramble();
      return;
    }
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
      const depth = Math.floor(Math.random() * L);
      moves.push({
        kind: 'face',
        face,
        steps: Math.random() < 0.5 ? 1 : -1,
        ...(depth > 0 ? { depth } : {}),
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
    // N=4 star-cut: no center sticker; 5 corners + 10 mid-edges + 10 rings = 25.
    if (N === 4) {
      const midEdges = 5 * (N - 2);
      const ringBands = Math.max(1, N / 2 - 1);
      const rings = ringBands * 5 * (N - 2);
      return 5 + midEdges + rings;
    }
    // Parallel-lattice (N≥5): N=5 → 31; N=6 → 116; N=7 → 61.
    if (N === 5) return 31;
    if (N === 6) return 116;
    if (N === 7) return 61;
    if (N % 2 === 0) {
      return 5 + 5 * (N - 2) + 1 + 5 * (N - 2) * (N / 2 - 1);
    }
    return 5 * Math.floor(N / 2) * Math.ceil(N / 2) + 1;
  }

  /** Threshold accessors for verify scripts. */
  debugThresholds(): number[] {
    return [...this.depthThresh];
  }

  /** Test helper: counts and C5 closure per depth band (no animation). */
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
    depths: number;
    bandCounts: number[];
    bandClosed: boolean[];
    bandFiveClosed: boolean[];
    bandsDisjoint: boolean;
  } {
    this.group.updateMatrixWorld(true);
    const faceId = this.faces[0].id;
    const axis = this.faces[0].axis;
    const L = this.layerCount();
    const selected = this.selectLayer({ kind: 'face', face: faceId, steps: 1 });
    const q = new THREE.Quaternion().setFromAxisAngle(axis, (Math.PI * 2) / 5);
    const closed = (sel: PolyTile[]) => {
      const selSlots = sel.map((t) => this.tileWorldCenter(t).clone());
      return sel.every((t) => {
        const dest = this.tileWorldCenter(t).applyQuaternion(q);
        // Must land on another selected sticker (layer permutes within itself).
        return selSlots.some((s) => s.distanceTo(dest) < 0.12);
      });
    };
    const fiveClosed = (sel: PolyTile[]) => {
      for (const t of sel) {
        const c = this.tileWorldCenter(t).clone();
        for (let i = 0; i < 5; i++) c.applyQuaternion(q);
        if (c.distanceTo(this.tileWorldCenter(t)) > 0.12) return false;
      }
      return true;
    };
    const layerClosed = closed(selected);
    const fiveTurnClosed = fiveClosed(selected);

    const bandCounts: number[] = [];
    const bandClosed: boolean[] = [];
    const bandFiveClosed: boolean[] = [];
    const bandSets: Set<PolyTile>[] = [];
    for (let d = 0; d < L; d++) {
      const sel = this.selectLayer({
        kind: 'face',
        face: faceId,
        steps: 1,
        ...(d > 0 ? { depth: d } : {}),
      });
      bandCounts.push(sel.length);
      bandClosed.push(sel.length > 0 && closed(sel));
      bandFiveClosed.push(sel.length > 0 && fiveClosed(sel));
      bandSets.push(new Set(sel));
    }
    let bandsDisjoint = true;
    for (let i = 0; i < L; i++) {
      for (let j = i + 1; j < L; j++) {
        for (const t of bandSets[i]) {
          if (bandSets[j].has(t)) bandsDisjoint = false;
        }
      }
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
      // Totals: corner 60, edge 120, ring 120; graph edge×2, corner×3, ring×1
      pieceGraphOk =
        pieceGraphOk &&
        kinds.center === 0 &&
        kinds.corner === 60 &&
        kinds.edge === 120 &&
        kinds.ring === 120 &&
        this.expectedPerFace() === 25;
    } else if (this.order === 5) {
      // Parallel lattice (2 lines/dir): 5 corners + 15 edges + 1 center + 10 rings / face → 31
      // Totals: center 12, corner 60, edge 180, ring 120
      pieceGraphOk =
        pieceGraphOk &&
        kinds.center === 12 &&
        kinds.corner === 60 &&
        kinds.edge === 180 &&
        kinds.ring === 120 &&
        this.expectedPerFace() === 31;
    } else if (this.order === 6) {
      // Parallel lattice: 5 corners + 20 edges + 1 center + 90 rings / face → 116
      pieceGraphOk =
        pieceGraphOk &&
        kinds.center === 12 &&
        kinds.corner === 60 &&
        kinds.edge === 240 &&
        kinds.ring === 1080 &&
        this.expectedPerFace() === 116;
    } else if (this.order === 7) {
      // Parallel lattice (3 lines/dir): 5 corners + 25 edges + 1 center + 30 rings / face → 61
      pieceGraphOk =
        pieceGraphOk &&
        kinds.center === 12 &&
        kinds.corner === 60 &&
        kinds.edge === 300 &&
        kinds.ring === 360 &&
        this.expectedPerFace() === 61;
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
      depths: L,
      bandCounts,
      bandClosed,
      bandFiveClosed,
      bandsDisjoint,
    };
  }
}
