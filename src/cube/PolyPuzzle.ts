import * as THREE from 'three';
import type {
  AnyMove,
  FaceButton,
  FaceTurnMove,
  Puzzle,
  PuzzleEvent,
  PuzzlePick,
  PuzzleType,
  VisualStyle,
} from './puzzle';
import { isFaceTurnMove } from './puzzle';

export interface PolyFace {
  id: string;
  label: string;
  axis: THREE.Vector3;
  color: number;
  colorCss: string;
}

export interface PolyTile {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  initialMatrix: THREE.Matrix4;
}

/** Shared animated/history engine for finite-symmetry twisty polyhedra (facelet layers). */
export abstract class PolyPuzzle implements Puzzle {
  readonly group = new THREE.Group();
  abstract readonly puzzleType: PuzzleType;
  protected readonly pivot = new THREE.Group();
  protected tiles: PolyTile[] = [];
  protected faces: PolyFace[] = [];
  protected core: THREE.Mesh | null = null;
  protected history: FaceTurnMove[] = [];
  protected listeners: Array<(e: PuzzleEvent) => void> = [];
  protected speed = 1;
  protected busy = false;
  protected locked = false;
  protected stopped = false;
  protected castShadows = true;
  protected style: VisualStyle;
  private turnAnim: {
    move: FaceTurnMove;
    selected: PolyTile[];
    /** Angle at animation start (continuous-drag snap). */
    from: number;
    target: number;
    started: number;
    duration: number;
    record: boolean;
    easing: 'inout' | 'outCubic';
    resolve: () => void;
  } | null = null;
  /** True while pointer is actively twisting a layer (before snap). */
  protected dragging = false;
  private interactive: {
    move: FaceTurnMove;
    selected: PolyTile[];
    axis: THREE.Vector3;
    angle: number;
  } | null = null;
  private readonly _world = new THREE.Matrix4();
  private readonly _local = new THREE.Matrix4();
  private readonly _pos = new THREE.Vector3();
  private readonly _quat = new THREE.Quaternion();
  private readonly _scl = new THREE.Vector3();

  constructor(style: VisualStyle) {
    this.style = style;
    this.group.add(this.pivot);
  }

  protected finishBuild(): void {
    this.group.updateMatrixWorld(true);
    for (const tile of this.tiles) {
      tile.mesh.updateMatrix();
      tile.initialMatrix.copy(tile.mesh.matrix);
      tile.mesh.castShadow = this.castShadows;
      tile.mesh.receiveShadow = this.castShadows;
    }
    if (this.core) {
      this.core.castShadow = this.castShadows;
      this.core.receiveShadow = this.castShadows;
    }
    this.applyStyle();
  }

  on(fn: (e: PuzzleEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn);
    };
  }

  protected emit(e: PuzzleEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  isBusy(): boolean {
    return this.busy || this.locked || this.dragging;
  }

  setSpeed(mult: number): void {
    this.speed = THREE.MathUtils.clamp(mult, 0.25, 4);
  }

  getVisualStyle(): VisualStyle {
    return this.style;
  }

  getHistoryLength(): number {
    return this.history.length;
  }

  stop(): void {
    this.stopped = true;
  }

  setCastShadows(enabled: boolean): void {
    this.castShadows = enabled;
    for (const t of this.tiles) t.mesh.castShadow = t.mesh.receiveShadow = enabled;
    if (this.core) this.core.castShadow = this.core.receiveShadow = enabled;
  }


  /** Pull core inward while a layer spins so shear gaps do not flash black. */
  protected setCoreTurnSafe(animating: boolean): void {
    if (!this.core) return;
    this.core.scale.setScalar(animating ? 0.90 : 1);
  }

  setVisualStyle(style: VisualStyle): void {
    if (style !== 'sticker' && style !== 'full') return;
    this.style = style;
    this.applyStyle();
  }

  private applyStyle(): void {
    for (const { mesh } of this.tiles) {
      mesh.material.roughness = this.style === 'sticker' ? 0.42 : 0.35;
      mesh.material.metalness = this.style === 'sticker' ? 0.03 : 0.08;
      mesh.material.emissive.copy(mesh.material.color);
      mesh.material.emissiveIntensity = 0.18;
      mesh.scale.setScalar(this.styleScale());
      mesh.material.needsUpdate = true;
    }
  }

  update(nowMs = performance.now()): void {
    const a = this.turnAnim;
    if (!a) return;
    const t = Math.min(1, (nowMs - a.started) / a.duration);
    const eased =
      a.easing === 'outCubic'
        ? 1 - Math.pow(1 - t, 3)
        : t < 0.5
          ? 2 * t * t
          : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const angle = a.from + (a.target - a.from) * eased;
    this.pivot.setRotationFromAxisAngle(this.faceOf(a.move.face).axis, angle);
    if (t < 1) return;
    this.pivot.setRotationFromAxisAngle(this.faceOf(a.move.face).axis, a.target);
    this.group.updateMatrixWorld(true);
    for (const tile of a.selected) this.reparentUniform(tile.mesh, this.group);
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.scale.set(1, 1, 1);
    if (a.record) {
      this.history.push({ ...a.move });
      this.emit({ type: 'move', notation: this.notation(a.move), historyLen: this.history.length });
    }
    this.setCoreTurnSafe(false);
    this.turnAnim = null;
    this.busy = false;
    if (!this.locked) this.emit({ type: 'busy', busy: false });
    a.resolve();
  }

  async applyMove(move: AnyMove, record = true): Promise<void> {
    if (!isFaceTurnMove(move) || !this.faces.some((f) => f.id === move.face)) return;
    while (this.busy || this.dragging || this.interactive) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    return new Promise<void>((resolve) => {
      const selected = this.selectLayer(move);
      if (!selected.length) {
        resolve();
        return;
      }
      this.busy = true;
      this.emit({ type: 'busy', busy: true });
      this.pivot.rotation.set(0, 0, 0);
      this.pivot.scale.set(1, 1, 1);
      for (const tile of selected) this.reparentUniform(tile.mesh, this.pivot);
      this.setCoreTurnSafe(true);
      this.turnAnim = {
        move: { ...move },
        selected,
        from: 0,
        target: this.turnAngle(move),
        record,
        easing: 'inout',
        resolve,
        started: performance.now(),
        duration: 330 / this.speed,
      };
    });
  }

  /**
   * Start an interactive (pointer-followed) layer turn.
   * Reparents the layer into the pivot; call setInteractiveAngle each move.
   */
  beginInteractiveTurn(skeleton: {
    face: string;
    tip?: boolean;
    bottom?: boolean;
  }): boolean {
    if (this.busy || this.locked || this.dragging || this.turnAnim || this.interactive) return false;
    if (!this.faces.some((f) => f.id === skeleton.face)) return false;
    const move: FaceTurnMove = {
      kind: 'face',
      face: skeleton.face,
      steps: 0,
      ...(skeleton.tip ? { tip: true } : {}),
      ...(skeleton.bottom ? { bottom: true } : {}),
    };
    const selected = this.selectLayer(move);
    if (!selected.length) return false;
    this.dragging = true;
    this.emit({ type: 'busy', busy: true });
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.scale.set(1, 1, 1);
    for (const tile of selected) this.reparentUniform(tile.mesh, this.pivot);
    this.setCoreTurnSafe(true);
    this.interactive = {
      move,
      selected,
      axis: this.faceOf(move.face).axis.clone(),
      angle: 0,
    };
    return true;
  }

  setInteractiveAngle(radians: number): void {
    if (!this.interactive) return;
    this.interactive.angle = radians;
    this.pivot.setRotationFromAxisAngle(this.interactive.axis, radians);
  }

  getInteractiveAngle(): number {
    return this.interactive?.angle ?? 0;
  }

  /** Snap/animate to commitSteps * turnAngle, bake history if steps ≠ 0. */
  finishInteractiveTurn(commitSteps: number): Promise<void> {
    const state = this.interactive;
    if (!state) return Promise.resolve();
    this.interactive = null;
    this.dragging = false;
    const move: FaceTurnMove = {
      ...state.move,
      steps: commitSteps,
    };
    const target = commitSteps === 0 ? 0 : this.turnAngle(move);
    const from = state.angle;
    // Already at target (rare) — bake immediately.
    if (Math.abs(from - target) < 1e-5) {
      this.pivot.setRotationFromAxisAngle(state.axis, target);
      this.group.updateMatrixWorld(true);
      for (const tile of state.selected) this.reparentUniform(tile.mesh, this.group);
      this.pivot.rotation.set(0, 0, 0);
      this.pivot.scale.set(1, 1, 1);
      this.setCoreTurnSafe(false);
      if (commitSteps !== 0) {
        this.history.push({ ...move });
        this.emit({ type: 'move', notation: this.notation(move), historyLen: this.history.length });
      }
      if (!this.locked) this.emit({ type: 'busy', busy: false });
      return Promise.resolve();
    }
    this.busy = true;
    return new Promise<void>((resolve) => {
      this.turnAnim = {
        move,
        selected: state.selected,
        from,
        target,
        record: commitSteps !== 0,
        easing: 'outCubic',
        resolve,
        started: performance.now(),
        duration: 240 / this.speed,
      };
    });
  }

  /** Abort interactive turn: restore angle 0, no history. */
  cancelInteractiveTurn(): void {
    const state = this.interactive;
    if (!state) return;
    this.interactive = null;
    this.dragging = false;
    this.pivot.setRotationFromAxisAngle(state.axis, 0);
    this.group.updateMatrixWorld(true);
    for (const tile of state.selected) this.reparentUniform(tile.mesh, this.group);
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.scale.set(1, 1, 1);
    this.setCoreTurnSafe(false);
    if (!this.busy && !this.locked) this.emit({ type: 'busy', busy: false });
  }

    protected styleScale(): number {
    return this.style === 'sticker' ? 1 : 1.03;
  }

  protected reparentUniform(object: THREE.Object3D, newParent: THREE.Object3D): void {
    object.updateWorldMatrix(true, false);
    newParent.updateWorldMatrix(true, false);
    this._world.copy(object.matrixWorld);
    if (object.parent !== newParent) newParent.add(object);
    this._local.copy(newParent.matrixWorld).invert().multiply(this._world);
    this._local.decompose(this._pos, this._quat, this._scl);
    object.position.copy(this._pos);
    object.quaternion.copy(this._quat);
    // Keep sticker/full-color scale; forcing 1 opens gaps that show the dark core.
    object.scale.setScalar(this.styleScale());
    object.updateMatrix();
  }

  protected abstract selectLayer(move: FaceTurnMove): PolyTile[];
  protected abstract turnAngle(move: FaceTurnMove): number;
  protected abstract scrambleLength(): number;
  abstract getFitDistance(): number;
  abstract getFloorY(): number;

  protected faceOf(id: string): PolyFace {
    return this.faces.find((f) => f.id === id)!;
  }

  protected notation(m: FaceTurnMove): string {
    const face =
      m.bottom ? `${m.face}w` : m.tip ? m.face.toLowerCase() : m.face;
    const abs = Math.abs(m.steps);
    const twice = abs === 2 ? '2' : '';
    return `${face}${twice}${m.steps < 0 ? "'" : ''}`;
  }

  getFaceButtons(): FaceButton[] {
    return this.faces.map((f) => ({ id: f.id, label: f.label, color: f.colorCss }));
  }

  async scramble(): Promise<void> {
    if (this.isBusy()) return;
    this.stopped = false;
    this.locked = true;
    this.emit({ type: 'busy', busy: true });
    // Fresh scramble baseline so "自动还原" undoes this scramble (plus any later moves).
    this.history = [];
    this.emit({ type: 'move', notation: '', historyLen: 0 });
    const length = this.scrambleLength();
    const moves: FaceTurnMove[] = [];
    let previous = '';
    for (let i = 0; i < length; i++) {
      let face = this.faces[Math.floor(Math.random() * this.faces.length)].id;
      while (face === previous) face = this.faces[Math.floor(Math.random() * this.faces.length)].id;
      previous = face;
      moves.push({ kind: 'face', face, steps: Math.random() < 0.5 ? 1 : -1 });
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

  async solve(): Promise<void> {
    if (this.isBusy()) return;
    if (!this.history.length) {
      this.emit({ type: 'status', message: '已是复原状态（无可回放历史）' });
      this.emit({ type: 'solved' });
      return;
    }
    this.stopped = false;
    this.locked = true;
    this.emit({ type: 'busy', busy: true });
    const moves = [...this.history].reverse().map((m) => ({ ...m, steps: -m.steps as 1 | -1 }));
    this.emit({ type: 'status', message: `自动还原 · ${moves.length} 步（逆序历史）` });
    try {
      for (const m of moves) {
        if (this.stopped) break;
        await this.applyMove(m, false);
      }
      if (!this.stopped) {
        this.history = [];
        this.emit({ type: 'status', message: `还原完成 · ${moves.length} 步` });
        this.emit({ type: 'solved' });
      }
    } finally {
      this.locked = false;
      this.emit({ type: 'busy', busy: false });
    }
  }

  reset(): void {
    if (this.isBusy()) return;
    this.setCoreTurnSafe(false);
    for (const tile of this.tiles) {
      if (tile.mesh.parent !== this.group) this.group.add(tile.mesh);
      tile.mesh.matrix.copy(tile.initialMatrix);
      tile.mesh.matrix.decompose(tile.mesh.position, tile.mesh.quaternion, tile.mesh.scale);
      tile.mesh.scale.setScalar(this.styleScale());
      tile.mesh.updateMatrix();
    }
    this.history = [];
    this.stopped = false;
    this.emit({ type: 'move', notation: '', historyLen: 0 });
    this.emit({ type: 'status', message: '已复位' });
  }

  /**
   * Resolve which face/tip the pointer is on *right now*.
   * Default: max hitPoint · face.axis (works for tip-axis puzzles like Pyraminx).
   * Megaminx overrides to prefer face.axis · hitWorldNormal.
   * Do not trust stale mesh.userData.turnFace after scramble/turns.
   */
  protected resolveHitFace(point: THREE.Vector3, _normal?: THREE.Vector3): PolyFace | null {
    if (!this.faces.length) return null;
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

  pickCubie(raycaster: THREE.Raycaster): PuzzlePick | null {
    const hit = raycaster.intersectObjects(
      this.tiles.map((t) => t.mesh),
      false,
    )[0];
    if (!hit?.face) return null;
    const point = hit.point.clone();
    const faceNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    const face = this.resolveHitFace(point, faceNormal);
    // Keep userData in sync for any code still reading turnFace.
    if (face) (hit.object as THREE.Mesh).userData.turnFace = face.id;
    return {
      mesh: hit.object as THREE.Mesh,
      point,
      faceNormal,
      faceId: face?.id ?? '',
    };
  }

  dragToMove(
    mesh: THREE.Mesh,
    normal: THREE.Vector3,
    delta: THREE.Vector2,
    camera: THREE.Camera,
    point: THREE.Vector3,
  ): AnyMove | null {
    if (delta.lengthSq() < 1) return null;
    const f = this.resolveHitFace(point, normal);
    if (!f) return null;
    if (mesh.userData) mesh.userData.turnFace = f.id;
    // Camera-aware finger-follows: project RH tangent (axis × radial) into screen;
    // swipe aligned with that motion → +1 step (RH about outward / tip axis).
    const p0 = point.clone().project(camera);
    const radial = point.clone().sub(f.axis.clone().multiplyScalar(point.dot(f.axis)));
    const tangent = new THREE.Vector3().crossVectors(f.axis, radial);
    if (tangent.lengthSq() < 1e-6) tangent.crossVectors(f.axis, camera.position.clone().sub(point));
    if (tangent.lengthSq() < 1e-6) return null;
    const p1 = point.clone().add(tangent.normalize()).project(camera);
    const score = delta.x * (p1.x - p0.x) + delta.y * -(p1.y - p0.y);
    return { kind: 'face', face: f.id, steps: score >= 0 ? 1 : -1 };
  }

  protected addTile(geometry: THREE.BufferGeometry, color: number, turnFace: string): void {
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color,
      side: THREE.DoubleSide,
      roughness: 0.42,
      metalness: 0.03,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.turnFace = turnFace;
    this.group.add(mesh);
    this.tiles.push({ mesh, initialMatrix: new THREE.Matrix4() });
  }

  protected tileWorldCenter(tile: PolyTile, target = new THREE.Vector3()): THREE.Vector3 {
    const attr = tile.mesh.geometry.getAttribute('position');
    target.set(0, 0, 0);
    for (let i = 0; i < attr.count; i++) {
      target.add(new THREE.Vector3().fromBufferAttribute(attr as THREE.BufferAttribute, i));
    }
    target.multiplyScalar(1 / Math.max(1, attr.count));
    return target.applyMatrix4(tile.mesh.matrixWorld);
  }

  dispose(): void {
    this.stop();
    if (this.interactive) this.cancelInteractiveTurn();
    if (this.turnAnim) {
      const r = this.turnAnim.resolve;
      this.turnAnim = null;
      this.busy = false;
      this.setCoreTurnSafe(false);
      r();
    }
    for (const { mesh } of this.tiles) {
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.removeFromParent();
    }
    this.tiles = [];
    if (this.core) {
      this.core.geometry.dispose();
      const mats = Array.isArray(this.core.material) ? this.core.material : [this.core.material];
      mats.forEach((m) => m.dispose());
      this.core.removeFromParent();
      this.core = null;
    }
    while (this.group.children.length) this.group.remove(this.group.children[0]);
    this.group.add(this.pivot);
    this.listeners = [];
  }
}
