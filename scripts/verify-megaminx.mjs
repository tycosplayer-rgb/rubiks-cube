/**
 * Headless Megaminx star-cut / layer checks (no WebGL).
 * Run: npm run verify:megaminx
 */
import { Megaminx } from '../src/cube/Megaminx.ts';
import * as THREE from 'three';

const m = new Megaminx('sticker');
const v = m.debugVerifyLayers();
console.log('layers', v);

function centers() {
  m.group.updateMatrixWorld(true);
  return m['tiles'].map((t) => {
    const c = new THREE.Vector3();
    const attr = t.mesh.geometry.getAttribute('position');
    for (let i = 0; i < attr.count; i++) c.add(new THREE.Vector3().fromBufferAttribute(attr, i));
    return c.multiplyScalar(1 / attr.count).applyMatrix4(t.mesh.matrixWorld);
  });
}

function reparent(obj, newParent) {
  obj.updateWorldMatrix(true, false);
  newParent.updateWorldMatrix(true, false);
  const world = obj.matrixWorld.clone();
  if (obj.parent !== newParent) newParent.add(obj);
  const local = new THREE.Matrix4().copy(newParent.matrixWorld).invert().multiply(world);
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  local.decompose(pos, quat, scl);
  obj.position.copy(pos);
  obj.quaternion.copy(quat);
  obj.scale.setScalar(1);
  obj.updateMatrix();
}

function applyInstant(face, steps) {
  const move = { kind: 'face', face, steps };
  const selected = m['selectLayer'](move);
  const axis = m['faceOf'](face).axis;
  const angle = m['turnAngle'](move);
  const pivot = m['pivot'];
  pivot.rotation.set(0, 0, 0);
  pivot.scale.set(1, 1, 1);
  for (const tile of selected) reparent(tile.mesh, pivot);
  pivot.setRotationFromAxisAngle(axis, angle);
  m.group.updateMatrixWorld(true);
  for (const tile of selected) reparent(tile.mesh, m.group);
  pivot.rotation.set(0, 0, 0);
  return selected.length;
}

function maxDist(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, a[i].distanceTo(b[i]));
  return d;
}

function faceCounts() {
  return m['faces'].map((f) => ({
    face: f.id,
    count: m.stickersOnFace(f.id).length,
  }));
}

function assertCoverage(label) {
  const counts = faceCounts();
  const bad = counts.filter((c) => c.count !== 11);
  if (bad.length) {
    console.error(label, 'empty/partial faces', bad);
    return false;
  }
  return true;
}

function layerMatchesFace(face) {
  const onFace = m.stickersOnFace(face);
  const selected = m['selectLayer']({ kind: 'face', face, steps: 1 });
  const selSet = new Set(selected);
  const missing = onFace.filter((t) => !selSet.has(t));
  return {
    layerCount: selected.length,
    onFace: onFace.length,
    missingOnFace: missing.length,
    ok: selected.length === 26 && onFace.length === 11 && missing.length === 0,
  };
}

const before = centers();
const nLayer = applyInstant('U', 1);
applyInstant('U', -1);
const roundTrip = maxDist(before, centers());

m.reset();
const b5 = centers();
for (let i = 0; i < 5; i++) applyInstant('U', 1);
const five = maxDist(b5, centers());

m.reset();
const b2 = centers();
applyInstant('R', 1);
applyInstant('U', 1);
applyInstant('U', -1);
applyInstant('R', -1);
const commute = maxDist(b2, centers());

// After adjacent turns, layer must still track CURRENT face occupancy.
m.reset();
applyInstant('R', 1);
applyInstant('FR', 1);
const afterAdj = layerMatchesFace('U');
console.log('after R,FR layer U', afterAdj);

m.reset();
const faces = m['faces'].map((f) => f.id);
const seq = [];
let prev = '';
for (let i = 0; i < 24; i++) {
  let face = faces[Math.floor(Math.random() * faces.length)];
  while (face === prev) face = faces[Math.floor(Math.random() * faces.length)];
  prev = face;
  const steps = Math.random() < 0.5 ? 1 : -1;
  seq.push({ face, steps });
  const n = applyInstant(face, steps);
  if (n !== 26) {
    console.error('bad layer size at move', i + 1, face, n);
  }
}
const afterScramble = assertCoverage('after 24 random');
const midLayer = layerMatchesFace(seq[seq.length - 1]?.face ?? 'U');

// Inverse the sequence — every face must stay covered, then restore.
for (let i = seq.length - 1; i >= 0; i--) {
  applyInstant(seq[i].face, -seq[i].steps);
}
const afterInverse = assertCoverage('after inverse');
const restored = maxDist(before, centers());

// resolveHitFace must map stickers currently on a face back to that face,
// even after adjacent turns (stale userData.turnFace must not win).
function assertResolveHitFace(label) {
  m.group.updateMatrixWorld(true);
  const tmpN = new THREE.Vector3();
  const tmpP = new THREE.Vector3();
  let failures = 0;
  let checked = 0;
  for (const face of m['faces']) {
    const onFace = m.stickersOnFace(face.id);
    for (const tile of onFace) {
      checked++;
      const point = m['tileWorldCenter'](tile, tmpP).clone();
      // Approximate outward normal ≈ face axis (sticker sits on this face).
      const normal = face.axis.clone();
      const resolved = m['resolveHitFace'](point, normal);
      if (!resolved || resolved.id !== face.id) {
        failures++;
        if (failures <= 3) {
          console.error(label, 'resolve mismatch', {
            expect: face.id,
            got: resolved?.id,
            staleTurnFace: tile.mesh.userData.turnFace,
            pieceId: tile.pieceId,
          });
        }
      }
      // Point-only fallback must also agree for on-face stickers.
      const byPoint = m['resolveHitFace'](point);
      if (!byPoint || byPoint.id !== face.id) {
        failures++;
        if (failures <= 3) {
          console.error(label, 'point-fallback mismatch', {
            expect: face.id,
            got: byPoint?.id,
          });
        }
      }
    }
  }
  const ok = failures === 0 && checked > 0;
  console.log(label, { checked, failures, ok });
  return ok;
}

m.reset();
const resolveSolved = assertResolveHitFace('resolve solved');
m.reset();
applyInstant('R', 1);
applyInstant('FR', 1);
applyInstant('U', 1);
// After U, a sticker that started on R may now sit on U — resolve must say U.
const resolveAfterMoves = assertResolveHitFace('resolve after R,FR,U');

// Stale turnFace trap: pick a sticker whose build-time turnFace != current face.
m.reset();
applyInstant('R', 1);
applyInstant('FR', 1);
let staleTrapOk = false;
{
  const uStickers = m.stickersOnFace('U');
  const migrated = uStickers.find((t) => String(t.mesh.userData.turnFace) !== 'U');
  if (!migrated) {
    // All U stickers still have turnFace U (centers never leave) — force via edge/corner.
    console.log('staleTrap', { migrated: false, note: 'no migrated sticker yet' });
    staleTrapOk = uStickers.length === 11; // still require face occupancy
  } else {
    const point = m['tileWorldCenter'](migrated).clone();
    const resolved = m['resolveHitFace'](point, m['faceOf']('U').axis);
    staleTrapOk = resolved?.id === 'U';
    console.log('staleTrap', {
      staleTurnFace: migrated.mesh.userData.turnFace,
      resolved: resolved?.id,
      ok: staleTrapOk,
    });
  }
}

// Large-gap heuristic: each face's 11 stickers should sit in a tight proj band.

function maxFaceGap() {
  let worst = 0;
  for (const f of m['faces']) {
    const axis = f.axis;
    const projs = m
      .stickersOnFace(f.id)
      .map((t) => m['tileWorldCenter'](t).dot(axis))
      .sort((a, b) => a - b);
    if (projs.length !== 11) {
      worst = Infinity;
      continue;
    }
    worst = Math.max(worst, projs[projs.length - 1] - projs[0]);
  }
  return worst;
}
m.reset();
for (const { face, steps } of seq) applyInstant(face, steps);
const gap = maxFaceGap();

const pass =
  v.tiles === 132 &&
  v.perFace === 11 &&
  v.layerCount === 26 &&
  v.centers === 12 &&
  v.edges === 60 &&
  v.corners === 60 &&
  v.layerClosed &&
  v.fiveTurnClosed &&
  v.pieceGraphOk &&
  nLayer === 26 &&
  roundTrip < 0.05 &&
  five < 0.05 &&
  commute < 0.05 &&
  afterAdj.ok &&
  afterScramble &&
  midLayer.ok &&
  afterInverse &&
  restored < 0.05 &&
  gap < 0.08 &&
  resolveSolved &&
  resolveAfterMoves &&
  staleTrapOk;

console.log({
  nLayer,
  roundTrip,
  five,
  commute,
  afterAdj,
  midLayer,
  afterScramble,
  afterInverse,
  restored,
  gap,
  resolveSolved,
  resolveAfterMoves,
  staleTrapOk,
});
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
