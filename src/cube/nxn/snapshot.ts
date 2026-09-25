/**
 * Snapshot live RubiksCube sticker colors into a FaceletCube.
 */
import * as THREE from 'three';
import { FACE_COLORS, type FaceId } from '../colors';
import { FaceletCube, FACE_URFDLB, type Color } from './faceletCube';

const FACE_IDS: FaceId[] = ['U', 'D', 'F', 'B', 'R', 'L'];

function colorToIdx(hex: number): Color | null {
  for (let i = 0; i < FACE_URFDLB.length; i++) {
    const id = FACE_URFDLB[i] as FaceId;
    if (FACE_COLORS[id] === hex) return i;
  }
  return null;
}

function normalToFaceIdx(n: THREE.Vector3): number {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  if (ay >= ax && ay >= az) return n.y > 0 ? 0 : 3; // U : D
  if (ax >= ay && ax >= az) return n.x > 0 ? 1 : 4; // R : L
  return n.z > 0 ? 2 : 5; // F : B
}

function indicesToFacelet(N: number, face: number, ix: number, iy: number, iz: number): [number, number] {
  switch (face) {
    case 0: return [N - 1 - iz, ix]; // U
    case 3: return [iz, ix]; // D
    case 2: return [N - 1 - iy, ix]; // F
    case 5: return [N - 1 - iy, N - 1 - ix]; // B
    case 1: return [N - 1 - iy, N - 1 - iz]; // R
    case 4: return [N - 1 - iy, iz]; // L
    default: return [0, 0];
  }
}

/** Minimal cubie shape needed from RubiksCube (avoids circular import). */
export interface CubieSnap {
  mesh: THREE.Mesh;
  ix: number;
  iy: number;
  iz: number;
}

/**
 * Read sticker colors + world normals from cubie meshes → FaceletCube.
 */
export function snapshotFromCubies(N: number, cubies: CubieSnap[]): FaceletCube {
  const cube = new FaceletCube(N);
  // Fill with -1 to detect missing
  for (let f = 0; f < 6; f++) cube.faces[f].fill(-1);

  for (const c of cubies) {
    const mats = c.mesh.material as THREE.MeshStandardMaterial[];
    for (let mi = 0; mi < 6; mi++) {
      const hex = mats[mi].color.getHex();
      if (hex === FACE_COLORS.plastic) continue;
      const colorIdx = colorToIdx(hex);
      if (colorIdx === null) continue;

      const localN = new THREE.Vector3(
        mi === 0 ? 1 : mi === 1 ? -1 : 0,
        mi === 2 ? 1 : mi === 3 ? -1 : 0,
        mi === 4 ? 1 : mi === 5 ? -1 : 0,
      );
      const worldN = localN.applyQuaternion(c.mesh.quaternion).normalize();
      const face = normalToFaceIdx(worldN);
      const [row, col] = indicesToFacelet(N, face, c.ix, c.iy, c.iz);
      cube.set(face, row, col, colorIdx);
    }
  }

  // Sanity: no unset facelets on outer shell
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < N * N; i++) {
      if (cube.faces[f][i] < 0) {
        // Should not happen for a valid cube; leave as face color
        cube.faces[f][i] = f;
      }
    }
  }
  return cube;
}

void FACE_IDS;
