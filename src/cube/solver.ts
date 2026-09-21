import Cube from 'cubejs';
import type { LayerMove } from './types';
import { invertMove, parseAlgorithm, layerMoveToCubejs } from './notation';

let solverReady = false;
let solverPromise: Promise<void> | null = null;

export function ensureSolver(): Promise<void> {
  if (solverReady) return Promise.resolve();
  if (!solverPromise) {
    solverPromise = new Promise((resolve) => {
      // initSolver is sync but heavy — defer to idle
      setTimeout(() => {
        Cube.initSolver();
        solverReady = true;
        resolve();
      }, 0);
    });
  }
  return solverPromise;
}

export function isSolverReady(): boolean {
  return solverReady;
}

/** Track parallel cubejs state for 3×3 */
export class CubejsTracker {
  private cube: Cube;

  constructor() {
    this.cube = new Cube();
  }

  reset(): void {
    this.cube = new Cube();
  }

  apply(move: LayerMove, order: number): void {
    if (order !== 3) return;
    const n = layerMoveToCubejs(move, order);
    if (n) this.cube.move(n);
  }

  async solve(): Promise<LayerMove[]> {
    await ensureSolver();
    const algo = this.cube.solve();
    if (!algo || !algo.trim()) return [];
    return parseAlgorithm(algo, 3);
  }
}

/** Reverse full move history (works for any N) */
export function reverseHistory(history: LayerMove[]): LayerMove[] {
  const out: LayerMove[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    out.push(invertMove(history[i]));
  }
  return out;
}
