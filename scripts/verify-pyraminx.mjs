/**
 * Headless Pyraminx layer checks (no WebGL).
 * Run: npx tsx scripts/verify-pyraminx.mjs
 *
 * Tip (角) and deep/mid (棱层) turn independently:
 *   tip  = d > 1.5            → 3 facelets
 *   deep = 0.4 < d ≤ 1.5      → 9 facelets (edges + axial; excludes tip)
 *
 * dragToMove: tip sticker → { tip:true, face: that tip };
 *             mid-band sticker → tip falsy, selectLayer is deep-only.
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

// --- dragToMove: tip sticker → 角层; mid-band → 棱层 (deep only) ---
p.reset();
p.group.updateMatrixWorld(true);
const tiles = p['tiles'];
const faces = p['faces'];

function worldCenterOf(tile) {
  const c = new THREE.Vector3();
  const attr = tile.mesh.geometry.getAttribute('position');
  for (let i = 0; i < attr.count; i++) c.add(new THREE.Vector3().fromBufferAttribute(attr, i));
  return c.multiplyScalar(1 / attr.count).applyMatrix4(tile.mesh.matrixWorld);
}

function makeCam(pos) {
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.copy(pos);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function swipeMove(mesh, point, camera) {
  const n = new THREE.Vector3(0, 1, 0);
  const dirs = [
    [24, 0],
    [0, 24],
    [-24, 0],
    [0, -24],
    [16, 16],
    [16, -16],
    [-16, 16],
    [-16, -16],
  ];
  for (const [x, y] of dirs) {
    const m = p.dragToMove(mesh, n, new THREE.Vector2(x, y), camera, point.clone());
    if (m) return m;
  }
  return null;
}

const uFace = faces[0];
const uCam = makeCam(uFace.axis.clone().multiplyScalar(8));
const uTipTile = tiles.find((t) => t.mesh.userData.tipPiece === 0);
const uTipPt = worldCenterOf(uTipTile);
const tipSwipe = swipeMove(uTipTile.mesh, uTipPt, uCam);
const tipSwipeOk =
  !!tipSwipe &&
  tipSwipe.kind === 'face' &&
  tipSwipe.face === uFace.id &&
  tipSwipe.tip === true;
const tipSwipeLayer = tipSwipe ? p['selectLayer'](tipSwipe).length : 0;

const uMidTile = tiles
  .map((t) => ({ t, d: worldCenterOf(t).dot(uFace.axis), tip: t.mesh.userData.tipPiece ?? -1 }))
  .filter((x) => x.tip < 0 && x.d > DEEP_THRESH && x.d <= TIP_THRESH)
  .sort((a, b) => b.d - a.d)[0]?.t;
const uMidPt = worldCenterOf(uMidTile);
const deepSwipe = swipeMove(uMidTile.mesh, uMidPt, uCam);
const deepSel = deepSwipe ? p['selectLayer'](deepSwipe) : [];
const deepAxis = deepSwipe ? p['faceOf'](deepSwipe.face).axis : uFace.axis;
const deepHitsTip = deepSel.some((t) => worldCenterOf(t).dot(deepAxis) > TIP_THRESH);
const deepSwipeOk =
  !!deepSwipe &&
  deepSwipe.kind === 'face' &&
  !deepSwipe.tip &&
  deepSel.length === 9 &&
  !deepHitsTip;

// Bottom / downward tip: swipe its tip sticker → 角层 of that tip (not the upper mid-band).
let bottomIdx = 0;
let minY = Infinity;
faces.forEach((f, i) => {
  if (f.axis.y < minY) {
    minY = f.axis.y;
    bottomIdx = i;
  }
});
const bFace = faces[bottomIdx];
const bCam = makeCam(bFace.axis.clone().multiplyScalar(8));
const bTipTile = tiles.find((t) => t.mesh.userData.tipPiece === bottomIdx);
const bTipSwipe = swipeMove(bTipTile.mesh, worldCenterOf(bTipTile), bCam);
const bTipOk =
  !!bTipSwipe && bTipSwipe.tip === true && bTipSwipe.face === bFace.id;
const bMidTile = tiles
  .map((t) => ({ t, d: worldCenterOf(t).dot(bFace.axis), tip: t.mesh.userData.tipPiece ?? -1 }))
  .filter((x) => x.tip < 0 && x.d > 1.0 && x.d <= TIP_THRESH)
  .sort((a, b) => b.d - a.d)[0]?.t;
const bMidSwipe = swipeMove(bMidTile.mesh, worldCenterOf(bMidTile), bCam);
const bMidSel = bMidSwipe ? p['selectLayer'](bMidSwipe) : [];
const bMidAxis = bMidSwipe ? p['faceOf'](bMidSwipe.face).axis : bFace.axis;
const bMidHitsTip = bMidSel.some((t) => worldCenterOf(t).dot(bMidAxis) > TIP_THRESH);
const bDeepOk =
  !!bMidSwipe &&
  !bMidSwipe.tip &&
  bMidSwipe.face === bFace.id &&
  bMidSel.length === 9 &&
  !bMidHitsTip;

const tipButtons = p.getFaceButtons().filter((b) => b.tip);
const faceIds = new Set(faces.map((f) => f.id));
const tipButtonsOk2 = tipButtons.length === 4 && tipButtons.every((b) => faceIds.has(b.id));

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
  midIdx.length === 9 &&
  tipSwipeOk &&
  tipSwipeLayer === 3 &&
  deepSwipeOk &&
  bTipOk &&
  bDeepOk &&
  tipButtonsOk2;

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
  tipSwipe,
  tipSwipeOk,
  tipSwipeLayer,
  deepSwipe,
  deepSwipeOk,
  deepSel: deepSel.length,
  bTipSwipe,
  bTipOk,
  bMidSwipe,
  bDeepOk,
  tipButtons: tipButtons.length,
});
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
