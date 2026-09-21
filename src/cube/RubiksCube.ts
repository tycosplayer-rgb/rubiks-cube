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
    // clear old cubies
    for (const c of this.cubies) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
      const mats = c.mesh.material as THREE.Material[];
      mats.forEach((m) => m.dispose());
    }
    this.cubies = [];
    while (this.pivot.children.length) {
      this.group.attach(this.pivot.children[0]);
    }

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
        roughness: 0.42,
        metalness: 0.08,
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

      // attach to pivot
      this.pivot.rotation.set(0, 0, 0);
      for (const c of selected) {
        this.pivot.attach(c.mesh);
      }

      const targetAngle = (turns * Math.PI) / 2;
      const duration = (Math.abs(turns) === 2 ? 220 : 160) / this.animSpeed;
      const start = performance.now();
      let current = 0;

      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const angle = targetAngle * eased;
        const delta = angle - current;
        current = angle;
        if (axis === 'x') this.pivot.rotateX(delta);
        else if (axis === 'y') this.pivot.rotateY(delta);
        else this.pivot.rotateZ(delta);

        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          // finalize
          for (const c of selected) {
            this.group.attach(c.mesh);
            this.snapCubie(c);
            this.rotateIndices(c, axis, turns);
          }
          this.pivot.rotation.set(0, 0, 0);

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

  private snapCubie(c: Cubie): void {
    const step = CUBIE_SIZE + GAP;
    const half = (this.order - 1) / 2;
    const p = c.mesh.position;
    p.x = Math.round(p.x / step) * step;
    p.y = Math.round(p.y / step) * step;
    p.z = Math.round(p.z / step) * step;

    // Snap orientation by projecting basis vectors onto world axes
    const q = c.mesh.quaternion;
    const axes = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
    ];
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const x = new THREE.Vector3().setFromMatrixColumn(m, 0);
    const y = new THREE.Vector3().setFromMatrixColumn(m, 1);
    const snapVec = (v: THREE.Vector3) => {
      let best = axes[0];
      let bestDot = -Infinity;
      for (const a of axes) {
        const d = v.dot(a);
        if (Math.abs(d) > Math.abs(bestDot)) {
          bestDot = d;
          best = a.clone().multiplyScalar(Math.sign(d) || 1);
        }
      }
      return best;
    };
    const sx = snapVec(x);
    const sy = snapVec(y);
    const sz = new THREE.Vector3().crossVectors(sx, sy).normalize();
    // re-orthogonalize sy
    sy.crossVectors(sz, sx).normalize();
    const snapped = new THREE.Matrix4().makeBasis(sx, sy, sz);
    c.mesh.quaternion.setFromRotationMatrix(snapped);

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
   * Determine layer move from drag on a face.
   * drag: world-space delta projected onto face plane.
   */
  dragToMove(
    cubieMesh: THREE.Mesh,
    faceNormal: THREE.Vector3,
    dragWorld: THREE.Vector3,
  ): LayerMove | null {
    const cubie = this.cubies.find((c) => c.mesh === cubieMesh);
    if (!cubie) return null;

    const n = faceNormal.clone().normalize();
    // dominant face axis
    const abs = { x: Math.abs(n.x), y: Math.abs(n.y), z: Math.abs(n.z) };
    let faceAxis: Axis = 'y';
    if (abs.x >= abs.y && abs.x >= abs.z) faceAxis = 'x';
    else if (abs.z >= abs.y && abs.z >= abs.x) faceAxis = 'z';
    else faceAxis = 'y';

    // project drag onto plane
    const drag = dragWorld.clone().projectOnPlane(n);
    if (drag.length() < 1e-6) return null;

    // choose tangential axis with largest drag component
    const candidates: Axis[] = (['x', 'y', 'z'] as Axis[]).filter((a) => a !== faceAxis);
    let moveAxis: Axis = candidates[0];
    let best = 0;
    for (const a of candidates) {
      const v = new THREE.Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0);
      const mag = Math.abs(drag.dot(v));
      if (mag > best) {
        best = mag;
        moveAxis = a;
      }
    }

    // layer = cubie index along moveAxis
    const layer = moveAxis === 'x' ? cubie.ix : moveAxis === 'y' ? cubie.iy : cubie.iz;

    // sense: cross(faceNormal, moveAxisDir) gives positive drag direction for +RH turn
    const axisDir = new THREE.Vector3(
      moveAxis === 'x' ? 1 : 0,
      moveAxis === 'y' ? 1 : 0,
      moveAxis === 'z' ? 1 : 0,
    );
    const positiveDragDir = new THREE.Vector3().crossVectors(n, axisDir).normalize();
    const sense = Math.sign(drag.dot(positiveDragDir));
    if (sense === 0) return null;

    // sense > 0 → +1 turn (RH); sense < 0 → +3
    const turns = (sense > 0 ? 1 : 3) as 1 | 3;
    return { axis: moveAxis, layer, turns };
  }

  getMoveRecords(): MoveRecord[] {
    return this.history.map((m) => ({ ...m, notation: moveToNotation(m, this.order) }));
  }
}
