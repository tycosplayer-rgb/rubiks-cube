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
  /** Pyraminx tip-only turn when true. */
  tip?: boolean;
}

export type AnyMove = LayerMove | FaceTurnMove;

export function isFaceTurnMove(m: AnyMove): m is FaceTurnMove {
  return (m as FaceTurnMove).kind === 'face';
}

export interface FaceButton {
  id: string;
  label: string;
  color: string;
  /** Optional tip button for pyraminx */
  tip?: boolean;
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
}
