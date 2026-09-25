import * as THREE from 'three';
import { FACE_COLORS, type FaceId } from './colors';
import type { Axis, LayerMove, MoveRecord } from './types';
import type { AnyMove, FaceButton, Puzzle, PuzzleEvent, VisualStyle } from './puzzle';
import { isFaceTurnMove } from './puzzle';
import { moveToNotation } from './notation';
import { generateScramble } from './scramble';
import { CubejsTracker, reverseHistory, ensureSolver } from './solver';
import { solveNxN, snapshotCube } from './nxn/solveNxN';

const CUBIE_SIZE = 1;
const GAP = 0.06;
/** Fraction of face reserved as dark plastic border (softens 1px sticker edges). */
const STICKER_INSET = 0.1;
const STICKER_CORNER = 0.08;

/** Sticker = inset rounded stickers + black rim; full = seamless solid face color. */
export type { VisualStyle } from './puzzle';

export type CubeEvent = PuzzleEvent;

type Listener = (e: CubeEvent) => void;

interface Cubie {
  mesh: THREE.Mesh;
  ix: number;
  iy: number;
  iz: number;
}

export class RubiksCube implements Puzzle {
  readonly puzzleType = 'cube' as const;
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
  private castShadows = true;
  /** Layer turn driven by main rAF via update() — not a nested rAF loop. */
  private turnAnim: {
    selected: Cubie[];
    move: LayerMove;
    record: boolean;
    targetAngle: number;
    startMs: number;
    durationMs: number;
    resolve: () => void;
  } | null = null;
  // Scratch objects reused across reparent/snap (no per-call alloc)
  private readonly _worldMat = new THREE.Matrix4();
  private readonly _localMat = new THREE.Matrix4();
  private readonly _pos = new THREE.Vector3();
  private readonly _quat = new THREE.Quaternion();
  private readonly _scl = new THREE.Vector3();
  private readonly _rotMat = new THREE.Matrix4();
  private readonly _vx = new THREE.Vector3();
  private readonly _vy = new THREE.Vector3();
  private readonly _vz = new THREE.Vector3();
  private readonly _axes = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];
  private _sharedGeo: THREE.BoxGeometry | null = null;
  private _sharedEdges: THREE.EdgesGeometry | null = null;
  private _edgeMat: THREE.LineBasicMaterial | null = null;
  private _stickerBorderMap: THREE.CanvasTexture | null = null;
  private visualStyle: VisualStyle = 'sticker';

  constructor(order = 3, style: VisualStyle = 'sticker') {
    this.order = order;
    this.visualStyle = style;
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

  /** Enable/disable cubie shadows (turn off on mobile for smoother turns). */
  setCastShadows(enabled: boolean): void {
    this.castShadows = enabled;
    for (const c of this.cubies) {
      c.mesh.castShadow = enabled;
      c.mesh.receiveShadow = enabled;
    }
  }

  getVisualStyle(): VisualStyle {
    return this.visualStyle;
  }

  /**
   * Swap sticker vs full-color materials on the live cube (no rebuild / no
   * scramble reset). Plastic (internal) faces stay black either way.
   */
  setVisualStyle(style: VisualStyle): void {
    if (style !== 'sticker' && style !== 'full') return;
    if (style === this.visualStyle) return;
    this.visualStyle = style;
    this.applyVisualStyleToMaterials();
  }

  private applyVisualStyleToMaterials(): void {
    for (const c of this.cubies) {
      const mats = c.mesh.material as THREE.MeshStandardMaterial[];
      for (const mat of mats) {
        this.styleMaterial(mat);
      }
    }
  }

  /** Apply current visualStyle to a sticker or plastic material in place. */
  private styleMaterial(mat: THREE.MeshStandardMaterial): void {
    const isPlastic = mat.color.getHex() === FACE_COLORS.plastic;
    if (isPlastic) {
      mat.map = null;
      mat.emissiveMap = null;
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;
      mat.needsUpdate = true;
      return;
    }
    if (this.visualStyle === 'sticker') {
      const borderMap = this._stickerBorderMap;
      mat.map = borderMap;
      mat.emissive.copy(mat.color);
      mat.emissiveIntensity = 0.22;
      mat.emissiveMap = borderMap;
    } else {
      // Full-color tile: solid face color across the whole cubie face
      mat.map = null;
      mat.emissiveMap = null;
      mat.emissive.copy(mat.color);
      mat.emissiveIntensity = 0.22;
    }
    mat.needsUpdate = true;
  }

  /**
   * Advance the in-flight layer turn. Must be called every frame from the
   * main requestAnimationFrame render loop so rotation and draw stay in sync.
   */
  update(nowMs: number = performance.now()): void {
    const anim = this.turnAnim;
    if (!anim) return;

    const t = Math.min(1, (nowMs - anim.startMs) / anim.durationMs);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    this.setPivotAngle(anim.move.axis, anim.targetAngle * eased);

    if (t < 1) return;
    this.completeTurn(anim);
  }

  private setPivotAngle(axis: Axis, angle: number): void {
    if (axis === 'x') this.pivot.rotation.set(angle, 0, 0);
    else if (axis === 'y') this.pivot.rotation.set(0, angle, 0);
    else this.pivot.rotation.set(0, 0, angle);
  }

  private completeTurn(anim: NonNullable<RubiksCube['turnAnim']>): void {
    const { selected, move, record, targetAngle, resolve } = anim;
    this.setPivotAngle(move.axis, targetAngle);
    this.group.updateMatrixWorld(true);

    for (const c of selected) {
      this.reparentUniform(c.mesh, this.group);
      this.snapCubie(c);
      this.rotateIndices(c, move.axis, move.turns);
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

    this.turnAnim = null;
    this.animating = false;
    this.emit({ type: 'busy', busy: false });
    if (this.isSolved()) this.emit({ type: 'solved' });
    resolve();
  }

  getHistoryLength(): number {
    return this.history.length;
  }

  setOrder(n: number): void {
    if (n < 2 || n > 20 || n === this.order) {
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
    if (this.turnAnim) {
      const r = this.turnAnim.resolve;
      this.turnAnim = null;
      this.animating = false;
      r(); // after animating=false so queued moves do not spin-wait
    }
    this.history = [];
    this.tracker.reset();
    this.animating = false;
    this.emit({ type: 'busy', busy: false });
  }

  private build(): void {
    // clear old cubies (may currently be under pivot mid-animation)
    for (const c of this.cubies) {
      c.mesh.removeFromParent();
      const mats = c.mesh.material as THREE.Material[];
      mats.forEach((m) => m.dispose());
      // dispose per-mesh edge lines (shared edge geo/mat kept)
      for (const child of [...c.mesh.children]) {
        c.mesh.remove(child);
      }
    }
    this.cubies = [];
    while (this.pivot.children.length) {
      this.pivot.remove(this.pivot.children[0]);
    }
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.scale.set(1, 1, 1);

    // Shared geometry across all cubies — avoids per-cubie GPU buffer churn
    if (!this._sharedGeo) {
      this._sharedGeo = new THREE.BoxGeometry(CUBIE_SIZE, CUBIE_SIZE, CUBIE_SIZE);
      this._sharedEdges = new THREE.EdgesGeometry(this._sharedGeo, 20);
      // Soft silhouette: low-opacity edge lines (MSAA + inset stickers do the heavy lifting)
      this._edgeMat = new THREE.LineBasicMaterial({
        color: 0x050505,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      this._stickerBorderMap = this.createStickerBorderMap();
    }

    const N = this.order;
    const half = (N - 1) / 2;
    const step = CUBIE_SIZE + GAP;
    const geo = this._sharedGeo!;
    const edges = this._sharedEdges!;
    const edgeMat = this._edgeMat!;

    for (let ix = 0; ix < N; ix++) {
      for (let iy = 0; iy < N; iy++) {
        for (let iz = 0; iz < N; iz++) {
          // skip completely internal cubies
          if (ix > 0 && ix < N - 1 && iy > 0 && iy < N - 1 && iz > 0 && iz < N - 1) continue;

          const materials = this.createMaterials(ix, iy, iz, N);
          const mesh = new THREE.Mesh(geo, materials);
          mesh.castShadow = this.castShadows;
          mesh.receiveShadow = this.castShadows;
          mesh.position.set((ix - half) * step, (iy - half) * step, (iz - half) * step);
          mesh.userData.cubie = true;
          this.group.add(mesh);
          this.cubies.push({ mesh, ix, iy, iz });

          mesh.add(new THREE.LineSegments(edges, edgeMat));
        }
      }
    }
  }

  /**
   * Grayscale map: white rounded sticker × material.color / emissive.
   * Outer rim must be pure black (#000) so color×map and emissive×emissiveMap
   * stay neutral plastic (not face-tinted dark red/blue/etc).
   */
  private createStickerBorderMap(): THREE.CanvasTexture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    // Pure black rim: any face color × 0 = black, matching plastic across faces.
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, size, size);
    const inset = STICKER_INSET * size;
    const r = STICKER_CORNER * size;
    const x = inset;
    const y = inset;
    const w = size - inset * 2;
    const h = size - inset * 2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
    ctx.fill();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  private createMaterials(ix: number, iy: number, iz: number, N: number): THREE.MeshStandardMaterial[] {
    const plastic = () =>
      new THREE.MeshStandardMaterial({
        color: FACE_COLORS.plastic,
        roughness: 0.55,
        metalness: 0.05,
      });
    const sticker = (face: FaceId) => {
      const mat = new THREE.MeshStandardMaterial({
        color: FACE_COLORS[face],
        roughness: 0.45,
        metalness: 0.06,
        // Keep face color readable from any orbit angle (esp. underside)
        emissive: FACE_COLORS[face],
        emissiveIntensity: 0.22,
      });
      this.styleMaterial(mat);
      return mat;
    };

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
  async applyMove(move: AnyMove, record = true): Promise<void> {
    if (isFaceTurnMove(move)) return;
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

      // Longer base duration → more interpolated frames even if device dips below 60fps.
      // Speed slider still scales via animSpeed (scramble/solve stay snappy when raised).
      // turns=3 is logically +3π/2 ≡ −π/2; animate the short signed arc (never +270°/long way).
      const signedQuarters = turns === 3 ? -1 : turns;
      const targetAngle = (signedQuarters * Math.PI) / 2;
      const durationMs = (Math.abs(signedQuarters) === 2 ? 320 : 240) / this.animSpeed;

      this.turnAnim = {
        selected,
        move,
        record,
        targetAngle,
        startMs: performance.now(),
        durationMs,
        resolve,
      };
      // First pose immediately so the upcoming render frame is not a blank hold
      this.setPivotAngle(axis, 0);
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

    // Capture world pose before the parent change (reuse scratch, no clone alloc).
    this._worldMat.copy(object.matrixWorld);
    if (object.parent !== newParent) {
      newParent.add(object);
    }

    // local = inv(parent.matrixWorld) * object.matrixWorld
    this._localMat.copy(newParent.matrixWorld).invert().multiply(this._worldMat);
    this._localMat.decompose(this._pos, this._quat, this._scl);

    object.position.copy(this._pos);
    object.quaternion.copy(this._quat);
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
    const N = this.order;

    // Round indices first, then write positions from indices.
    // Even-order centers sit on half-integer multiples of step (e.g. ±0.5, ±1.5);
    // Math.round(p/step)*step is wrong because JS Math.round(-0.5) === 0.
    c.ix = Math.max(0, Math.min(N - 1, Math.round(p.x / step + half)));
    c.iy = Math.max(0, Math.min(N - 1, Math.round(p.y / step + half)));
    c.iz = Math.max(0, Math.min(N - 1, Math.round(p.z / step + half)));
    p.x = (c.ix - half) * step;
    p.y = (c.iy - half) * step;
    p.z = (c.iz - half) * step;

    // Always keep cubie scale uniform — attach/decompose must never leave sticks.
    c.mesh.scale.set(1, 1, 1);

    // Snap orientation by projecting basis vectors onto world axes.
    // NOTE: compare against bestAbs (not Math.abs(-Infinity)===Infinity), else
    // every vector falsely snaps to +X and the basis becomes singular.
    const axes = this._axes;
    this._rotMat.makeRotationFromQuaternion(c.mesh.quaternion);
    this._vx.setFromMatrixColumn(this._rotMat, 0);
    this._vy.setFromMatrixColumn(this._rotMat, 1);

    const snapInto = (v: THREE.Vector3, out: THREE.Vector3) => {
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
      return out.copy(best).multiplyScalar(Math.sign(bestDot) || 1);
    };

    const sx = snapInto(this._vx, this._pos); // reuse _pos as sx scratch
    const sy = snapInto(this._vy, this._scl); // reuse _scl as sy scratch
    // If X/Y snapped to the same axis (near-degenerate), pick an unused axis for Y.
    if (Math.abs(sx.dot(sy)) > 0.5) {
      const alt = axes.find((a) => Math.abs(a.dot(sx)) < 0.5)!;
      sy.copy(alt);
    }
    this._vz.crossVectors(sx, sy).normalize();
    sy.crossVectors(this._vz, sx).normalize();
    this._rotMat.makeBasis(sx, sy, this._vz);
    c.mesh.quaternion.setFromRotationMatrix(this._rotMat);
    c.mesh.updateMatrix();
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

      if (this.order === 2 || this.order === 3) {
        this.emit({ type: 'status', message: '正在初始化求解器…' });
        await ensureSolver();
        if (this.abortSolve) return;
        this.emit({ type: 'status', message: 'Kociemba 求解中…' });
        moves = await this.tracker.solve(this.order);
        method = this.order === 2 ? 'Kociemba (cubejs·二阶)' : 'Kociemba (cubejs)';
        // Prefer real solver; fall back to reverse history only if cubejs gave nothing
        // while the cube is still scrambled and we have recorded moves.
        if (moves.length === 0 && this.history.length > 0 && !this.isSolved()) {
          moves = reverseHistory(this.history);
          method = '逆序还原打乱路径';
        }
      } else if (this.order === 4 || this.order === 5) {
        const label = this.order === 4 ? '还原法（四阶）' : '还原法（五阶）';
        this.emit({ type: 'status', message: `${label} · 分析状态…` });
        const facelet = snapshotCube(
          this.order,
          this.cubies.map((c) => ({ mesh: c.mesh, ix: c.ix, iy: c.iy, iz: c.iz })),
        );
        const result = await solveNxN(facelet, {
          deadlineMs: 90_000,
          shouldAbort: () => this.abortSolve,
          onProgress: (msg) => this.emit({ type: 'status', message: msg }),
        });
        if (this.abortSolve) return;
        if (result.moves.length > 0 && !result.error) {
          moves = result.moves;
          method = result.method;
        } else if (this.history.length > 0) {
          moves = reverseHistory(this.history);
          method = '逆序还原打乱路径';
          this.emit({
            type: 'status',
            message: result.error
              ? `${label}失败（${result.error}），改用逆序还原…`
              : `${label}失败，改用逆序还原…`,
          });
        } else {
          this.emit({
            type: 'status',
            message: result.error
              ? `${label}失败：${result.error}`
              : `${label}失败（无历史可回退）`,
          });
          return;
        }
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

  getFitDistance(): number {
    return 4.2 + this.order * 0.85;
  }

  getFloorY(): number {
    return -((this.order * 1.06) / 2 + 0.8);
  }

  getFaceButtons(): FaceButton[] {
    return [];
  }

  dispose(): void {
    this.stop();
    for (const c of this.cubies) {
      c.mesh.removeFromParent();
      (c.mesh.material as THREE.Material[]).forEach((m) => m.dispose());
    }
    this.cubies = [];
    this._sharedGeo?.dispose();
    this._sharedEdges?.dispose();
    this._edgeMat?.dispose();
    this._stickerBorderMap?.dispose();
    this._sharedGeo = null;
    this._sharedEdges = null;
    this._edgeMat = null;
    this._stickerBorderMap = null;
    this.group.clear();
    this.listeners = [];
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
