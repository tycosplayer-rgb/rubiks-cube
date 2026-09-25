/**
 * Clean-room center solving for 4×4 / 5×5.
 *
 * Strategy: solve faces one color at a time. After a face is solved, further
 * searches may break it mid-path but must restore it (commutator-friendly).
 * For opposite/belt faces we greedily increase "correct count" with short BFS.
 */
import type { LayerMove } from '../types';
import { FaceletCube, U, R, F, D, L, B } from './faceletCube';
import { allLayerMoves, parseNxNAlgorithm } from './moves';

export type AbortFn = () => boolean;

function faceCentersSolved(cube: FaceletCube, face: number): boolean {
  const N = cube.N;
  for (let r = 1; r < N - 1; r++) {
    for (let c = 1; c < N - 1; c++) {
      if (cube.at(face, r, c) !== face) return false;
    }
  }
  return true;
}

function facesCentersSolved(cube: FaceletCube, faces: number[]): boolean {
  return faces.every((f) => faceCentersSolved(cube, f));
}

/** Count of face-colored stickers sitting on that face's center slots. */
function correctOnFace(cube: FaceletCube, face: number): number {
  const N = cube.N;
  let n = 0;
  for (let r = 1; r < N - 1; r++) {
    for (let c = 1; c < N - 1; c++) {
      if (cube.at(face, r, c) === face) n++;
    }
  }
  return n;
}

function centerSlots(N: number): [number, number][] {
  const s: [number, number][] = [];
  for (let r = 1; r < N - 1; r++) for (let c = 1; c < N - 1; c++) s.push([r, c]);
  return s;
}

function colorMask(cube: FaceletCube, color: number): string {
  const N = cube.N;
  const slots = centerSlots(N);
  const parts: string[] = [];
  for (let f = 0; f < 6; f++) {
    let bits = 0;
    slots.forEach(([r, c], i) => {
      if (cube.at(f, r, c) === color) bits |= 1 << i;
    });
    parts.push(bits.toString(36));
  }
  return parts.join(',');
}

function allCentersKey(cube: FaceletCube): string {
  const N = cube.N;
  let s = '';
  for (let f = 0; f < 6; f++) {
    for (let r = 1; r < N - 1; r++) {
      for (let c = 1; c < N - 1; c++) s += cube.at(f, r, c);
    }
  }
  return s;
}

async function yieldIfNeeded(last: { t: number }): Promise<void> {
  if (Date.now() - last.t > 20) {
    await new Promise((r) => setTimeout(r, 0));
    last.t = Date.now();
  }
}

/**
 * Short BFS: improve correctOnFace(target) by ≥1, restoring `preserve` faces.
 */
async function bfsImproveFace(
  start: FaceletCube,
  target: number,
  preserve: number[],
  moves: LayerMove[],
  opts: { deadline: number; shouldAbort: AbortFn; maxDepth: number; maxStates: number },
): Promise<LayerMove[] | null> {
  const before = correctOnFace(start, target);
  const need = centerSlots(start.N).length;
  if (before >= need && facesCentersSolved(start, preserve)) return [];

  type Node = { cube: FaceletCube; path: LayerMove[]; la: string; ll: number };
  const q: Node[] = [{ cube: start.clone(), path: [], la: '', ll: -1 }];
  const vis = new Set<string>();
  // Key includes all preserve + target masks so we can restore
  const key = (c: FaceletCube) =>
    [target, ...preserve].map((f) => colorMask(c, f)).join('|');
  vis.add(key(start));

  let processed = 0;
  const last = { t: Date.now() };

  while (q.length) {
    if (opts.shouldAbort() || Date.now() > opts.deadline) return null;
    if (processed >= opts.maxStates) return null;
    const node = q.shift()!;
    processed++;
    await yieldIfNeeded(last);

    for (const mv of moves) {
      if (mv.axis === node.la && mv.layer === node.ll) continue;
      const next = node.cube.clone();
      next.apply(mv);
      const sk = key(next);
      if (vis.has(sk)) continue;
      vis.add(sk);
      const path = node.path.concat([mv]);

      if (
        facesCentersSolved(next, preserve) &&
        correctOnFace(next, target) > before
      ) {
        return path;
      }
      // Also accept fully solving target
      if (
        facesCentersSolved(next, preserve) &&
        faceCentersSolved(next, target)
      ) {
        return path;
      }

      if (path.length < opts.maxDepth) {
        q.push({ cube: next, path, la: mv.axis, ll: mv.layer });
      }
    }
  }
  return null;
}

/**
 * Keep calling bfsImproveFace until face is solved.
 */
async function solveOneFace(
  work: FaceletCube,
  target: number,
  preserve: number[],
  moves: LayerMove[],
  opts: { deadline: number; shouldAbort: AbortFn },
  out: LayerMove[],
): Promise<boolean> {
  const need = centerSlots(work.N).length;
  let guard = 0;
  while (!faceCentersSolved(work, target) || !facesCentersSolved(work, preserve)) {
    if (opts.shouldAbort() || Date.now() > opts.deadline) return false;
    if (guard++ > need + 4) return false;

    const path = await bfsImproveFace(work, target, preserve, moves, {
      ...opts,
      maxDepth: work.N <= 4 ? 10 : 10,
      maxStates: work.N <= 4 ? 150_000 : 80_000,
    });
    if (!path) {
      // Try deeper one-shot to fully solve
      const path2 = await bfsImproveFace(work, target, preserve, moves, {
        ...opts,
        maxDepth: work.N <= 4 ? 14 : 12,
        maxStates: work.N <= 4 ? 400_000 : 200_000,
      });
      if (!path2) return false;
      work.applyAlgo(path2);
      out.push(...path2);
    } else {
      work.applyAlgo(path);
      out.push(...path);
    }
  }
  return true;
}

async function solveLastCentersCommutator(
  start: FaceletCube,
  opts: { deadline: number; shouldAbort: AbortFn },
): Promise<LayerMove[] | null> {
  const N = start.N;
  const algs = [
    "l' U r U' l U r'",
    "r U' l' U r' U' l",
    "l U' r' U l' U' r",
    "r' U l U' r U l'",
    "2L' U 2R U' 2L U 2R'",
    "2R U' 2L' U 2R' U' 2L",
    "3L' U 3R U' 3L U 3R'",
    "3R U' 3L' U 3R' U' 3L",
  ];
  const setups = allLayerMoves(N).filter(
    (m) => m.layer === 0 || m.layer === N - 1 || m.turns === 2,
  );

  for (const algStr of algs) {
    if (opts.shouldAbort() || Date.now() > opts.deadline) return null;
    let alg: LayerMove[];
    try {
      alg = parseNxNAlgorithm(algStr, N);
    } catch {
      continue;
    }
    if (!alg.length) continue;

    const c0 = start.clone();
    c0.applyAlgo(alg);
    if (c0.centersSolved()) return alg;

    for (const s of setups) {
      const inv: LayerMove = {
        axis: s.axis,
        layer: s.layer,
        turns: (s.turns === 1 ? 3 : s.turns === 3 ? 1 : 2) as 1 | 2 | 3,
      };
      const c = start.clone();
      c.apply(s);
      c.applyAlgo(alg);
      if (c.centersSolved()) return [s, ...alg];
      c.apply(inv);
      if (c.centersSolved()) return [s, ...alg, inv];
    }
  }

  // Final BFS on full pattern
  type Node = { cube: FaceletCube; path: LayerMove[]; la: string; ll: number };
  const q: Node[] = [{ cube: start.clone(), path: [], la: '', ll: -1 }];
  const vis = new Set<string>([allCentersKey(start)]);
  const moves = allLayerMoves(N);
  let processed = 0;
  const last = { t: Date.now() };
  while (q.length) {
    if (opts.shouldAbort() || Date.now() > opts.deadline) return null;
    if (processed > (N <= 4 ? 500_000 : 100_000)) return null;
    const node = q.shift()!;
    processed++;
    await yieldIfNeeded(last);
    for (const mv of moves) {
      if (mv.axis === node.la && mv.layer === node.ll) continue;
      const next = node.cube.clone();
      next.apply(mv);
      const sk = allCentersKey(next);
      if (vis.has(sk)) continue;
      vis.add(sk);
      const path = node.path.concat([mv]);
      if (next.centersSolved()) return path;
      if (path.length < 18) q.push({ cube: next, path, la: mv.axis, ll: mv.layer });
    }
  }
  return null;
}

export async function solveCenters(
  cube: FaceletCube,
  opts: { deadline: number; shouldAbort: AbortFn; onProgress?: (s: string) => void },
): Promise<LayerMove[] | null> {
  const N = cube.N;
  const moves = allLayerMoves(N);
  const result: LayerMove[] = [];
  const work = cube.clone();
  const order = [U, D, F, B, R, L];
  const preserve: number[] = [];

  for (const face of order) {
    if (opts.shouldAbort() || Date.now() > opts.deadline) return null;
    if (faceCentersSolved(work, face) && facesCentersSolved(work, preserve)) {
      preserve.push(face);
      continue;
    }
    opts.onProgress?.(`还原中心 · ${'URFDLB'[face]} 面…`);
    const ok = await solveOneFace(work, face, preserve, moves, opts, result);
    if (!ok) {
      // Last faces: commutator / full BFS
      if (preserve.length >= 3) {
        opts.onProgress?.('还原中心 · 收尾…');
        const path = await solveLastCentersCommutator(work, opts);
        if (!path) return null;
        work.applyAlgo(path);
        result.push(...path);
        break;
      }
      return null;
    }
    preserve.push(face);
  }

  if (!work.centersSolved()) {
    opts.onProgress?.('还原中心 · 收尾…');
    const path = await solveLastCentersCommutator(work, opts);
    if (!path) return null;
    work.applyAlgo(path);
    result.push(...path);
  }

  return work.centersSolved() ? result : null;
}
