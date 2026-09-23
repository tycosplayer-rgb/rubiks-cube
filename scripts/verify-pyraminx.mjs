/**
 * Headless Pyraminx layer checks (no WebGL).
 * Run: npx tsx scripts/verify-pyraminx.mjs
 *
 * Three C3-closed bands about each tip axis T:
 *   tip    = d > 1.5            → 3 facelets (tip T only)
 *   deep   = 0.4 < d ≤ 1.5      → 9 facelets (edges + axial; excludes tip)
 *   bottom = d ≤ 0.4            → 24 facelets (far band + 底座三角 / other tips)
 *
 * Bottom about T includes the three other tips' tip stickers (base corners) and
 * cycles them; tip T itself stays put. Tip swipe uses current world projection.
 * After a bottom U turn, swipe on stickers now at tip L must return tip L (not U).
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

function applyInstant(face, steps, flags = {}) {
  const move = { kind: 'face', face, steps, ...flags };
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
const nDeep = applyInstant('U', 1, {});
applyInstant('U', -1, {});
const roundTrip = maxDist(before, centers());

p.reset();
const b3 = centers();
applyInstant('U', 1, {});
applyInstant('U', 1, {});
applyInstant('U', 1, {});
const u3 = maxDist(b3, centers());

p.reset();
const bt = centers();
const nTip = applyInstant('U', 1, { tip: true });
applyInstant('U', 1, { tip: true });
applyInstant('U', 1, { tip: true });
const tip3 = maxDist(bt, centers());

p.reset();
const bb = centers();
const nBottom = applyInstant('U', 1, { bottom: true });
applyInstant('U', 1, { bottom: true });
applyInstant('U', 1, { bottom: true });
const bottom3 = maxDist(bb, centers());

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
applyInstant('U', 1, { tip: true });
c = centers();
const midDrift = Math.max(0, ...midIdx.map((i, j) => midBefore[j].distanceTo(c[i])));

// Deep turn must not move tip tiles.
p.reset();
c = centers();
const tipIdx = [];
c.forEach((pt, i) => {
  if (pt.dot(axis) > TIP_THRESH) tipIdx.push(i);
});
const tipBefore = tipIdx.map((i) => c[i].clone());
applyInstant('U', 1, {});
c = centers();
const tipDrift = Math.max(0, ...tipIdx.map((i, j) => tipBefore[j].distanceTo(c[i])));

// Bottom must not move tip or mid; tip/deep must not move bottom.
p.reset();
c = centers();
const facesAll = p['faces'];
const bottomIdx = [];
c.forEach((pt, i) => {
  if (pt.dot(axis) <= DEEP_THRESH) bottomIdx.push(i);
});
// Base tips (non-U tip bands): must move with bottom U.
const baseTipIdx = [];
c.forEach((pt, i) => {
  if (pt.dot(axis) > DEEP_THRESH) return;
  if (facesAll.some((f, fi) => fi !== 0 && pt.dot(f.axis) > TIP_THRESH)) baseTipIdx.push(i);
});
const bottomBefore = bottomIdx.map((i) => c[i].clone());
const tipBefore2 = tipIdx.map((i) => c[i].clone());
const midBefore2 = midIdx.map((i) => c[i].clone());
const baseTipBefore = baseTipIdx.map((i) => c[i].clone());
applyInstant('U', 1, { bottom: true });
c = centers();
const tipDriftFromBottom = Math.max(0, ...tipIdx.map((i, j) => tipBefore2[j].distanceTo(c[i])));
const midDriftFromBottom = Math.max(0, ...midIdx.map((i, j) => midBefore2[j].distanceTo(c[i])));
const baseTipDriftFromBottom = Math.min(...baseTipIdx.map((i, j) => baseTipBefore[j].distanceTo(c[i])));
const baseTipsMoved = baseTipIdx.length === 9 && baseTipDriftFromBottom > 0.3;

p.reset();
c = centers();
const bottomBeforeTip = bottomIdx.map((i) => c[i].clone());
applyInstant('U', 1, { tip: true });
c = centers();
const bottomDriftFromTip = Math.max(0, ...bottomIdx.map((i, j) => bottomBeforeTip[j].distanceTo(c[i])));

p.reset();
c = centers();
const bottomBeforeDeep = bottomIdx.map((i) => c[i].clone());
applyInstant('U', 1, {});
c = centers();
const bottomDriftFromDeep = Math.max(0, ...bottomIdx.map((i, j) => bottomBeforeDeep[j].distanceTo(c[i])));

// --- dragToMove ---
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
  tipSwipe.tip === true &&
  !tipSwipe.bottom;
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
  !deepSwipe.bottom &&
  deepSel.length === 9 &&
  !deepHitsTip;

// Opposite-face center (faceIndex === tipIndex U=0), view from below → bottom.
const oppCam = makeCam(uFace.axis.clone().multiplyScalar(-8));
const oppCenter = tiles
  .map((t) => {
    const pt = worldCenterOf(t);
    const ds = faces.map((f) => pt.dot(f.axis));
    const maxSide = Math.max(...ds.filter((_, i) => i !== 0));
    return {
      t,
      faceIndex: t.mesh.userData.faceIndex,
      tip: t.mesh.userData.tipPiece ?? -1,
      dU: pt.dot(uFace.axis),
      maxSide,
      pt,
    };
  })
  .filter((x) => x.faceIndex === 0 && x.tip < 0)
  .sort((a, b) => a.maxSide - b.maxSide)[0];
const bottomSwipe = oppCenter
  ? swipeMove(oppCenter.t.mesh, oppCenter.pt, oppCam)
  : null;
const bottomSwipeOk =
  !!bottomSwipe &&
  bottomSwipe.kind === 'face' &&
  bottomSwipe.face === uFace.id &&
  bottomSwipe.bottom === true &&
  !bottomSwipe.tip;
const bottomSwipeLayer = bottomSwipe ? p['selectLayer'](bottomSwipe).length : 0;

// Far-band side sticker with tip U up (camera along +U) → bottom about U.
const farTile = tiles
  .map((t) => ({ t, d: worldCenterOf(t).dot(uFace.axis), tip: t.mesh.userData.tipPiece ?? -1, fi: t.mesh.userData.faceIndex }))
  .filter((x) => x.tip < 0 && x.d <= DEEP_THRESH && x.fi !== 0)
  .sort((a, b) => a.d - b.d)[0]?.t;
const farPt = farTile ? worldCenterOf(farTile) : null;
const farSwipe = farTile ? swipeMove(farTile.mesh, farPt, uCam) : null;
const farSwipeBottom =
  !!farSwipe &&
  farSwipe.face === uFace.id &&
  farSwipe.bottom === true &&
  !farSwipe.tip;

// Downward tip tip/deep still work.
let downIdx = 0;
let minY = Infinity;
faces.forEach((f, i) => {
  if (f.axis.y < minY) {
    minY = f.axis.y;
    downIdx = i;
  }
});
const bFace = faces[downIdx];
const bCam = makeCam(bFace.axis.clone().multiplyScalar(8));
const bTipTile = tiles.find((t) => t.mesh.userData.tipPiece === downIdx);
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
  !bMidSwipe.bottom &&
  bMidSwipe.face === bFace.id &&
  bMidSel.length === 9 &&
  !bMidHitsTip;

// --- After bottom U: carries 3×3 base tip stickers; U tip stays; world tip resolve ---
p.reset();
applyInstant('U', 1, { bottom: true });
p.group.updateMatrixWorld(true);
const bottomSel = p['selectLayer']({ kind: 'face', face: 'U', steps: 1, bottom: true });
const bottomBaseTipCount = bottomSel.filter((t) => {
  const pt = worldCenterOf(t);
  return faces.some((f, fi) => fi !== 0 && pt.dot(f.axis) > TIP_THRESH);
}).length;
const bottomHasOwnTip = bottomSel.some((t) => worldCenterOf(t).dot(faces[0].axis) > TIP_THRESH);
const bottomCarriesBaseTips =
  bottomSel.length === 24 && bottomBaseTipCount === 9 && !bottomHasOwnTip;

// Tip identity by current position: even with tipPiece deliberately stale (claims U),
// a sticker sitting at tip L must swipe as tip L — not U.
const lFace = faces[1]; // L
const lCam = makeCam(lFace.axis.clone().multiplyScalar(8));
const atTipL = tiles
  .map((t) => ({ t, d: worldCenterOf(t).dot(lFace.axis) }))
  .filter((x) => x.d > TIP_THRESH)
  .sort((a, b) => b.d - a.d)[0]?.t;
const savedTipPiece = atTipL ? atTipL.mesh.userData.tipPiece : undefined;
if (atTipL) atTipL.mesh.userData.tipPiece = 0; // stale claim: U
const postBottomTipSwipe = atTipL
  ? swipeMove(atTipL.mesh, worldCenterOf(atTipL), lCam)
  : null;
if (atTipL) atTipL.mesh.userData.tipPiece = savedTipPiece;
const postBottomTipOk =
  !!postBottomTipSwipe &&
  postBottomTipSwipe.tip === true &&
  postBottomTipSwipe.face === lFace.id &&
  !postBottomTipSwipe.bottom;

const tipButtons = p.getFaceButtons().filter((b) => b.tip);
const bottomButtons = p.getFaceButtons().filter((b) => b.bottom);
const faceIds = new Set(faces.map((f) => f.id));
const tipButtonsOk2 = tipButtons.length === 4 && tipButtons.every((b) => faceIds.has(b.id));
const bottomButtonsOk = bottomButtons.length === 4 && bottomButtons.every((b) => faceIds.has(b.id));

const pass =
  v.tipCount === 3 &&
  v.deepCount === 9 &&
  v.bottomCount === 24 &&
  v.tipClosed &&
  v.deepClosed &&
  v.bottomClosed &&
  v.tipLeavesMid &&
  v.deepLeavesTip &&
  v.bottomLeavesTip &&
  v.bottomLeavesMid &&
  v.bottomRoundTrip &&
  nDeep === 9 &&
  nTip === 3 &&
  nBottom === 24 &&
  roundTrip < 0.05 &&
  u3 < 0.05 &&
  tip3 < 0.05 &&
  bottom3 < 0.05 &&
  midDrift < 0.05 &&
  tipDrift < 0.05 &&
  tipDriftFromBottom < 0.05 &&
  midDriftFromBottom < 0.05 &&
  bottomDriftFromTip < 0.05 &&
  bottomDriftFromDeep < 0.05 &&
  tipIdx.length === 3 &&
  midIdx.length === 9 &&
  bottomIdx.length === 24 &&
  baseTipsMoved &&
  tipSwipeOk &&
  tipSwipeLayer === 3 &&
  deepSwipeOk &&
  bottomSwipeOk &&
  bottomSwipeLayer === 24 &&
  farSwipeBottom &&
  bTipOk &&
  bDeepOk &&
  postBottomTipOk &&
  bottomCarriesBaseTips &&
  tipButtonsOk2 &&
  bottomButtonsOk;

console.log({
  nDeep,
  nTip,
  nBottom,
  roundTrip,
  u3,
  tip3,
  bottom3,
  midDrift,
  tipDrift,
  tipDriftFromBottom,
  midDriftFromBottom,
  bottomDriftFromTip,
  bottomDriftFromDeep,
  midCount: midIdx.length,
  tipCount: tipIdx.length,
  bottomCount: bottomIdx.length,
  tipSwipe,
  tipSwipeOk,
  tipSwipeLayer,
  deepSwipe,
  deepSwipeOk,
  deepSel: deepSel.length,
  bottomSwipe,
  bottomSwipeOk,
  bottomSwipeLayer,
  farSwipe,
  farSwipeBottom,
  bTipSwipe,
  bTipOk,
  bMidSwipe,
  bDeepOk,
  tipButtons: tipButtons.length,
  bottomButtons: bottomButtons.length,
  postBottomTipSwipe,
  postBottomTipOk,
  baseTipCount: baseTipIdx.length,
  baseTipDriftFromBottom,
  baseTipsMoved,
  bottomCarriesBaseTips,
  bottomSelCount: bottomSel.length,
  bottomBaseTipCount,
  bottomHasOwnTip,
});
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
