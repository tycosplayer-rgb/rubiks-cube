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
    target: number;
    started: number;
    duration: number;
    record: boolean;
    resolve: () => void;
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
    return this.busy || this.locked;
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
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    this.pivot.setRotationFromAxisAngle(this.faceOf(a.move.face).axis, a.target * eased);
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
    this.turnAnim = null;
    this.busy = false;
    if (!this.locked) this.emit({ type: 'busy', busy: false });
    a.resolve();
  }

  async applyMove(move: AnyMove, record = true): Promise<void> {
    if (!isFaceTurnMove(move) || !this.faces.some((f) => f.id === move.face)) return;
    while (this.busy) await new Promise<void>((r) => requestAnimationFrame(() => r()));
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
      this.turnAnim = {
        move: { ...move },
        selected,
        target: this.turnAngle(move),
        record,
        resolve,
        started: performance.now(),
        duration: 330 / this.speed,
      };
    });
  }

  protected styleScale(): number {
    return this.style === 'sticker' ? 1 : 1.03;
  }

  private reparentUniform(object: THREE.Object3D, newParent: THREE.Object3D): void {
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
    return `${m.tip ? m.face.toLowerCase() : m.face}${m.steps < 0 ? "'" : ''}`;
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

  pickCubie(raycaster: THREE.Raycaster): PuzzlePick | null {
    const hit = raycaster.intersectObjects(
      this.tiles.map((t) => t.mesh),
      false,
    )[0];
    if (!hit?.face) return null;
    return {
      mesh: hit.object as THREE.Mesh,
      point: hit.point.clone(),
      faceNormal: hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize(),
      faceId: String(hit.object.userData.turnFace ?? ''),
    };
  }

  dragToMove(
    mesh: THREE.Mesh,
    _normal: THREE.Vector3,
    delta: THREE.Vector2,
    camera: THREE.Camera,
    point: THREE.Vector3,
  ): AnyMove | null {
    if (delta.lengthSq() < 1) return null;
    const faceId = String(mesh.userData.turnFace ?? '');
    const f = this.faces.find((x) => x.id === faceId);
    if (!f) return null;
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
    if (this.turnAnim) {
      const r = this.turnAnim.resolve;
      this.turnAnim = null;
      this.busy = false;
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
