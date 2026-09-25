/**
 * Pure NxN facelet model (no Three.js).
 * Face order matches cubejs: U R F D L B (indices 0..5).
 * Each face is N×N row-major when looking at that face:
 *   U: row0=F … rowN-1=B; col0=L … colN-1=R  (note: opposite of cubejs U)
 *   D: row0=B … rowN-1=F; col0=L … colN-1=R  (note: opposite of cubejs D)
 *   F: row0=U … rowN-1=D; col0=L … colN-1=R
 *   B: row0=U … rowN-1=D; col0=R … colN-1=L
 *   R: row0=U … rowN-1=D; col0=F … colN-1=B
 *   L: row0=U … rowN-1=D; col0=B … colN-1=F
 *
 * LayerMove uses the same Three.js RH convention as RubiksCube.
 * Clean-room implementation for phased reduction (4×4 / 5×5).
 */
import type { Axis, LayerMove } from '../types';

export const FACE_URFDLB = ['U', 'R', 'F', 'D', 'L', 'B'] as const;
export type FaceName = (typeof FACE_URFDLB)[number];

/** Color = home-face index in URFDLB (0=U … 5=B). */
export type Color = number;

const U = 0, R = 1, F = 2, D = 3, L = 4, B = 5;

type Vec = [number, number, number];

function faceNormal(face: number): Vec {
  switch (face) {
    case U: return [0, 1, 0];
    case D: return [0, -1, 0];
    case F: return [0, 0, 1];
    case B: return [0, 0, -1];
    case R: return [1, 0, 0];
    case L: return [-1, 0, 0];
    default: return [0, 0, 0];
  }
}

function normalToFace(n: Vec): number {
  const [x, y, z] = n;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ay >= ax && ay >= az) return y > 0 ? U : D;
  if (ax >= ay && ax >= az) return x > 0 ? R : L;
  return z > 0 ? F : B;
}

/** Map (face,row,col) → integer cubie indices (ix,iy,iz). */
function faceletToIndices(N: number, face: number, row: number, col: number): Vec {
  switch (face) {
    case U: return [col, N - 1, N - 1 - row];
    case D: return [col, 0, row];
    case F: return [col, N - 1 - row, N - 1];
    case B: return [N - 1 - col, N - 1 - row, 0];
    case R: return [N - 1, N - 1 - row, N - 1 - col];
    case L: return [0, N - 1 - row, col];
    default: return [0, 0, 0];
  }
}

/** Inverse: cubie on a given face → (row,col). */
function indicesToFacelet(N: number, face: number, ix: number, iy: number, iz: number): [number, number] {
  switch (face) {
    case U: return [N - 1 - iz, ix];
    case D: return [iz, ix];
    case F: return [N - 1 - iy, ix];
    case B: return [N - 1 - iy, N - 1 - ix];
    case R: return [N - 1 - iy, N - 1 - iz];
    case L: return [N - 1 - iy, iz];
    default: return [0, 0];
  }
}

function rotNormal(axis: Axis, n: Vec): Vec {
  const [x, y, z] = n;
  if (axis === 'x') return [x, -z, y];       // +90° RH about X
  if (axis === 'y') return [z, y, -x];       // +90° RH about Y
  return [-y, x, z];                         // +90° RH about Z
}

function rotIndices(N: number, axis: Axis, ix: number, iy: number, iz: number): Vec {
  if (axis === 'x') return [ix, N - 1 - iz, iy];
  if (axis === 'y') return [iz, iy, N - 1 - ix];
  return [N - 1 - iy, ix, iz];
}

export class FaceletCube {
  readonly N: number;
  /** length 6; each length N*N */
  faces: Color[][];

  constructor(N: number, faces?: Color[][]) {
    this.N = N;
    if (faces) {
      this.faces = faces.map((f) => f.slice());
    } else {
      this.faces = [];
      for (let f = 0; f < 6; f++) {
        this.faces.push(new Array(N * N).fill(f));
      }
    }
  }

  clone(): FaceletCube {
    return new FaceletCube(this.N, this.faces);
  }

  at(face: number, row: number, col: number): Color {
    return this.faces[face][row * this.N + col];
  }

  set(face: number, row: number, col: number, c: Color): void {
    this.faces[face][row * this.N + col] = c;
  }

  isSolved(): boolean {
    const N = this.N;
    for (let f = 0; f < 6; f++) {
      const arr = this.faces[f];
      for (let i = 0; i < N * N; i++) if (arr[i] !== f) return false;
    }
    return true;
  }

  /** Inner (N-2)×(N-2) stickers on every face match face color. */
  centersSolved(): boolean {
    const N = this.N;
    for (let f = 0; f < 6; f++) {
      for (let r = 1; r < N - 1; r++) {
        for (let c = 1; c < N - 1; c++) {
          if (this.at(f, r, c) !== f) return false;
        }
      }
    }
    return true;
  }

  apply(move: LayerMove): void {
    const t = ((move.turns % 4) + 4) % 4;
    if (t === 0) return;
    for (let i = 0; i < t; i++) this.applyQuarter(move.axis, move.layer);
  }

  applyAlgo(moves: LayerMove[]): void {
    for (const m of moves) this.apply(m);
  }

  /** One +90° RH quarter about +axis on layer index 0..N-1. */
  private applyQuarter(axis: Axis, layer: number): void {
    const N = this.N;
    const next = this.faces.map((f) => f.slice());

    for (let face = 0; face < 6; face++) {
      for (let row = 0; row < N; row++) {
        for (let col = 0; col < N; col++) {
          const [ix, iy, iz] = faceletToIndices(N, face, row, col);
          const onLayer =
            (axis === 'x' && ix === layer) ||
            (axis === 'y' && iy === layer) ||
            (axis === 'z' && iz === layer);
          if (!onLayer) continue;

          // Color currently at this slot came from the inverse rotation.
          // Easier: compute where THIS sticker goes, write into `next`.
          const color = this.faces[face][row * N + col];
          const n0 = faceNormal(face);
          const [ix2, iy2, iz2] = rotIndices(N, axis, ix, iy, iz);
          const n1 = rotNormal(axis, n0);
          const face2 = normalToFace(n1);
          const [r2, c2] = indicesToFacelet(N, face2, ix2, iy2, iz2);
          next[face2][r2 * N + c2] = color;
        }
      }
    }
    this.faces = next;
  }

  /** Facelet string for debugging: 6*N*N chars using URFDLB letters. */
  toString(): string {
    let s = '';
    for (let f = 0; f < 6; f++) {
      for (const c of this.faces[f]) s += FACE_URFDLB[c];
    }
    return s;
  }

  /** Count wrong center stickers (inner (N-2)^2 per face). */
  wrongCenters(): number {
    const N = this.N;
    let n = 0;
    for (let f = 0; f < 6; f++) {
      for (let r = 1; r < N - 1; r++) {
        for (let c = 1; c < N - 1; c++) {
          if (this.at(f, r, c) !== f) n++;
        }
      }
    }
    return n;
  }
}

export { U, R, F, D, L, B, faceletToIndices, indicesToFacelet };
