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

/**
 * Facelet projections along a tip axis (solved, |vertex|=2.7) cluster at:
 *   ~1.92 tip (3) · ~1.12 axial wedges (3) · ~0.72 edge band (6)
 *   · ~-0.08 / ~-0.48 / ~-0.96 far / base (incl. other tips at d ≈ -1/3)
 * Tip / 尖 = tip only (3): d > TIP_THRESH.
 * Deep / 层 = mid-band excluding tip (9): DEEP_THRESH < d ≤ TIP_THRESH.
 * Bottom / 底 = far band + 底座三角 (24): d ≤ DEEP_THRESH.
 *   Includes the three other tips' tip stickers (base corners when T is up);
 *   tip T's own stickers stay out (d_T ≈ 1.92). Bottom about T cycles those
 *   three base corners. Tip and deep stay independent; tip swipe uses world pos.
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

    // Segmented soft-gray core (tip / mid / bottom bands per tip axis).
    this.buildSegmentedCore(vertices);

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
   * Lock tip / deep / bottom band + tip axis from a hit (no screen delta needed).
   * Same rules as dragToMove layer detection; world tip resolve; no swipe scoring.
   */
  resolveLayerAtHit(
    mesh: THREE.Mesh,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    camera: THREE.Camera,
  ): { face: string; tip?: boolean; bottom?: boolean } | null {
    this.group.updateMatrixWorld(true);

    const tipPiece = Number(mesh.userData.tipPiece ?? -1);
    const faceIndex = Number(mesh.userData.faceIndex ?? -1);
    const camPos = camera.position;

    type Mode = 'tip' | 'deep' | 'bottom';
    let chosen: PolyFace | null = null;
    let mode: Mode = 'deep';

    let tipByPos: PolyFace | null = null;
    let tipDot = TIP_THRESH;
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
        if (hinted.id === tipByPos.id && point.dot(hinted.axis) > TIP_THRESH) {
          chosen = hinted;
        } else {
          chosen = tipByPos;
        }
      } else {
        chosen = tipByPos;
      }
      mode = 'tip';
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
          mode = 'bottom';
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
        if (up && unique && point.dot(up.axis) <= DEEP_THRESH) {
          chosen = up;
          mode = 'bottom';
        }
      }

      if (!chosen) {
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
        // Prefer resolved face if mid-band; else highest projection.
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
        mode = 'deep';
      }
    }

    if (!chosen) return null;
    if (mesh.userData) mesh.userData.turnFace = chosen.id;
    return {
      face: chosen.id,
      ...(mode === 'tip' ? { tip: true } : mode === 'bottom' ? { bottom: true } : {}),
    };
  }

  beginLayerDrag(pick: PuzzlePick, camera: THREE.Camera): LayerDragSession | null {
    if (this.isBusy()) return null;
    const layer = this.resolveLayerAtHit(pick.mesh, pick.point, pick.faceNormal, camera);
    if (!layer) return null;
    if (!this.beginInteractiveTurn(layer)) return null;

    const axis = this.faceOf(layer.face).axis.clone();
    // Orthonormal basis in plane ⊥ tip axis; u along lever arm at hit.
    const radial = pick.point.clone().addScaledVector(axis, -pick.point.dot(axis));
    const u = new THREE.Vector3();
    if (radial.lengthSq() > 1e-8) {
      u.copy(radial).normalize();
    } else {
      // Hit near axis: fall back using camera-facing direction in the plane.
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
    // Plane through origin with normal = tip axis (axes pass through origin).
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
    // Prefer live interactive angle (geom.angle tracks the same value during pointer moves).
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
   * Swipe → tip-axis turn with tip / deep / bottom (尖 / 层 / 底).
   *
   *   1. Tip under finger by **current world position** (authoritative):
   *      argmax point·face.axis among faces with d > TIP_THRESH → `{ tip: true }`.
   *      `tipPiece` is only a weak hint when it still projects > TIP_THRESH on
   *      that same tip; never follow stale tipPiece to a tip the sticker left.
   *   2. else if hit is on the face opposite tip T (`faceIndex === T`) and
   *      the camera is outside that face → `{ bottom: true }` about T
   *   3. else if hit is in the far band of the camera-up tip
   *      (`d ≤ DEEP_THRESH` on the tip nearest the camera) → bottom about that tip
   *   4. else deep mid-band candidates (`DEEP_THRESH < d ≤ TIP_THRESH`), swipe-scored
   *
   * Direction: ±1 from screen-projected RH tangent (Y-flip).
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

    type Mode = 'tip' | 'deep' | 'bottom';
    let chosen: PolyFace | null = null;
    let mode: Mode = 'deep';

    // Tip identity at swipe time: current world position, not stale tipPiece.
    let tipByPos: PolyFace | null = null;
    let tipDot = TIP_THRESH;
    for (const f of this.faces) {
      const d = point.dot(f.axis);
      if (d > tipDot) {
        tipDot = d;
        tipByPos = f;
      }
    }
    if (tipByPos) {
      // tipPiece is a weak hint only when it still sits on this same tip.
      if (tipPiece >= 0 && tipPiece < this.faces.length) {
        const hinted = this.faces[tipPiece];
        if (hinted.id === tipByPos.id && point.dot(hinted.axis) > TIP_THRESH) {
          chosen = hinted;
        } else {
          chosen = tipByPos;
        }
      } else {
        chosen = tipByPos;
      }
      mode = 'tip';
    } else {
      // Opposite-face non-tip, viewed from outside that face → bottom.
      // (Do not trust tipPiece here — sticker is not on any tip vertex.)
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
          mode = 'bottom';
        }
      }

      // Far band of the unique camera-up tip → bottom about that tip.
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
        if (up && unique && point.dot(up.axis) <= DEEP_THRESH) {
          chosen = up;
          mode = 'bottom';
        }
      }

      // Deep mid-band (and resolveHitFace), swipe-scored.
      if (!chosen) {
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
        mode = 'deep';
      }
    }

    if (!chosen) return null;
    const scored = scoreOnTip(chosen);
    if (!scored || scored.score < 1e-6) return null;

    if (mesh.userData) mesh.userData.turnFace = chosen.id;
    return {
      kind: 'face',
      face: chosen.id,
      steps: scored.steps,
      ...(mode === 'tip' ? { tip: true } : mode === 'bottom' ? { bottom: true } : {}),
    };
  }

  /**
   * Subdivide the recessed tetrahedron into small tetras, tagged by band along
   * each tip axis (same TIP_THRESH / DEEP_THRESH as facelets). Idle pose looks
   * like one continuous gray plastic; turns only reparent the active band.
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
      // 4 corner tetras + 4 from octahedron split along diagonal ab–cd.
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
    // 3 levels → 512 small tetras; tip band (vol ≈ 1%) gets several pieces each.
    for (let level = 0; level < 3; level++) tets = tets.flatMap(subdivide);

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
    // Fallback: average geometry positions.
    const attr = mesh.geometry.getAttribute('position');
    target.set(0, 0, 0);
    for (let i = 0; i < attr.count; i++) {
      target.add(new THREE.Vector3().fromBufferAttribute(attr as THREE.BufferAttribute, i));
    }
    return target.multiplyScalar(1 / Math.max(1, attr.count)).applyMatrix4(mesh.matrixWorld);
  }

  /**
   * Core bands match facelet thresholds on the tip axis (world centroids):
   *   tip    d > TIP_THRESH
   *   deep   DEEP_THRESH < d ≤ TIP_THRESH
   *   bottom d ≤ DEEP_THRESH
   */
  protected selectCore(move: FaceTurnMove): THREE.Object3D[] {
    this.group.updateMatrixWorld(true);
    const axis = this.faceOf(move.face).axis;
    const scratch = this.scratch;
    if (move.bottom) {
      return this.corePieces
        .filter((cp) => this.coreWorldCenter(cp.mesh, scratch).dot(axis) <= DEEP_THRESH)
        .map((cp) => cp.mesh);
    }
    if (move.tip) {
      return this.corePieces
        .filter((cp) => this.coreWorldCenter(cp.mesh, scratch).dot(axis) > TIP_THRESH)
        .map((cp) => cp.mesh);
    }
    return this.corePieces
      .filter((cp) => {
        const d = this.coreWorldCenter(cp.mesh, scratch).dot(axis);
        return d > DEEP_THRESH && d <= TIP_THRESH;
      })
      .map((cp) => cp.mesh);
  }

    protected selectLayer(move: FaceTurnMove): PolyTile[] {
    this.group.updateMatrixWorld(true);
    const axis = this.faceOf(move.face).axis;
    if (move.bottom) {
      // Bottom / 底: far band + 底座三角 (other three tips' stickers cycle with it).
      return this.tiles.filter(
        (tile) => this.tileWorldCenter(tile, this.scratch).dot(axis) <= DEEP_THRESH,
      );
    }
    if (move.tip) {
      // Tip / 尖: only the 3 facelets at that vertex.
      return this.tiles.filter(
        (tile) => this.tileWorldCenter(tile, this.scratch).dot(axis) > TIP_THRESH,
      );
    }
    // Deep / 层: C3-closed mid-band excluding tip (edges + axial wedges).
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
   * Scramble: mostly deep mid-band; some tip (~12%); occasional bottom (~10%).
   * Tip and deep are independent; bottom about T may cycle the other three tips.
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
      const r = Math.random();
      const tip = r < 0.12;
      const bottom = !tip && r < 0.22;
      moves.push({
        kind: 'face',
        face,
        steps: Math.random() < 0.5 ? 1 : -1,
        ...(tip ? { tip: true } : bottom ? { bottom: true } : {}),
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
      ...this.faces.map((f) => ({
        id: f.id,
        label: `${f.label}底`,
        color: f.colorCss,
        bottom: true,
      })),
    ];
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
  } {
    this.group.updateMatrixWorld(true);
    const axis = this.faces[0].axis;
    const slots = this.tiles.map((t) => this.tileWorldCenter(t).clone());
    const tip = this.tiles.filter((t) => this.tileWorldCenter(t, this.scratch).dot(axis) > TIP_THRESH);
    const deep = this.tiles.filter((t) => {
      const d = this.tileWorldCenter(t, this.scratch).dot(axis);
      return d > DEEP_THRESH && d <= TIP_THRESH;
    });
    const bottom = this.tiles.filter((t) => {
      return this.tileWorldCenter(t, this.scratch).dot(axis) <= DEEP_THRESH;
    });
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
    };
  }
}
