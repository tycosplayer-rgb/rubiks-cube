/**
 * Move helpers for NxN: generate move lists, expand wide turns, parse tokens.
 */
import type { Axis, LayerMove } from '../types';
import { faceMoveToLayer } from '../notation';

const AXES: Axis[] = ['x', 'y', 'z'];

/** All single-layer quarter/half turns for order N. */
export function allLayerMoves(N: number): LayerMove[] {
  const out: LayerMove[] = [];
  for (const axis of AXES) {
    for (let layer = 0; layer < N; layer++) {
      for (const turns of [1, 2, 3] as const) {
        out.push({ axis, layer, turns });
      }
    }
  }
  return out;
}

/** Outer-face-only moves (3×3-style). */
export function outerMoves(N: number): LayerMove[] {
  const out: LayerMove[] = [];
  for (const axis of AXES) {
    for (const layer of [0, N - 1]) {
      for (const turns of [1, 2, 3] as const) {
        out.push({ axis, layer, turns });
      }
    }
  }
  return out;
}

/**
 * Map face letter + depth (1=outer) + clockwise quarters → LayerMove.
 * depth=1 → outer; depth=2 → first inner; etc.
 */
export function depthMoveToLayer(
  face: string,
  depth: number,
  clockwise: 1 | 2 | 3,
  order: number,
): LayerMove {
  if (depth < 1 || depth > Math.floor(order / 2) + (order % 2 === 0 ? 0 : 0)) {
    // allow depth up to floor(N/2) for opposite-neutral naming; also allow N-side depths via face
  }
  const outer = faceMoveToLayer(face, clockwise, order);
  if (depth === 1) return outer;

  // Step inward from the outer layer along the same axis
  const dir = outer.layer === order - 1 ? -1 : 1;
  const layer = outer.layer + dir * (depth - 1);
  if (layer < 0 || layer >= order) throw new Error(`depth ${depth} out of range for ${face} N=${order}`);
  return { axis: outer.axis, layer, turns: outer.turns };
}

/**
 * Parse WCA-style NxN tokens into LayerMove[] (expands wide moves).
 * Supports: R, R', R2, 2R, 2R', Rw, Rw', Rw2, 3Rw, r, r', etc.
 */
export function parseNxNAlgorithm(algo: string, order: number): LayerMove[] {
  const tokens = algo.trim().split(/\s+/).filter(Boolean);
  const moves: LayerMove[] = [];
  for (const tok of tokens) {
    const m = tok.match(/^(\d*)([URFDLBurfdlb]|[URFDLB]w)(2|')?$/);
    if (!m) continue;
    const depthStr = m[1];
    let facePart = m[2];
    const suffix = m[3];
    let cw: 1 | 2 | 3 = 1;
    if (suffix === '2') cw = 2;
    else if (suffix === "'") cw = 3;

    // WCA: Rw/3Rw = wide; r = inner slice only (≡ 2R). Lowercase ≠ wide.
    const isWide = facePart.endsWith('w');
    const isInnerLower = facePart.length === 1 && 'urfdlb'.includes(facePart);
    if (isWide) facePart = facePart[0];
    const face = facePart.toUpperCase();
    if (!'URFDLB'.includes(face)) continue;

    if (isWide) {
      // Rw = layers 1..wideDepth; default 2, or leading digit (3Rw)
      const wideDepth = depthStr ? parseInt(depthStr, 10) : 2;
      for (let d = 1; d <= wideDepth; d++) {
        moves.push(depthMoveToLayer(face, d, cw, order));
      }
    } else if (isInnerLower) {
      // r / u / d … = depth-2 inner slice
      moves.push(depthMoveToLayer(face, 2, cw, order));
    } else if (depthStr) {
      moves.push(depthMoveToLayer(face, parseInt(depthStr, 10), cw, order));
    } else {
      moves.push(depthMoveToLayer(face, 1, cw, order));
    }
  }
  return moves;
}

/** Invert a sequence. */
export function invertMoves(moves: LayerMove[]): LayerMove[] {
  const out: LayerMove[] = [];
  for (let i = moves.length - 1; i >= 0; i--) {
    const t = moves[i].turns;
    const inv = (t === 1 ? 3 : t === 3 ? 1 : 2) as 1 | 2 | 3;
    out.push({ axis: moves[i].axis, layer: moves[i].layer, turns: inv });
  }
  return out;
}

export function moveKey(m: LayerMove): string {
  return `${m.axis}${m.layer}${m.turns}`;
}
