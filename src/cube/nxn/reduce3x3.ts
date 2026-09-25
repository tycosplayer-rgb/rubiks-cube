/**
 * Reduce centers-solved + edges-paired NxN to 3×3, fix parity, solve with cubejs.
 */
import cubejsImport from 'cubejs';
import type { LayerMove } from '../types';
import { FaceletCube, FACE_URFDLB } from './faceletCube';
import { parseNxNAlgorithm } from './moves';
import { parseAlgorithm } from '../notation';
import { ensureSolver } from '../solver';

type CubeInst = {
  move(algorithm: string): unknown;
  solve(maxDepth?: number): string;
  isSolved(): boolean;
  eo?: number[];
  ep?: number[];
  co?: number[];
  cp?: number[];
};
type CubeClass = {
  new (): CubeInst;
  initSolver(): void;
  fromString(str: string): CubeInst;
};
const Cube = ((cubejsImport as unknown as { default?: CubeClass }).default ??
  cubejsImport) as CubeClass;

const LETTERS = FACE_URFDLB;

function faceTo3x3(cube: FaceletCube, face: number): string {
  const N = cube.N;
  const mid = Math.floor((N - 1) / 2);
  // Sample corners / edge-mids / center from NxN.
  // FaceletCube U has row0=F (geometric); cubejs U has row0=B — flip U/D rows.
  let coords: [number, number][] = [
    [0, 0], [0, mid], [0, N - 1],
    [mid, 0], [mid, mid], [mid, N - 1],
    [N - 1, 0], [N - 1, mid], [N - 1, N - 1],
  ];
  if (face === 0 || face === 3) {
    coords = coords.map(([r, c]) => [N - 1 - r, c]);
  }
  let s = '';
  for (const [r, c] of coords) s += LETTERS[cube.at(face, r, c)];
  return s;
}

export function toCubejsFacelets(cube: FaceletCube): string {
  let s = '';
  for (let f = 0; f < 6; f++) s += faceTo3x3(cube, f);
  return s;
}

function permSign(p: number[]): number {
  let sign = 0;
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      if (p[i] > p[j]) sign ^= 1;
    }
  }
  return sign;
}

function hasDuplicate(arr: number[]): boolean {
  const s = new Set(arr);
  return s.size !== arr.length;
}

const OLL_PARITY = "r2 B2 U2 l U2 r' U2 r U2 F2 r F2 l' B2 r2";
const PLL_PARITY = "r2 U2 r2 Uw2 r2 Uw2";

export async function solveReduced3x3(
  cube: FaceletCube,
): Promise<LayerMove[] | null> {
  await ensureSolver();
  const N = cube.N;
  const work = cube.clone();
  const result: LayerMove[] = [];

  const applyParityFixes = () => {
    let cj: CubeInst;
    try {
      cj = Cube.fromString(toCubejsFacelets(work));
    } catch {
      return false;
    }
    if (!cj.eo || !cj.ep || !cj.cp) return true;
    // Invalid piece lists → facelets not a proper 3×3
    if (hasDuplicate(cj.ep) || hasDuplicate(cj.cp)) return false;

    if (N % 2 === 0) {
      if (cj.eo.reduce((a, b) => a + b, 0) % 2 === 1) {
        const alg = parseNxNAlgorithm(OLL_PARITY, N);
        work.applyAlgo(alg);
        result.push(...alg);
        cj = Cube.fromString(toCubejsFacelets(work));
      }
      if (cj.ep && cj.cp && permSign(cj.ep) !== permSign(cj.cp)) {
        const alg = parseNxNAlgorithm(PLL_PARITY, N);
        work.applyAlgo(alg);
        result.push(...alg);
      }
    }
    return true;
  };

  if (!applyParityFixes()) return null;

  const facelets = toCubejsFacelets(work);
  let cj: CubeInst;
  try {
    cj = Cube.fromString(facelets);
  } catch {
    return null;
  }
  if (cj.ep && hasDuplicate(cj.ep)) return null;
  if (cj.cp && hasDuplicate(cj.cp)) return null;

  if (cj.isSolved()) return result;

  let algo: string;
  try {
    // cubejs can hang on near-invalid states — race with timeout
    algo = await Promise.race([
      Promise.resolve().then(() => cj.solve(24)),
      new Promise<string>((_, rej) =>
        setTimeout(() => rej(new Error('cubejs timeout')), 8000),
      ),
    ]);
  } catch {
    return null;
  }
  if (!algo || !algo.trim()) return result;

  const moves = parseAlgorithm(algo, N);
  work.applyAlgo(moves);
  result.push(...moves);
  return result;
}
