import type * as THREE from 'three';
import type { LayerMove } from './types';

export type VisualStyle = 'sticker' | 'full';
export type PuzzleType = 'cube' | 'pyraminx' | 'megaminx';

export type PuzzleEvent =
  | { type: 'busy'; busy: boolean }
  | { type: 'move'; notation: string; historyLen: number }
  | { type: 'scramble'; text: string; length: number }
  | { type: 'solved' }
  | { type: 'order'; order: number }
  | { type: 'status'; message: string };

export interface PuzzlePick {
  mesh: THREE.Mesh;
  point: THREE.Vector3;
  faceNormal: THREE.Vector3;
  /** Optional face id for button / gesture mapping */
  faceId?: string;
}

/** Face turn used by Pyraminx / Megaminx (and optionally cube UI buttons). */
export interface FaceTurnMove {
  kind: 'face';
  face: string;
  /** Signed steps: +1 = one step CW looking along outward normal (RH about outward). */
  steps: number;
  /**
   * Pyraminx depth band along tip axis: 0 = tip (outermost) … order-1 = bottom.
   * When omitted, `tip` / `bottom` aliases apply (N=3 compat: tip→0, bottom→N-1, else→1).
   */
  depth?: number;
  /** Pyraminx tip-only turn when true (alias for depth 0). */
  tip?: boolean;
  /** Pyraminx bottom layer (far band + base tips) about the tip axis when true (alias for depth N-1). */
  bottom?: boolean;
  /**
   * Optional wide flag (unused for Pyraminx: mid depths are thin single-band slices).
   * Kept for move/UI schema compat; selectLayer ignores it.
   */
  wide?: boolean;
}

export type AnyMove = LayerMove | FaceTurnMove;

export function isFaceTurnMove(m: AnyMove): m is FaceTurnMove {
  return (m as FaceTurnMove).kind === 'face';
}

export interface FaceButton {
  id: string;
  label: string;
  color: string;
  /** Optional tip button for pyraminx (depth 0) */
  tip?: boolean;
  /** Optional bottom-layer button for pyraminx (depth N-1) */
  bottom?: boolean;
  /** Explicit depth band for pyraminx (preferred over tip/bottom for N≠3). */
  depth?: number;
  /** Optional wide flag (unused for Pyraminx thin mid slices). */
  wide?: boolean;
}

export interface Puzzle {
  readonly group: THREE.Group;
  readonly puzzleType: PuzzleType;
  update(nowMs?: number): void;
  on(fn: (e: PuzzleEvent) => void): () => void;
  isBusy(): boolean;
  setSpeed(mult: number): void;
  setCastShadows(enabled: boolean): void;
  getVisualStyle(): VisualStyle;
  setVisualStyle(style: VisualStyle): void;
  getHistoryLength(): number;
  reset(): void;
  scramble(): Promise<void>;
  solve(): Promise<void>;
  stop(): void;
  dispose(): void;
  pickCubie(raycaster: THREE.Raycaster): PuzzlePick | null;
  dragToMove(
    mesh: THREE.Mesh,
    faceNormal: THREE.Vector3,
    screenDelta: THREE.Vector2,
    camera: THREE.Camera,
    hitPoint: THREE.Vector3,
  ): AnyMove | null;
  applyMove(move: AnyMove, record?: boolean): Promise<void>;
  /** Suggested camera distance from origin. */
  getFitDistance(): number;
  /** Floor Y so the puzzle sits above the disc. */
  getFloorY(): number;
  /** Optional labeled face-turn buttons. */
  getFaceButtons(): FaceButton[];
  /** Optional order (cube / pyraminx / megaminx). */
  getOrder?(): number;

  /**
   * Optional continuous layer-drag (Pyraminx). When present, controls use
   * begin/update/end instead of discrete dragToMove → applyMove.
   */
  beginLayerDrag?(pick: PuzzlePick, camera: THREE.Camera): LayerDragSession | null;
  /** ndcX/ndcY are Three.js NDC (−1…1); controls convert from client coords. */
  updateLayerDrag?(session: LayerDragSession, ndcX: number, ndcY: number, camera: THREE.Camera): void;
  endLayerDrag?(session: LayerDragSession): Promise<void>;
  cancelLayerDrag?(session: LayerDragSession): void;
}

/** Opaque handle for an in-progress continuous layer twist. */
export interface LayerDragSession {
  readonly face: string;
  readonly tip?: boolean;
  readonly bottom?: boolean;
  readonly depth?: number;
  readonly wide?: boolean;
}
