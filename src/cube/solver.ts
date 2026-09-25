import cubejsImport from 'cubejs';
import type { LayerMove } from './types';
import { invertMove, parseAlgorithm, layerMoveToCubejs } from './notation';

// CJS/ESM interop: Vite may wrap the constructor as { default: Cube }
type CubeClass = {
  new (): {
    move(algorithm: string): unknown;
    solve(maxDepth?: number): string;
    isSolved(): boolean;
  };
  initSolver(): void;
  scramble(): string;
};
const Cube = ((cubejsImport as unknown as { default?: CubeClass }).default ??
  cubejsImport) as CubeClass;

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

/** Track parallel cubejs state for 2×2 (corners via outer faces) and 3×3 */
export class CubejsTracker {
  private cube: InstanceType<CubeClass>;

  constructor() {
    this.cube = new Cube();
  }

  reset(): void {
    this.cube = new Cube();
  }

  apply(move: LayerMove, order: number): void {
    if (order !== 2 && order !== 3) return;
    const n = layerMoveToCubejs(move, order);
    if (n) this.cube.move(n);
  }

  async solve(order = 3): Promise<LayerMove[]> {
    await ensureSolver();
    // cubejs.solve() can return a non-empty identity-ish string on a solved cube;
    // trust isSolved() (and empty algo) instead of treating that as a real solution.
    if (this.cube.isSolved()) return [];
    const algo = this.cube.solve();
    if (!algo || !algo.trim()) return [];
    return parseAlgorithm(algo, order);
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
