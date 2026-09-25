/**
 * Phased reduction solver for 4×4 / 5×5:
 * centers → edge pairing → reduce to 3×3 (cubejs) + parity.
 * Clean-room; snapshots live cube state (works with empty history).
 */
import type { LayerMove } from '../types';
import type { FaceletCube } from './faceletCube';
import { solveCenters } from './centers';
import { solveEdgePairing, allEdgesPaired } from './edges';
import { solveReduced3x3 } from './reduce3x3';
import { snapshotFromCubies, type CubieSnap } from './snapshot';

export type SolveNxNOptions = {
  deadlineMs?: number;
  shouldAbort?: () => boolean;
  onProgress?: (msg: string) => void;
};

export type SolveNxNResult = {
  moves: LayerMove[];
  method: string;
  timedOut?: boolean;
  error?: string;
};

export function snapshotCube(N: number, cubies: CubieSnap[]): FaceletCube {
  return snapshotFromCubies(N, cubies);
}

export async function solveNxN(
  cube: FaceletCube,
  opts: SolveNxNOptions = {},
): Promise<SolveNxNResult> {
  const N = cube.N;
  const deadline = Date.now() + (opts.deadlineMs ?? 60_000);
  const shouldAbort = opts.shouldAbort ?? (() => false);
  const onProgress = opts.onProgress ?? (() => {});
  const method = N === 4 ? '还原法（四阶）' : N === 5 ? '还原法（五阶）' : `还原法（${N}阶）`;

  if (N !== 4 && N !== 5) {
    return { moves: [], method, error: '仅支持四阶、五阶' };
  }

  const work = cube.clone();
  const moves: LayerMove[] = [];

  if (work.isSolved()) return { moves: [], method };

  // --- Centers ---
  if (!work.centersSolved()) {
    onProgress(`${method} · 还原中心…`);
    const cMoves = await solveCenters(work, {
      deadline,
      shouldAbort,
      onProgress,
    });
    if (!cMoves) {
      return {
        moves: [],
        method,
        timedOut: Date.now() > deadline,
        error: '中心还原失败',
      };
    }
    work.applyAlgo(cMoves);
    moves.push(...cMoves);
  }
  if (shouldAbort()) return { moves: [], method, error: '已中断' };

  // --- Edges ---
  if (!allEdgesPaired(work)) {
    onProgress(`${method} · 还原棱块…`);
    const eMoves = await solveEdgePairing(work, {
      deadline,
      shouldAbort,
      onProgress,
    });
    if (!eMoves) {
      return {
        moves: [],
        method,
        timedOut: Date.now() > deadline,
        error: '棱块配对失败',
      };
    }
    work.applyAlgo(eMoves);
    moves.push(...eMoves);
  }
  if (shouldAbort()) return { moves: [], method, error: '已中断' };

  // --- 3×3 + parity ---
  onProgress(`${method} · 三阶还原…`);
  const rMoves = await solveReduced3x3(work);
  if (!rMoves) {
    return {
      moves: [],
      method,
      error: '三阶还原失败',
    };
  }
  work.applyAlgo(rMoves);
  moves.push(...rMoves);

  if (!work.isSolved()) {
    return {
      moves: [],
      method,
      error: '还原后状态未复原',
    };
  }

  return { moves, method };
}
