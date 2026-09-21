import * as THREE from 'three';
import { FACE_COLORS, type FaceId } from './colors';
import type { Axis, LayerMove, MoveRecord } from './types';
import { moveToNotation } from './notation';
import { generateScramble } from './scramble';
import { CubejsTracker, reverseHistory, ensureSolver } from './solver';

const CUBIE_SIZE = 1;
const GAP = 0.06;

export type CubeEvent =
  | { type: 'busy'; busy: boolean }
  | { type: 'move'; notation: string; historyLen: number }
  | { type: 'scramble'; text: string; length: number }
  | { type: 'solved' }
  | { type: 'order'; order: number }
  | { type: 'status'; message: string };

type Listener = (e: CubeEvent) => void;

interface Cubie {
  mesh: THREE.Mesh;
  ix: number;
  iy: number;
  iz: number;
}

export class RubiksCube {
  readonly group = new THREE.Group();
  private cubies: Cubie[] = [];
  private order: number;
  private animating = false;
  private locked = false;
  private history: LayerMove[] = [];
  private pivot = new THREE.Group();
  private tracker = new CubejsTracker();
  private listeners: Listener[] = [];
  private animSpeed = 1; // multiplier
  private abortSolve = false;

  constructor(order = 3) {
    this.order = order;
    this.group.add(this.pivot);
    this.build();
  }

  on(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(e: CubeEvent): void {
    for (const l of this.listeners) l(e);
  }

  getOrder(): number {
    return this.order;
  }

  isBusy(): boolean {
    return this.animating || this.locked;
  }

  setSpeed(mult: number): void {
    this.animSpeed = Math.max(0.25, Math.min(4, mult));
  }

  getHistoryLength(): number {
    return this.history.length;
  }

  setOrder(n: number): void {
    if (n < 2 || n > 7 || n === this.order) {
      if (n === this.order) this.reset();
      return;
    }
    this.abortSolve = true;
    this.order = n;
    this.build();
    this.resetState();
    this.emit({ type: 'order', order: n });
  }

  reset(): void {
    this.abortSolve = true;
    this.build();
    this.resetState();
    this.emit({ type: 'status', message: '已复位' });
  }

  private resetState(): void {
    this.history = [];
    this.tracker.reset();
    this.animating = false;
    this.emit({ type: 'busy', busy: false });
  }

  private build(): void {
    // clear old cubies (may currently be under pivot mid-animation)
    for (const c of this.cubies) {
      c.mesh.removeFromParent();
      c.mesh.geometry.dispose();
      const mats = c.mesh.material as THREE.Material[];
      mats.forEach((m) => m.dispose());
    }
    this.cubies = [];
    while (this.pivot.children.length) {
      this.pivot.remove(this.pivot.children[0]);
    }
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.scale.set(1, 1, 1);

    const N = this.order;
    const half = (N - 1) / 2;
    const step = CUBIE_SIZE + GAP;

    for (let ix = 0; ix < N; ix++) {
      for (let iy = 0; iy < N; iy++) {
        for (let iz = 0; iz < N; iz++) {
          // skip completely internal cubies
          if (ix > 0 && ix < N - 1 && iy > 0 && iy < N - 1 && iz > 0 && iz < N - 1) continue;

          const materials = this.createMaterials(ix, iy, iz, N);
          const geo = new THREE.BoxGeometry(CUBIE_SIZE, CUBIE_SIZE, CUBIE_SIZE);
          // slight bevel feel via edges later
          const mesh = new THREE.Mesh(geo, materials);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.position.set((ix - half) * step, (iy - half) * step, (iz - half) * step);
          mesh.userData.cubie = true;
          this.group.add(mesh);
          this.cubies.push({ mesh, ix, iy, iz });

          // dark edge lines
          const edges = new THREE.EdgesGeometry(geo, 20);
          const line = new THREE.LineSegments(
            edges,
            new THREE.LineBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.85 }),
          );
          mesh.add(line);
        }
      }
    }
  }

  private createMaterials(ix: number, iy: number, iz: number, N: number): THREE.MeshStandardMaterial[] {
    const plastic = () =>
      new THREE.MeshStandardMaterial({
        color: FACE_COLORS.plastic,
        roughness: 0.55,
        metalness: 0.05,
      });
    const sticker = (face: FaceId) =>
      new THREE.MeshStandardMaterial({
        color: FACE_COLORS[face],
        roughness: 0.45,
        metalness: 0.06,
        // Keep face color readable from any orbit angle (esp. underside)
        emissive: FACE_COLORS[face],
        emissiveIntensity: 0.22,
      });

    // BoxGeometry: +X -X +Y -Y +Z -Z
    return [
      ix === N - 1 ? sticker('R') : plastic(),
      ix === 0 ? sticker('L') : plastic(),
      iy === N - 1 ? sticker('U') : plastic(),
      iy === 0 ? sticker('D') : plastic(),
      iz === N - 1 ? sticker('F') : plastic(),
      iz === 0 ? sticker('B') : plastic(),
    ];
  }

  /** Apply a single layer move (waits if busy) */
  async applyMove(move: LayerMove, record = true): Promise<void> {
    return this.playMoveDirect(move, record);
  }

  private animateMove(move: LayerMove, record: boolean): Promise<void> {
    return new Promise((resolve) => {
      this.animating = true;
      this.emit({ type: 'busy', busy: true });

      const { axis, layer, turns } = move;
      const selected = this.cubies.filter((c) => {
        if (axis === 'x') return c.ix === layer;
        if (axis === 'y') return c.iy === layer;
        return c.iz === layer;
      });

      // Parent selected cubies under a uniform-scale pivot for the turn.
      this.pivot.rotation.set(0, 0, 0);
      this.pivot.scale.set(1, 1, 1);
      for (const c of selected) {
        this.reparentUniform(c.mesh, this.pivot);
      }

      const targetAngle = (turns * Math.PI) / 2;
      const duration = (Math.abs(turns) === 2 ? 220 : 160) / this.animSpeed;
      const start = performance.now();

      const setPivotAngle = (angle: number) => {
        // Absolute euler — pivot always stays scale (1,1,1); no delta accumulation.
        if (axis === 'x') this.pivot.rotation.set(angle, 0, 0);
        else if (axis === 'y') this.pivot.rotation.set(0, angle, 0);
        else this.pivot.rotation.set(0, 0, angle);
        this.pivot.scale.set(1, 1, 1);
      };

      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        setPivotAngle(targetAngle * eased);

        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          // Exact final angle, then bake world pose into group-local.
          setPivotAngle(targetAngle);
          this.group.updateMatrixWorld(true);

          for (const c of selected) {
            this.reparentUniform(c.mesh, this.group);
            this.snapCubie(c);
            this.rotateIndices(c, axis, turns);
          }
          this.pivot.rotation.set(0, 0, 0);
          this.pivot.scale.set(1, 1, 1);
          this.enforceUniformScales();

          if (record) {
            this.history.push({ ...move });
            this.tracker.apply(move, this.order);
            const notation = moveToNotation(move, this.order);
            this.emit({ type: 'move', notation, historyLen: this.history.length });
          }

          this.animating = false;
          this.emit({ type: 'busy', busy: false });
          if (this.isSolved()) this.emit({ type: 'solved' });
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  /**
   * Reparent by baking world matrix → parent-local, then forcing scale (1,1,1).
   * Never use Object3D.attach: its matrix decompose can inject non-uniform scale
   * (especially after a singular orientation snap), stretching cubies into sticks.
   */
  private reparentUniform(object: THREE.Object3D, newParent: THREE.Object3D): void {
    object.updateWorldMatrix(true, false);
    newParent.updateWorldMatrix(true, false);

    // Capture world pose before the parent change.
    const worldMatrix = object.matrixWorld.clone();
    if (object.parent !== newParent) {
      newParent.add(object);
    }

    // local = inv(parent.matrixWorld) * object.matrixWorld
    const local = new THREE.Matrix4()
      .copy(newParent.matrixWorld)
      .invert()
      .multiply(worldMatrix);

    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    local.decompose(pos, quat, scl);

    object.position.copy(pos);
    object.quaternion.copy(quat);
    // Critical: discard decomposed scale entirely — keep cubies cube-shaped.
    object.scale.set(1, 1, 1);
    object.updateMatrix();
  }

  /** Safety net: every cubie must stay at uniform scale 1. */
  private enforceUniformScales(): void {
    for (const c of this.cubies) {
      const s = c.mesh.scale;
      if (s.x !== 1 || s.y !== 1 || s.z !== 1) {
        s.set(1, 1, 1);
        c.mesh.updateMatrix();
      }
    }
    this.pivot.scale.set(1, 1, 1);
  }

  private snapCubie(c: Cubie): void {
    const step = CUBIE_SIZE + GAP;
    const half = (this.order - 1) / 2;
    const p = c.mesh.position;
    p.x = Math.round(p.x / step) * step;
    p.y = Math.round(p.y / step) * step;
    p.z = Math.round(p.z / step) * step;

    // Always keep cubie scale uniform — attach/decompose must never leave sticks.
    c.mesh.scale.set(1, 1, 1);

    // Snap orientation by projecting basis vectors onto world axes.
    // NOTE: compare against bestAbs (not Math.abs(-Infinity)===Infinity), else
    // every vector falsely snaps to +X and the basis becomes singular.
    const axes = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
    ];
    const m = new THREE.Matrix4().makeRotationFromQuaternion(c.mesh.quaternion);
    const x = new THREE.Vector3().setFromMatrixColumn(m, 0);
    const y = new THREE.Vector3().setFromMatrixColumn(m, 1);
    const snapVec = (v: THREE.Vector3) => {
      let best = axes[0];
      let bestAbs = -1;
      let bestDot = 0;
      for (const a of axes) {
        const d = v.dot(a);
        const ad = Math.abs(d);
        if (ad > bestAbs) {
          bestAbs = ad;
          bestDot = d;
          best = a;
        }
      }
      return best.clone().multiplyScalar(Math.sign(bestDot) || 1);
    };
    const sx = snapVec(x);
    let sy = snapVec(y);
    // If X/Y snapped to the same axis (near-degenerate), pick an unused axis for Y.
    if (Math.abs(sx.dot(sy)) > 0.5) {
      sy = axes.find((a) => Math.abs(a.dot(sx)) < 0.5)!.clone();
    }
    const sz = new THREE.Vector3().crossVectors(sx, sy).normalize();
    sy.crossVectors(sz, sx).normalize();
    const snapped = new THREE.Matrix4().makeBasis(sx, sy, sz);
    c.mesh.quaternion.setFromRotationMatrix(snapped);
    c.mesh.updateMatrix();

    c.ix = Math.round(p.x / step + half);
    c.iy = Math.round(p.y / step + half);
    c.iz = Math.round(p.z / step + half);
  }

  private rotateIndices(c: Cubie, axis: Axis, turns: number): void {
    // Also recompute from snapped position — already done in snapCubie.
    // Keep for clarity; position-derived indices are authoritative.
    void c;
    void axis;
    void turns;
  }

  isSolved(): boolean {
    for (const c of this.cubies) {
      const mats = c.mesh.material as THREE.MeshStandardMaterial[];
      for (let mi = 0; mi < 6; mi++) {
        const hex = mats[mi].color.getHex();
        if (hex === FACE_COLORS.plastic) continue;
        const faces: FaceId[] = ['U', 'D', 'F', 'B', 'R', 'L'];
        const stickerFace = faces.find((f) => FACE_COLORS[f] === hex);
        if (!stickerFace) continue;
        const localN = new THREE.Vector3(
          mi === 0 ? 1 : mi === 1 ? -1 : 0,
          mi === 2 ? 1 : mi === 3 ? -1 : 0,
          mi === 4 ? 1 : mi === 5 ? -1 : 0,
        );
        const worldN = localN.applyQuaternion(c.mesh.quaternion).normalize();
        const exp = new THREE.Vector3(
          stickerFace === 'R' ? 1 : stickerFace === 'L' ? -1 : 0,
          stickerFace === 'U' ? 1 : stickerFace === 'D' ? -1 : 0,
          stickerFace === 'F' ? 1 : stickerFace === 'B' ? -1 : 0,
        );
        if (worldN.dot(exp) < 0.85) return false;
      }
    }
    return true;
  }

  async scramble(): Promise<void> {
    if (this.isBusy()) return;
    this.abortSolve = false;
    this.locked = true;
    this.emit({ type: 'busy', busy: true });
    const { moves, text, length } = generateScramble(this.order);
    this.emit({ type: 'scramble', text, length });
    this.emit({ type: 'status', message: `打乱中… (${length} 步)` });
    try {
      for (const m of moves) {
        if (this.abortSolve) break;
        await this.playMoveDirect(m, true);
      }
      this.emit({ type: 'status', message: `打乱完成 · ${length} 步` });
    } finally {
      this.locked = false;
      this.emit({ type: 'busy', busy: false });
    }
  }

  /** Direct animated move without nested queue complexity */
  private playMoveDirect(move: LayerMove, record: boolean): Promise<void> {
    return new Promise((resolve) => {
      const waitBusy = () => {
        if (this.animating) {
          requestAnimationFrame(waitBusy);
          return;
        }
        this.animateMove(move, record).then(resolve);
      };
      waitBusy();
    });
  }

  async solve(): Promise<void> {
    if (this.isBusy()) return;
    this.abortSolve = false;
    this.locked = true;
    this.emit({ type: 'busy', busy: true });

    try {
      let moves: LayerMove[] = [];
      let method = '';

      if (this.order === 3) {
        this.emit({ type: 'status', message: '正在初始化求解器…' });
        await ensureSolver();
        if (this.abortSolve) return;
        this.emit({ type: 'status', message: 'Kociemba 求解中…' });
        moves = await this.tracker.solve();
        method = 'Kociemba (cubejs)';
      } else {
        moves = reverseHistory(this.history);
        method = '逆序还原打乱路径';
      }

      if (this.abortSolve) return;

      if (moves.length === 0) {
        this.emit({ type: 'status', message: '已是复原状态' });
        this.emit({ type: 'solved' });
        return;
      }

      this.emit({
        type: 'status',
        message: `自动还原 · ${moves.length} 步（${method}）`,
      });

      for (const m of moves) {
        if (this.abortSolve) {
          this.emit({ type: 'status', message: '还原已中断' });
          return;
        }
        await this.playMoveDirect(m, false);
      }
      this.history = [];
      this.tracker.reset();
      this.emit({ type: 'status', message: `还原完成 · ${moves.length} 步` });
      this.emit({ type: 'solved' });
    } finally {
      this.locked = false;
      this.emit({ type: 'busy', busy: false });
    }
  }

  stop(): void {
    this.abortSolve = true;
  }

  /** Find cubie mesh under ray */
  pickCubie(raycaster: THREE.Raycaster): { mesh: THREE.Mesh; point: THREE.Vector3; faceNormal: THREE.Vector3 } | null {
    const meshes = this.cubies.map((c) => c.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const hit = hits[0];
    if (!hit.face) return null;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    return {
      mesh: hit.object as THREE.Mesh,
      point: hit.point.clone(),
      faceNormal: normal,
    };
  }

  /**
   * Determine layer move from a screen-space drag on a face sticker.
   *
   * Model (camera-aware, finger follows sticker):
   * 1. Snap hit face normal to a world axis → faceAxis.
   * 2. Two candidate rotation axes = the other two world axes.
   * 3. For each candidate R, RH +turn moves stickers along cross(R, N).
   *    Project that world motion into screen space at the hit point;
   *    score = screenDelta · screenMotion.
   * 4. Dominant |score| picks R; layer = cubie index along R;
   *    score>0 → +1 quarter (RH), else +3.
   *
   * screenDelta: client pixels (+x right, +y down), matching pointer events.
   */
  dragToMove(
    cubieMesh: THREE.Mesh,
    faceNormal: THREE.Vector3,
    screenDelta: THREE.Vector2,
    camera: THREE.Camera,
    hitPoint: THREE.Vector3,
  ): LayerMove | null {
    const cubie = this.cubies.find((c) => c.mesh === cubieMesh);
    if (!cubie) return null;
    if (screenDelta.lengthSq() < 1e-8) return null;

    const nRaw = faceNormal.clone().normalize();
    const abs = { x: Math.abs(nRaw.x), y: Math.abs(nRaw.y), z: Math.abs(nRaw.z) };
    let faceAxis: Axis = 'y';
    if (abs.x >= abs.y && abs.x >= abs.z) faceAxis = 'x';
    else if (abs.z >= abs.y && abs.z >= abs.x) faceAxis = 'z';
    else faceAxis = 'y';

    // Snap normal to ±unit axis so mapping stays stable after slight glancing hits
    const n = new THREE.Vector3(
      faceAxis === 'x' ? Math.sign(nRaw.x) || 1 : 0,
      faceAxis === 'y' ? Math.sign(nRaw.y) || 1 : 0,
      faceAxis === 'z' ? Math.sign(nRaw.z) || 1 : 0,
    );

    const candidates: Axis[] = (['x', 'y', 'z'] as Axis[]).filter((a) => a !== faceAxis);
    let bestAxis: Axis = candidates[0];
    let bestScore = 0;

    const origin = hitPoint.clone();
    const p0 = origin.clone().project(camera);

    for (const axis of candidates) {
      const axisDir = new THREE.Vector3(
        axis === 'x' ? 1 : 0,
        axis === 'y' ? 1 : 0,
        axis === 'z' ? 1 : 0,
      );
      // Sticker motion under positive RH rotation about axisDir
      const motion = new THREE.Vector3().crossVectors(axisDir, n);
      if (motion.lengthSq() < 1e-10) continue;
      motion.normalize();

      const p1 = origin.clone().add(motion).project(camera);
      // NDC y is up; client y is down → flip y to match pointer dy
      const sx = p1.x - p0.x;
      const sy = -(p1.y - p0.y);
      const score = screenDelta.x * sx + screenDelta.y * sy;
      if (Math.abs(score) > Math.abs(bestScore)) {
        bestScore = score;
        bestAxis = axis;
      }
    }

    if (Math.abs(bestScore) < 1e-12) return null;

    const layer = bestAxis === 'x' ? cubie.ix : bestAxis === 'y' ? cubie.iy : cubie.iz;
    const turns = (bestScore > 0 ? 1 : 3) as 1 | 3;
    return { axis: bestAxis, layer, turns };
  }

  getMoveRecords(): MoveRecord[] {
    return this.history.map((m) => ({ ...m, notation: moveToNotation(m, this.order) }));
  }
}
