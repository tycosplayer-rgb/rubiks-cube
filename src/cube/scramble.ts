import type { Axis, LayerMove } from './types';
import { moveToNotation } from './notation';

const AXES: Axis[] = ['x', 'y', 'z'];

function randInt(n: number): number {
  return Math.floor(Math.random() * n);
}

/** Fair-ish random scramble: no consecutive same-axis moves; length scales with N */
export function generateScramble(order: number): { moves: LayerMove[]; text: string; length: number } {
  const length =
    order === 2 ? 10 :
    order === 3 ? 25 :
    order === 4 ? 40 :
    order === 5 ? 60 :
    order === 6 ? 80 : 100;

  const moves: LayerMove[] = [];
  let lastAxis: Axis | null = null;
  let lastLayer = -1;

  for (let i = 0; i < length; i++) {
    let axis: Axis;
    let layer: number;
    let guard = 0;
    do {
      axis = AXES[randInt(3)];
      layer = randInt(order);
      guard++;
    } while (guard < 30 && axis === lastAxis && (layer === lastLayer || order <= 3));

    // 3×3: only outer faces (keeps cubejs tracker in sync; no M/E/S)
    if (order === 3) {
      layer = Math.random() < 0.5 ? 0 : order - 1;
      if (axis === lastAxis && layer === lastLayer) {
        layer = layer === 0 ? order - 1 : 0;
      }
    } else if (order > 3 && Math.random() < 0.35) {
      // Prefer outer layers a bit for bigger cubes
      layer = Math.random() < 0.5 ? 0 : order - 1;
      if (axis === lastAxis && layer === lastLayer) {
        layer = layer === 0 ? order - 1 : 0;
      }
    }

    const turns = ([1, 2, 3] as const)[randInt(3)];
    moves.push({ axis, layer, turns });
    lastAxis = axis;
    lastLayer = layer;
  }

  const text = moves.map((m) => moveToNotation(m, order)).join(' ');
  return { moves, text, length: moves.length };
}
