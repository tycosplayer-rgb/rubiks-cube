/**
 * Headless Pyraminx layer checks (no WebGL).
 * Run: npx tsx scripts/verify-pyraminx.mjs
 *
 * Tip (角) and deep/mid (棱层) turn independently:
 *   tip  = d > 1.5            → 3 facelets
 *   deep = 0.4 < d ≤ 1.5      → 9 facelets (edges + axial; excludes tip)
 */
import { Pyraminx } from '../src/cube/Pyraminx.ts';
import * as THREE from 'three';

const TIP_THRESH = 1.5;
const DEEP_THRESH = 0.4;

const p = new Pyraminx('sticker');
const v = p.debugVerifyLayers();
console.log('layers', v);

function centers() {
  p.group.updateMatrixWorld(true);
  return p['tiles'].map((t) => {
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

function applyInstant(face, steps, tip) {
  const move = { kind: 'face', face, steps, tip };
  const selected = p['selectLayer'](move);
  const axis = p['faceOf'](face).axis;
  const angle = p['turnAngle'](move);
  const pivot = p['pivot'];
  pivot.rotation.set(0, 0, 0);
  pivot.scale.set(1, 1, 1);
  for (const tile of selected) reparent(tile.mesh, pivot);
  pivot.setRotationFromAxisAngle(axis, angle);
  p.group.updateMatrixWorld(true);
  for (const tile of selected) reparent(tile.mesh, p.group);
  pivot.rotation.set(0, 0, 0);
  return selected.length;
}

function maxDist(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, a[i].distanceTo(b[i]));
  return m;
}

const before = centers();
const nDeep = applyInstant('U', 1, false);
applyInstant('U', -1, false);
const roundTrip = maxDist(before, centers());

p.reset();
const b3 = centers();
applyInstant('U', 1, false);
applyInstant('U', 1, false);
applyInstant('U', 1, false);
const u3 = maxDist(b3, centers());

p.reset();
const bt = centers();
const nTip = applyInstant('U', 1, true);
applyInstant('U', 1, true);
applyInstant('U', 1, true);
const tip3 = maxDist(bt, centers());

// Tip turn must not move mid-layer (0.4 < d ≤ 1.5).
p.reset();
const axis = p['faces'][0].axis;
let c = centers();
const midIdx = [];
c.forEach((pt, i) => {
  const d = pt.dot(axis);
  if (d > DEEP_THRESH && d <= TIP_THRESH) midIdx.push(i);
});
const midBefore = midIdx.map((i) => c[i].clone());
applyInstant('U', 1, true);
c = centers();
const midDrift = Math.max(0, ...midIdx.map((i, j) => midBefore[j].distanceTo(c[i])));

// NEW: deep turn must not move that vertex's 3 tip tiles (d > 1.5).
p.reset();
c = centers();
const tipIdx = [];
c.forEach((pt, i) => {
  if (pt.dot(axis) > TIP_THRESH) tipIdx.push(i);
});
const tipBefore = tipIdx.map((i) => c[i].clone());
applyInstant('U', 1, false);
c = centers();
const tipDrift = Math.max(0, ...tipIdx.map((i, j) => tipBefore[j].distanceTo(c[i])));

const pass =
  v.tipCount === 3 &&
  v.deepCount === 9 &&
  v.tipClosed &&
  v.deepClosed &&
  v.tipLeavesMid &&
  v.deepLeavesTip &&
  nDeep === 9 &&
  nTip === 3 &&
  roundTrip < 0.05 &&
  u3 < 0.05 &&
  tip3 < 0.05 &&
  midDrift < 0.05 &&
  tipDrift < 0.05 &&
  tipIdx.length === 3 &&
  midIdx.length === 9;

console.log({
  nDeep,
  nTip,
  roundTrip,
  u3,
  tip3,
  midDrift,
  tipDrift,
  midCount: midIdx.length,
  tipCount: tipIdx.length,
});
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
