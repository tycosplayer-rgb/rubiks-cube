/**
 * Clean-room wing edge pairing for 4×4 / 5×5 after centers are solved.
 * Greedy setup + pairing algs; targeted wing matching; L4E/L2E endgame.
 * Never applies moves that reduce the unique-pair count.
 */
import type { LayerMove } from '../types';
import { FaceletCube, U, R, F, D, L, B } from './faceletCube';
import { outerMoves, parseNxNAlgorithm } from './moves';

export type AbortFn = () => boolean;

const EDGE_SLOTS: [number, number][] = [
  [U, F], [U, R], [U, B], [U, L],
  [D, F], [D, R], [D, B], [D, L],
  [F, R], [F, L], [B, R], [B, L],
];

function wingFacelets(
  N: number, a: number, b: number, i: number,
): [number, number, number, number, number, number] | null {
  const pair = (x: number, y: number) => {
    if (x === U && y === F) return [U, N - 1, i, F, 0, i] as const;
    if (x === U && y === R) return [U, i, N - 1, R, 0, N - 1 - i] as const;
    if (x === U && y === B) return [U, 0, N - 1 - i, B, 0, N - 1 - i] as const;
    if (x === U && y === L) return [U, i, 0, L, 0, i] as const;
    if (x === D && y === F) return [D, 0, i, F, N - 1, i] as const;
    if (x === D && y === R) return [D, i, N - 1, R, N - 1, N - 1 - i] as const;
    if (x === D && y === B) return [D, N - 1, N - 1 - i, B, N - 1, N - 1 - i] as const;
    if (x === D && y === L) return [D, i, 0, L, N - 1, i] as const;
    if (x === F && y === R) return [F, i, N - 1, R, i, 0] as const;
    if (x === F && y === L) return [F, i, 0, L, i, N - 1] as const;
    if (x === B && y === R) return [B, i, 0, R, i, N - 1] as const;
    if (x === B && y === L) return [B, i, N - 1, L, i, 0] as const;
    return null;
  };
  const r = pair(a, b);
  if (r) return [...r];
  const s = pair(b, a);
  if (s) return [s[3], s[4], s[5], s[0], s[1], s[2]];
  return null;
}

function pairKey(c1: number, c2: number): string {
  return c1 < c2 ? `${c1},${c2}` : `${c2},${c1}`;
}

function isValidEdgeKey(c1: number, c2: number): boolean {
  if (c1 === c2) return false;
  if ((c1 + 3) % 6 === c2) return false;
  return true;
}

function wingKeyAt(cube: FaceletCube, a: number, b: number, w: number): string | null {
  const pos = wingFacelets(cube.N, a, b, w + 1);
  if (!pos) return null;
  const c1 = cube.at(pos[0], pos[1], pos[2]);
  const c2 = cube.at(pos[3], pos[4], pos[5]);
  if (!isValidEdgeKey(c1, c2)) return null;
  return pairKey(c1, c2);
}

function edgePaired(cube: FaceletCube, a: number, b: number): boolean {
  const keys: string[] = [];
  for (let w = 0; w < cube.N - 2; w++) {
    const k = wingKeyAt(cube, a, b, w);
    if (!k) return false;
    keys.push(k);
  }
  return keys.every((k) => k === keys[0]);
}

export function allEdgesPaired(cube: FaceletCube): boolean {
  if (!EDGE_SLOTS.every(([a, b]) => edgePaired(cube, a, b))) return false;
  const keys = new Set<string>();
  for (const [a, b] of EDGE_SLOTS) {
    const k = wingKeyAt(cube, a, b, 0);
    if (!k) return false;
    keys.add(k);
  }
  return keys.size === 12;
}

export function countPairedEdges(cube: FaceletCube): number {
  const seen = new Set<string>();
  let n = 0;
  for (const [a, b] of EDGE_SLOTS) {
    if (!edgePaired(cube, a, b)) continue;
    const k = wingKeyAt(cube, a, b, 0);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    n++;
  }
  return n;
}

export function pairedKeySet(cube: FaceletCube): Set<string> {
  const seen = new Set<string>();
  for (const [a, b] of EDGE_SLOTS) {
    if (!edgePaired(cube, a, b)) continue;
    const k = wingKeyAt(cube, a, b, 0);
    if (k) seen.add(k);
  }
  return seen;
}

/** True if trial improves: more pairs, solved, or newly pairs a key (allow −1 drop). */
function isProgress(
  before: number,
  beforeKeys: Set<string>,
  trial: FaceletCube,
  targetKey?: string,
): boolean {
  if (allEdgesPaired(trial)) return true;
  const after = countPairedEdges(trial);
  if (after > before) return true;
  if (after < before - 1) return false;
  const afterKeys = pairedKeySet(trial);
  if (targetKey && !beforeKeys.has(targetKey) && afterKeys.has(targetKey)) return true;
  for (const k of afterKeys) {
    if (!beforeKeys.has(k)) return true;
  }
  return false;
}

const ALG_STRS = [
  "u' R U R' F R' F' R u",
  "u L' U' L F' L F L' u'",
  "d R U R' d'",
  "d' L' U' L d",
  "d R F' U R' F d'",
  "d' L' F U' L F' d",
  "u' R U R' d R U' R' d' u",
  "Rw U2 Rw' U2 Rw' F Rw F2 U2 F Rw",
  "Uw2 Rw2 U2 r2 U2 Rw2 Uw2",
  "r2 U2 r2 Uw2 r2 u2",
  "Rw2 B2 U2 Lw U2 Rw' U2 Rw U2 F2 Rw F2 Lw' B2 Rw2",
  "r2 B2 U2 l U2 r' U2 r U2 F2 r F2 l' B2 r2",
  "Uw R U R' F R' F' R Uw'",
  "Uw' L' U' L F' L F L' Uw",
  "Dw R U R' Dw'",
  "Dw' L' U' L Dw",
];

function invMove(m: LayerMove): LayerMove {
  return {
    axis: m.axis,
    layer: m.layer,
    turns: (m.turns === 1 ? 3 : m.turns === 3 ? 1 : 2) as 1 | 2 | 3,
  };
}

function fingerprint(cube: FaceletCube): string {
  const N = cube.N;
  const parts: string[] = [];
  for (const [a, b] of EDGE_SLOTS) {
    for (let w = 0; w < N - 2; w++) {
      const pos = wingFacelets(N, a, b, w + 1)!;
      parts.push(`${cube.at(pos[0], pos[1], pos[2])}${cube.at(pos[3], pos[4], pos[5])}`);
    }
  }
  return parts.join('|');
}

/** Keys that appear ≥2 times among unpaired wing slots. */
function unpairedMatchTargets(cube: FaceletCube): string[] {
  const counts = new Map<string, number>();
  for (const [a, b] of EDGE_SLOTS) {
    if (edgePaired(cube, a, b)) continue;
    for (let w = 0; w < cube.N - 2; w++) {
      const k = wingKeyAt(cube, a, b, w);
      if (!k) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([k]) => k);
}

function slotHasKey(cube: FaceletCube, a: number, b: number, key: string): boolean {
  for (let w = 0; w < cube.N - 2; w++) {
    if (wingKeyAt(cube, a, b, w) === key) return true;
  }
  return false;
}

const BUFFER_PAIRS: [[number, number], [number, number]][] = [
  [[F, L], [F, R]],
  [[U, F], [U, B]],
  [[U, L], [U, R]],
  [[D, F], [D, B]],
  [[D, L], [D, R]],
  [[B, L], [B, R]],
];

/**
 * BFS outer moves to put `key` on both slots of a buffer pair, then try pairing algs.
 */
async function pairTargetAtFLFR(
  work: FaceletCube,
  key: string,
  algs: LayerMove[][],
  outers: LayerMove[],
  opts: { deadline: number; shouldAbort: AbortFn; maxDepth: number; maxNodes: number },
): Promise<LayerMove[] | null> {
  const before = countPairedEdges(work);
  type Node = { cube: FaceletCube; path: LayerMove[] };
  const q: Node[] = [{ cube: work.clone(), path: [] }];
  const seen = new Set<string>([fingerprint(work)]);
  let nodes = 0;

  while (q.length && nodes < opts.maxNodes) {
    if (opts.shouldAbort() || Date.now() > opts.deadline) return null;
    const node = q.shift()!;
    nodes++;

    for (const [s1, s2] of BUFFER_PAIRS) {
      if (!slotHasKey(node.cube, s1[0], s1[1], key)) continue;
      if (!slotHasKey(node.cube, s2[0], s2[1], key)) continue;
      for (const alg of algs) {
        const trial = node.cube.clone();
        trial.applyAlgo(alg);
        if (!trial.centersSolved()) continue;
        if (isProgress(before, pairedKeySet(work), trial, key)) {
          return node.path.concat(alg);
        }
      }
    }

    if (node.path.length >= opts.maxDepth) continue;
    for (const m of outers) {
      const next = node.cube.clone();
      next.apply(m);
      if (!next.centersSolved()) continue;
      if (countPairedEdges(next) < before) continue; // never break pairs
      const fp = fingerprint(next);
      if (seen.has(fp)) continue;
      seen.add(fp);
      q.push({ cube: next, path: node.path.concat([m]) });
    }
    if (nodes % 1500 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return null;
}

async function endgameSearch(
  work: FaceletCube,
  algs: LayerMove[][],
  outers: LayerMove[],
  opts: { deadline: number; shouldAbort: AbortFn; maxDepth: number; maxNodes: number },
): Promise<LayerMove[] | null> {
  type Node = { cube: FaceletCube; path: LayerMove[] };
  const q: Node[] = [{ cube: work.clone(), path: [] }];
  const seen = new Set<string>([fingerprint(work)]);
  let nodes = 0;
  const before = countPairedEdges(work);

  while (q.length && nodes < opts.maxNodes) {
    if (opts.shouldAbort() || Date.now() > opts.deadline) return null;
    const node = q.shift()!;
    nodes++;

    for (const alg of algs) {
      const trial = node.cube.clone();
      trial.applyAlgo(alg);
      if (!trial.centersSolved()) continue;
      if (isProgress(before, pairedKeySet(work), trial)) {
        return node.path.concat(alg);
      }
    }

    if (node.path.length >= opts.maxDepth) continue;
    for (const m of outers) {
      const next = node.cube.clone();
      next.apply(m);
      if (!next.centersSolved()) continue;
      if (countPairedEdges(next) < before) continue;
      const fp = fingerprint(next);
      if (seen.has(fp)) continue;
      seen.add(fp);
      q.push({ cube: next, path: node.path.concat([m]) });
    }
    if (nodes % 2000 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return null;
}

async function solveEdgePairingOnce(
  cube: FaceletCube,
  opts: { deadline: number; shouldAbort: AbortFn; onProgress?: (s: string) => void },
): Promise<LayerMove[] | null> {
  if (!cube.centersSolved()) return null;
  if (allEdgesPaired(cube)) return [];

  const N = cube.N;
  const result: LayerMove[] = [];
  const work = cube.clone();
  const outers = outerMoves(N);
  const algs = ALG_STRS.map((s) => parseNxNAlgorithm(s, N)).filter((a) => a.length);
  const visited = new Set<string>([fingerprint(work)]);

  const setups: LayerMove[][] = [[]];
  for (const m of outers) setups.push([m]);
  for (const a of outers) {
    for (const b of outers) {
      if (a.axis === b.axis && a.layer === b.layer) continue;
      setups.push([a, b]);
    }
  }

  let guard = 0;
  let stuck = 0;
  while (!allEdgesPaired(work) && guard++ < 100) {
    if (opts.shouldAbort() || Date.now() > opts.deadline) return null;
    const before = countPairedEdges(work);
    opts.onProgress?.(`还原棱块 · ${before}/12…`);
    await new Promise((r) => setTimeout(r, 0));

    let best: LayerMove[] | null = null;
    let bestGain = 0;

    const beforeKeys = pairedKeySet(work);
    const trySeq = (seq: LayerMove[]) => {
      const trial = work.clone();
      trial.applyAlgo(seq);
      if (!trial.centersSolved()) return;
      const fp = fingerprint(trial);
      if (visited.has(fp)) return;
      const after = countPairedEdges(trial);
      const gain = after - before;
      if (allEdgesPaired(trial)) {
        bestGain = 99;
        best = seq;
        return;
      }
      if (gain > bestGain) {
        bestGain = gain;
        best = seq;
      } else if (bestGain < 1 && gain >= 0 && isProgress(before, beforeKeys, trial)) {
        bestGain = 1;
        best = seq;
      }
    };

    // 1) setup + alg
    for (const setup of setups) {
      for (const alg of algs) trySeq(setup.length ? setup.concat(alg) : alg.slice());
      if (bestGain >= 2) break;
    }

    // 2) conjugations
    if (bestGain < 1) {
      for (const s of outers) {
        const si = invMove(s);
        for (const alg of algs) trySeq([s, ...alg, si]);
      }
    }

    // 3) Targeted: put matching wings at FL+FR
    if (bestGain < 1) {
      const targets = unpairedMatchTargets(work);
      for (const key of targets) {
        const path = await pairTargetAtFLFR(work, key, algs, outers, {
          deadline: opts.deadline,
          shouldAbort: opts.shouldAbort,
          maxDepth: before >= 8 ? 10 : 7,
          maxNodes: before >= 8 ? 120_000 : 50_000,
        });
        if (path) {
          best = path;
          bestGain = 1;
          break;
        }
      }
    }

    // 3b) L2E/L4E: deep outer BFS + algs (outers never break pairs)
    if (bestGain < 1 && before >= 8) {
      const path = await endgameSearch(work, algs, outers, {
        deadline: opts.deadline,
        shouldAbort: opts.shouldAbort,
        maxDepth: before >= 10 ? 14 : 10,
        maxNodes: before >= 10 ? 400_000 : 200_000,
      });
      if (path) {
        best = path;
        bestGain = 1;
      }
    }

    // 4) Endgame BFS
    if (bestGain < 1 && before >= 6) {
      const path = await endgameSearch(work, algs, outers, {
        deadline: opts.deadline,
        shouldAbort: opts.shouldAbort,
        maxDepth: before >= 10 ? 10 : 7,
        maxNodes: before >= 10 ? 150_000 : 60_000,
      });
      if (path) {
        best = path;
        bestGain = 1;
      }
    }

    // 5) depth-3 setups
    if (bestGain < 1 && before >= 6) {
      outer: for (const a of outers) {
        for (const b of outers) {
          for (const c of outers) {
            for (const alg of algs) {
              trySeq([a, b, c, ...alg]);
              if (bestGain >= 1) break outer;
            }
          }
        }
        if (opts.shouldAbort() || Date.now() > opts.deadline) return null;
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (best && bestGain >= 1) {
      work.applyAlgo(best);
      result.push(...best);
      visited.add(fingerprint(work));
      stuck = 0;
      continue;
    }

    // Non-destructive shake only
    stuck++;
    let shook = false;
    for (const m of outers) {
      const trial = work.clone();
      trial.apply(m);
      const fp = fingerprint(trial);
      if (!trial.centersSolved() || visited.has(fp)) continue;
      if (countPairedEdges(trial) < before) continue;
      work.apply(m);
      result.push(m);
      visited.add(fp);
      shook = true;
      break;
    }
    if (shook && stuck <= 24) continue;

    if (before >= 8 && stuck <= 6) {
      const path = await endgameSearch(work, algs, outers, {
        deadline: opts.deadline,
        shouldAbort: opts.shouldAbort,
        maxDepth: 12,
        maxNodes: 250_000,
      });
      if (path) {
        const trial = work.clone();
        trial.applyAlgo(path);
        if (countPairedEdges(trial) >= before) {
          work.applyAlgo(path);
          result.push(...path);
          visited.add(fingerprint(work));
          stuck = 0;
          continue;
        }
      }
    }

    return null;
  }

  return allEdgesPaired(work) ? result : null;
}


export async function solveEdgePairing(
  cube: FaceletCube,
  opts: { deadline: number; shouldAbort: AbortFn; onProgress?: (s: string) => void },
): Promise<LayerMove[] | null> {
  if (!cube.centersSolved()) return null;
  if (allEdgesPaired(cube)) return [];

  const outers = outerMoves(cube.N);
  const prefixes: LayerMove[][] = [[]];
  for (let i = 0; i < 5; i++) {
    const a = outers[(i * 5 + 1) % outers.length];
    const b = outers[(i * 11 + 4) % outers.length];
    prefixes.push([a], [a, b]);
  }

  for (let pi = 0; pi < prefixes.length; pi++) {
    if (opts.shouldAbort() || Date.now() > opts.deadline) return null;
    const prefix = prefixes[pi];
    const trial = cube.clone();
    if (prefix.length) trial.applyAlgo(prefix);
    if (!trial.centersSolved()) continue;
    const remaining = opts.deadline - Date.now();
    const leftAttempts = prefixes.length - pi;
    const slice = Math.max(8_000, Math.floor(remaining / leftAttempts));
    opts.onProgress?.(pi === 0 ? '还原棱块…' : `还原棱块 · 换向 ${pi}…`);
    const got = await solveEdgePairingOnce(trial, {
      ...opts,
      deadline: Math.min(opts.deadline, Date.now() + slice),
    });
    if (got) return prefix.concat(got);
  }
  return null;
}
