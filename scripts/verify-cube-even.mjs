/**
 * Headless even-order (and odd control) Rubik's Cube post-turn snap checks.
 * Run: npx tsx scripts/verify-cube-even.mjs
 *
 * Asserts after each layer turn:
 *   - cubie world positions equal (i - half)*step within 1e-6
 *   - indices unique and cover the outer shell
 *   - no non-uniform scale
 */
import { RubiksCube } from '../src/cube/RubiksCube.ts';
import * as THREE from 'three';

// Minimal DOM for sticker CanvasTexture (no WebGL needed).
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            fillStyle: '',
            fillRect() {},
            beginPath() {},
            moveTo() {},
            arcTo() {},
            closePath() {},
            fill() {},
          };
        },
      };
    },
  };
}

const CUBIE_SIZE = 1;
const GAP = 0.06;
const STEP = CUBIE_SIZE + GAP;
const EPS = 1e-6;

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('FAIL:', msg);
  }
}

function expectedShellCount(N) {
  return N * N * N - Math.max(0, N - 2) ** 3;
}

function assertGrid(cube, label) {
  const N = cube.getOrder();
  const half = (N - 1) / 2;
  const cubies = cube['cubies'];
  const keys = new Set();

  assert(cubies.length === expectedShellCount(N), `${label}: cubie count ${cubies.length} != shell ${expectedShellCount(N)}`);

  for (const c of cubies) {
    const { ix, iy, iz } = c;
    assert(Number.isInteger(ix) && ix >= 0 && ix < N, `${label}: ix out of range ${ix}`);
    assert(Number.isInteger(iy) && iy >= 0 && iy < N, `${label}: iy out of range ${iy}`);
    assert(Number.isInteger(iz) && iz >= 0 && iz < N, `${label}: iz out of range ${iz}`);

    const onShell = ix === 0 || ix === N - 1 || iy === 0 || iy === N - 1 || iz === 0 || iz === N - 1;
    assert(onShell, `${label}: internal cubie at (${ix},${iy},${iz})`);

    const key = `${ix},${iy},${iz}`;
    assert(!keys.has(key), `${label}: duplicate index ${key}`);
    keys.add(key);

    const ex = (ix - half) * STEP;
    const ey = (iy - half) * STEP;
    const ez = (iz - half) * STEP;
    const p = c.mesh.position;
    assert(Math.abs(p.x - ex) < EPS, `${label}: pos.x ${p.x} != ${ex} for (${ix},${iy},${iz})`);
    assert(Math.abs(p.y - ey) < EPS, `${label}: pos.y ${p.y} != ${ey} for (${ix},${iy},${iz})`);
    assert(Math.abs(p.z - ez) < EPS, `${label}: pos.z ${p.z} != ${ez} for (${ix},${iy},${iz})`);

    const s = c.mesh.scale;
    assert(
      Math.abs(s.x - 1) < EPS && Math.abs(s.y - 1) < EPS && Math.abs(s.z - 1) < EPS,
      `${label}: non-uniform scale (${s.x},${s.y},${s.z}) at (${ix},${iy},${iz})`,
    );
  }
}

/** Drive animateMove via update() until turnAnim completes. */
async function applyTurn(cube, move) {
  const done = cube['animateMove'](move, false);
  let guard = 0;
  while (cube['turnAnim'] && guard++ < 50) {
    const anim = cube['turnAnim'];
    cube.update(anim.startMs + anim.durationMs + 1);
  }
  assert(!cube.isBusy(), `still busy after turn ${JSON.stringify(move)}`);
  await done;
}

function moveSeq(N) {
  /** All axes, outer + (for even) both inner half-layers, quarter + half turns. */
  const layers = new Set([0, N - 1]);
  if (N % 2 === 0) {
    layers.add(N / 2 - 1);
    layers.add(N / 2);
  } else {
    layers.add(Math.floor(N / 2));
  }
  const seq = [];
  for (const axis of /** @type {const} */ (['x', 'y', 'z'])) {
    for (const layer of layers) {
      for (const turns of /** @type {const} */ ([1, 2, 3])) {
        seq.push({ axis, layer, turns });
      }
    }
  }
  // A short scramble-like mix across axes
  seq.push(
    { axis: 'x', layer: 0, turns: 1 },
    { axis: 'y', layer: N - 1, turns: 1 },
    { axis: 'z', layer: 0, turns: 2 },
    { axis: 'x', layer: N - 1, turns: 3 },
    { axis: 'y', layer: [...layers][1] ?? 0, turns: 1 },
    { axis: 'z', layer: [...layers].at(-1) ?? 0, turns: 2 },
  );
  return seq;
}

async function verifyOrder(N) {
  console.log(`\n=== order ${N} ===`);
  const cube = new RubiksCube(N, 'sticker');
  assertGrid(cube, `N=${N} initial`);

  const seq = moveSeq(N);
  for (let i = 0; i < seq.length; i++) {
    const m = seq[i];
    await applyTurn(cube, m);
    assertGrid(cube, `N=${N} after #${i} ${m.axis}${m.layer}x${m.turns}`);
    if (failures > 20) {
      console.error('too many failures, aborting this order');
      break;
    }
  }

  // Round-trip: four +1 turns on each outer layer should restore indices uniquely
  for (const axis of /** @type {const} */ (['x', 'y', 'z'])) {
    for (const layer of [0, N - 1]) {
      for (let k = 0; k < 4; k++) {
        await applyTurn(cube, { axis, layer, turns: 1 });
        assertGrid(cube, `N=${N} 4-cycle ${axis}${layer} step ${k}`);
      }
    }
  }

  cube.dispose();
  console.log(`order ${N}: done (${failures === 0 ? 'ok so far' : failures + ' failures so far'})`);
}

const orders = [2, 3, 4, 5, 6];
for (const N of orders) {
  await verifyOrder(N);
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll even/odd cube snap checks passed.');
