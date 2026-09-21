import type { Axis, LayerMove } from './types';

/**
 * Convert a layer move to readable notation.
 * Outer faces: U D R L F B ; inner layers: 2U, 3U … ; wide: Uw for N>3 optional.
 * turns is Three.js RH quarters; we map to standard clockwise face turns.
 */
export function moveToNotation(move: LayerMove, order: number): string {
  const { axis, layer, turns } = move;
  const face = outerFaceForLayer(axis, layer, order);
  const isOuter = layer === 0 || layer === order - 1;

  // Standard cube: clockwise when looking at face = our "standardTurns"
  // Three.js +axis rotation is CCW when looking along +axis from +inf.
  // For +face (U/R/F): clockwise looking at face = -Three.js turn
  // For -face (D/L/B): clockwise looking at face = +Three.js turn (looking from -axis)
  let clockwiseQuarters: number;
  if (face === 'U' || face === 'R' || face === 'F') {
    clockwiseQuarters = (4 - (turns % 4)) % 4;
  } else {
    clockwiseQuarters = turns % 4;
  }
  if (clockwiseQuarters === 0) clockwiseQuarters = 4;

  let base: string;
  if (isOuter) {
    base = face;
  } else {
    // slice depth from the nearer outer face of same axis polarity we named
    const depth = Math.min(layer, order - 1 - layer) + 1;
    base = `${depth}${face}`;
  }

  if (clockwiseQuarters === 1) return base;
  if (clockwiseQuarters === 2) return `${base}2`;
  return `${base}'`;
}

function outerFaceForLayer(axis: Axis, layer: number, order: number): string {
  const nearMax = layer >= (order - 1) / 2;
  if (axis === 'y') return nearMax ? 'U' : 'D';
  if (axis === 'x') return nearMax ? 'R' : 'L';
  return nearMax ? 'F' : 'B';
}

/** Inverse of a layer move */
export function invertMove(move: LayerMove): LayerMove {
  const t = move.turns;
  const inv = (t === 1 ? 3 : t === 3 ? 1 : 2) as 1 | 2 | 3;
  return { axis: move.axis, layer: move.layer, turns: inv };
}

/**
 * Map standard face letter + clockwise quarters → LayerMove for outer faces.
 * Used when applying cubejs solution strings.
 */
export function faceMoveToLayer(face: string, clockwise: 1 | 2 | 3, order: number): LayerMove {
  const map: Record<string, { axis: Axis; layer: number; cwIsNegative: boolean }> = {
    U: { axis: 'y', layer: order - 1, cwIsNegative: true },
    D: { axis: 'y', layer: 0, cwIsNegative: false },
    R: { axis: 'x', layer: order - 1, cwIsNegative: true },
    L: { axis: 'x', layer: 0, cwIsNegative: false },
    F: { axis: 'z', layer: order - 1, cwIsNegative: true },
    B: { axis: 'z', layer: 0, cwIsNegative: false },
  };
  const m = map[face];
  if (!m) throw new Error(`Unknown face ${face}`);
  let turns: 1 | 2 | 3;
  if (m.cwIsNegative) {
    turns = (clockwise === 1 ? 3 : clockwise === 3 ? 1 : 2) as 1 | 2 | 3;
  } else {
    turns = clockwise;
  }
  return { axis: m.axis, layer: m.layer, turns };
}

/** Parse cubejs / WCA-style algorithm for 3×3 outer moves */
export function parseAlgorithm(algo: string, order: number): LayerMove[] {
  const tokens = algo.trim().split(/\s+/).filter(Boolean);
  const moves: LayerMove[] = [];
  for (const tok of tokens) {
    const face = tok[0];
    if (!'UDFBRL'.includes(face)) continue;
    let cw: 1 | 2 | 3 = 1;
    if (tok.includes('2')) cw = 2;
    else if (tok.includes("'")) cw = 3;
    moves.push(faceMoveToLayer(face, cw, order));
  }
  return moves;
}

export function layerMoveToCubejs(move: LayerMove, order: number): string | null {
  if (order !== 3) return null;

  // Middle slices: M (x mid), E (y mid), S (z mid)
  if (move.layer === 1) {
    // Convention matching cubejs: M follows L (cw from L), E follows D, S follows F
    const slice = move.axis === 'x' ? 'M' : move.axis === 'y' ? 'E' : 'S';
    // L/D are -faces (cwIsNegative=false); F is +face (cwIsNegative=true)
    // M like L: turns map directly; E like D: direct; S like F: inverted
    let cw: number;
    if (slice === 'S') cw = (4 - move.turns) % 4;
    else cw = move.turns % 4;
    if (cw === 0) return null;
    if (cw === 1) return slice;
    if (cw === 2) return `${slice}2`;
    return `${slice}'`;
  }

  const face = (() => {
    if (move.axis === 'y') return move.layer === 2 ? 'U' : 'D';
    if (move.axis === 'x') return move.layer === 2 ? 'R' : 'L';
    return move.layer === 2 ? 'F' : 'B';
  })();
  const cwIsNeg = face === 'U' || face === 'R' || face === 'F';
  let cw: number;
  if (cwIsNeg) cw = (4 - move.turns) % 4;
  else cw = move.turns % 4;
  if (cw === 0) return null;
  if (cw === 1) return face;
  if (cw === 2) return `${face}2`;
  return `${face}'`;
}
