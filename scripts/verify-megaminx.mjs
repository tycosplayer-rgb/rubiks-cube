/**
 * Headless Megaminx checks (N≥4 parallel lattice; N=4 ★ void / no center; no WebGL).
 * Run: npm run verify:megaminx
 */
import { Megaminx } from '../src/cube/Megaminx.ts';
import * as THREE from 'three';

const m = new Megaminx(3, 'sticker');
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

function applyInstant(face, steps, depth) {
  const move = { kind: 'face', face, steps, ...(depth ? { depth } : {}) };
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



// --- dragToMove: edge → side face (not F); center → F ---
function makeCamera() {
  const cam = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  cam.position.set(0, 1.2, 9);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

function layerFacesForPiece(pieceId) {
  m.group.updateMatrixWorld(true);
  const faces = [];
  for (const f of m['faces']) {
    const tiles = m['megaTiles'].filter((t) => t.pieceId === pieceId);
    if (tiles.some((t) => m['tileWorldCenter'](t).dot(f.axis) > 2.17)) faces.push(f.id);
  }
  return faces;
}

/** Score ±1 steps on a single face (mirror of dragToMove direction scoring). */
function bestStepsOnFace(point, faceId, delta, cam) {
  const f = m['faceOf'](faceId);
  const radial = point.clone().addScaledVector(f.axis, -point.dot(f.axis));
  const tangent = new THREE.Vector3().crossVectors(f.axis, radial);
  if (tangent.lengthSq() < 1e-8) return { steps: 1, score: -Infinity };
  tangent.normalize();
  const p0 = point.clone().project(cam);
  let best = { steps: 1, score: -Infinity };
  for (const steps of [1, -1]) {
    const p1 = point.clone().addScaledVector(tangent, steps).project(cam);
    let sx = p1.x - p0.x;
    let sy = -(p1.y - p0.y);
    const slen = Math.hypot(sx, sy);
    if (slen < 1e-10) continue;
    sx /= slen;
    sy /= slen;
    const score = delta.x * sx + delta.y * sy;
    if (score > best.score) best = { steps, score };
  }
  return best;
}

function assertDragScoring() {
  m.reset();
  const cam = makeCamera();
  let failures = 0;
  let edgeChecked = 0;
  let edgeSideOk = 0;
  let centerChecked = 0;
  let centerOk = 0;
  let cornerChecked = 0;
  let cornerOk = 0;

  // Edge hit on front F: must turn the other face S ≠ F (侧面 of this 棱).
  const edges = m['megaTiles'].filter((t) => t.kind === 'edge');
  for (const tile of edges) {
    const faces = layerFacesForPiece(tile.pieceId);
    if (faces.length < 2) continue;
    const buildFace = m['faces'][tile.faceIndex];
    const F = buildFace.id;
    const sides = faces.filter((id) => id !== F);
    if (sides.length !== 1) continue;
    const expectFace = sides[0];
    const point = m['tileWorldCenter'](tile).clone();
    const normal = buildFace.axis.clone();

    for (const delta of [
      new THREE.Vector2(-40, 0),
      new THREE.Vector2(40, 0),
      new THREE.Vector2(0, -40),
      new THREE.Vector2(0, 40),
    ]) {
      const { steps: expectSteps, score } = bestStepsOnFace(point, expectFace, delta, cam);
      const move = m.dragToMove(tile.mesh, normal, delta, cam, point);
      edgeChecked++;
      if (score < 1e-6) {
        if (move !== null) {
          failures++;
          if (failures <= 5) console.error('edge: expected null for weak swipe', { move, score });
        }
        continue;
      }
      // Must prefer adjacent face over F — never turn the front face for an edge hit.
      if (!move || move.kind !== 'face' || move.face === F) {
        failures++;
        if (failures <= 5) {
          console.error('edge: must turn side face not F', {
            pieceId: tile.pieceId,
            F,
            expectFace,
            got: move,
            candidates: faces,
          });
        }
        continue;
      }
      if (move.face !== expectFace || move.steps !== expectSteps) {
        failures++;
        if (failures <= 5) {
          console.error('edge: side-face/steps mismatch', {
            pieceId: tile.pieceId,
            expect: { face: expectFace, steps: expectSteps, score },
            got: move,
          });
        }
      } else {
        edgeSideOk++;
      }
    }
  }

  // Center hit: turn F.
  const centers = m['megaTiles'].filter((t) => t.kind === 'center');
  for (const tile of centers) {
    const buildFace = m['faces'][tile.faceIndex];
    const F = buildFace.id;
    const point = m['tileWorldCenter'](tile).clone();
    const normal = buildFace.axis.clone();
    for (const delta of [new THREE.Vector2(-40, 0), new THREE.Vector2(0, 40)]) {
      const { steps: expectSteps, score } = bestStepsOnFace(point, F, delta, cam);
      const move = m.dragToMove(tile.mesh, normal, delta, cam, point);
      centerChecked++;
      if (score < 1e-6) {
        if (move !== null) {
          failures++;
          if (failures <= 5) console.error('center: expected null', { move, score });
        }
        continue;
      }
      if (!move || move.face !== F || move.steps !== expectSteps) {
        failures++;
        if (failures <= 5) {
          console.error('center: must turn F', {
            F,
            expectSteps,
            got: move,
            pieceId: tile.pieceId,
          });
        }
      } else {
        centerOk++;
      }
    }
  }

  // Corner hit: turn one of the side faces (not F), chosen by swipe scoring.
  const corners = m['megaTiles'].filter((t) => t.kind === 'corner');
  for (const tile of corners) {
    const faces = layerFacesForPiece(tile.pieceId);
    const buildFace = m['faces'][tile.faceIndex];
    const F = buildFace.id;
    const sides = faces.filter((id) => id !== F);
    if (sides.length < 1) continue;
    const point = m['tileWorldCenter'](tile).clone();
    const normal = buildFace.axis.clone();
    for (const delta of [new THREE.Vector2(-40, 0), new THREE.Vector2(40, 0)]) {
      let expectFace = null;
      let expectSteps = 1;
      let expectScore = 0;
      for (const faceId of sides) {
        const r = bestStepsOnFace(point, faceId, delta, cam);
        if (r.score > expectScore) {
          expectScore = r.score;
          expectFace = faceId;
          expectSteps = r.steps;
        }
      }
      const move = m.dragToMove(tile.mesh, normal, delta, cam, point);
      cornerChecked++;
      if (expectScore < 1e-6) {
        if (move !== null) {
          failures++;
          if (failures <= 5) console.error('corner: expected null', { move, expectScore });
        }
        continue;
      }
      if (!move || move.face === F || move.face !== expectFace || move.steps !== expectSteps) {
        failures++;
        if (failures <= 5) {
          console.error('corner: must pick side face by swipe', {
            F,
            sides,
            expect: { face: expectFace, steps: expectSteps },
            got: move,
          });
        }
      } else {
        cornerOk++;
      }
    }
  }

  const ok =
    failures === 0 &&
    edgeChecked > 0 &&
    edgeSideOk > 0 &&
    centerChecked > 0 &&
    centerOk > 0 &&
    cornerChecked > 0 &&
    cornerOk > 0;
  console.log('dragScoring', {
    edgeChecked,
    edgeSideOk,
    centerChecked,
    centerOk,
    cornerChecked,
    cornerOk,
    failures,
    ok,
  });
  return ok;
}

m.reset();
const dragScoringOk = assertDragScoring();


// --- Order smoke: N=2,4,5,6,7 (N=3 covered by full regression above) ---
function smokeMegaOrder(N) {
  const q = new Megaminx(N, 'sticker');
  const vv = q.debugVerifyLayers();
  const expected = q.expectedPerFace();
  const layer = q['selectLayer']({ kind: 'face', face: 'U', steps: 1 });
  const getCenters = () => {
    q.group.updateMatrixWorld(true);
    return q['tiles'].map((t) => {
      const c = new THREE.Vector3();
      const attr = t.mesh.geometry.getAttribute('position');
      for (let i = 0; i < attr.count; i++) c.add(new THREE.Vector3().fromBufferAttribute(attr, i));
      return c.multiplyScalar(1 / attr.count).applyMatrix4(t.mesh.matrixWorld);
    });
  };
  const apply = (face, steps, depth) => {
    const move = { kind: 'face', face, steps, ...(depth ? { depth } : {}) };
    const selected = q['selectLayer'](move);
    const axis = q['faceOf'](face).axis;
    const angle = q['turnAngle'](move);
    const pivot = q['pivot'];
    pivot.rotation.set(0, 0, 0);
    for (const tile of selected) reparent(tile.mesh, pivot);
    pivot.setRotationFromAxisAngle(axis, angle);
    q.group.updateMatrixWorld(true);
    for (const tile of selected) reparent(tile.mesh, q.group);
    pivot.rotation.set(0, 0, 0);
    return selected.length;
  };
  const b = getCenters();
  const nLayer = apply('U', 1);
  apply('U', -1);
  let rt = 0;
  const a = getCenters();
  for (let i = 0; i < b.length; i++) rt = Math.max(rt, b[i].distanceTo(a[i]));

  // Face counts must match on every face
  const faceOk = q['faces'].every((f) => q.stickersOnFace(f.id).length === expected);

  const L = Math.max(1, Math.floor(N / 2));
  let multiOk = vv.depths === L && vv.bandsDisjoint;
  const bandLens = [];
  for (let d = 0; d < L; d++) {
    const sel = q['selectLayer']({ kind: 'face', face: 'U', steps: 1, ...(d ? { depth: d } : {}) });
    bandLens.push(sel.length);
    if (sel.length === 0 || !vv.bandClosed[d] || !vv.bandFiveClosed[d]) multiOk = false;
    // Round-trip each depth band
    const b0 = getCenters();
    apply('U', 1, d || 0);
    apply('U', -1, d || 0);
    const a0 = getCenters();
    let dRt = 0;
    for (let i = 0; i < b0.length; i++) dRt = Math.max(dRt, b0[i].distanceTo(a0[i]));
    if (dRt >= 0.05) multiOk = false;
    // Five turns restore
    const b5 = getCenters();
    for (let i = 0; i < 5; i++) apply('U', 1, d || 0);
    const a5 = getCenters();
    let d5 = 0;
    for (let i = 0; i < b5.length; i++) d5 = Math.max(d5, b5[i].distanceTo(a5[i]));
    if (d5 >= 0.05) multiOk = false;
  }
  // Coverage after inner turn (N≥4)
  let coverOk = true;
  if (L > 1) {
    q.reset();
    apply('U', 1, 1);
    coverOk = q['faces'].every((f) => q.stickersOnFace(f.id).length === expected);
    q.reset();
  }

  const ok =
    vv.order === N &&
    vv.perFace === expected &&
    faceOk &&
    vv.perFace > 0 &&
    nLayer === layer.length &&
    layer.length > 0 &&
    vv.layerClosed &&
    vv.fiveTurnClosed &&
    vv.pieceGraphOk &&
    rt < 0.05 &&
    multiOk &&
    coverOk;
  console.log('smokeMega', N, {
    perFace: vv.perFace,
    expected,
    layer: layer.length,
    depths: vv.depths,
    bandCounts: vv.bandCounts,
    bandClosed: vv.bandClosed,
    bandsDisjoint: vv.bandsDisjoint,
    centers: vv.centers,
    edges: vv.edges,
    corners: vv.corners,
    rings: vv.rings,
    pieceGraphOk: vv.pieceGraphOk,
    faceOk,
    multiOk,
    coverOk,
    rt,
    ok,
  });
  return ok;
}


// --- Parallel lattice (N≥4): N stickers/edge; N=4 ★ void (no center); N≥5 filled center ---
function assertParallelCuts(N) {
  const q = new Megaminx(N, 'sticker');
  q.group.updateMatrixWorld(true);
  const expected = q.expectedPerFace();
  let facesOk = 0;
  const v = new THREE.Vector3();

  for (const face of q['faces']) {
    const axis = face.axis.clone().normalize();
    const onFace = q.stickersOnFace(face.id);
    if (onFace.length !== expected) {
      console.error('parallelCut', N, face.id, 'bad perFace', onFace.length, 'expected', expected);
      return false;
    }
    const centers = onFace.filter((t) => t.kind === 'center');
    const corners = onFace.filter((t) => t.kind === 'corner');
    const edges = onFace.filter((t) => t.kind === 'edge');
    const rings = onFace.filter((t) => t.kind === 'ring');
    // N=4: ★ void → no center sticker. N≥5: filled center.
    const expectCenters = N === 4 ? 0 : 1;
    if (centers.length !== expectCenters) {
      console.error('parallelCut', N, face.id, 'bad center count', {
        centers: centers.length,
        expect: expectCenters,
      });
      return false;
    }
    if (corners.length !== 5) {
      console.error('parallelCut', N, face.id, 'need 5 corners', { corners: corners.length });
      return false;
    }
    if (edges.length !== 5 * (N - 2)) {
      console.error('parallelCut', N, face.id, 'need mid-edges', {
        edges: edges.length,
        expect: 5 * (N - 2),
      });
      return false;
    }
    if (centers.length + corners.length + edges.length + rings.length !== expected) {
      console.error('parallelCut', N, face.id, 'kind sum mismatch', {
        centers: centers.length,
        corners: corners.length,
        edges: edges.length,
        rings: rings.length,
        expected,
      });
      return false;
    }

    // Reconstruct outer pentagon from corner farthest verts; check N stickers along each edge.
    const faceC = new THREE.Vector3();
    for (const t of onFace) faceC.add(q['tileWorldCenter'](t));
    faceC.multiplyScalar(1 / onFace.length);
    const ref = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const xAxis = new THREE.Vector3().crossVectors(axis, ref).normalize();
    const yAxis = new THREE.Vector3().crossVectors(axis, xAxis).normalize();
    const angOf = (p) => {
      const radial = p.clone().sub(faceC);
      radial.addScaledVector(axis, -radial.dot(axis));
      return {
        r: radial.length(),
        ang: Math.atan2(radial.dot(yAxis), radial.dot(xAxis)),
        p: p.clone(),
      };
    };

    const outerVerts = [];
    for (const t of corners) {
      const attr = t.mesh.geometry.getAttribute('position');
      let best = null;
      let bestR = -1;
      for (let i = 0; i < attr.count; i++) {
        v.fromBufferAttribute(attr, i).applyMatrix4(t.mesh.matrixWorld);
        const a = angOf(v);
        if (a.r > bestR) {
          bestR = a.r;
          best = a;
        }
      }
      outerVerts.push(best);
    }
    outerVerts.sort((a, b) => a.ang - b.ang);

    // Stickers that own a positive-length segment of the outer edge (not tip-only).
    const EDGE_TOL = 0.08;
    const MIN_SPAN = 0.02; // fraction of edge length
    for (let ei = 0; ei < 5; ei++) {
      const a = outerVerts[ei].p;
      const b = outerVerts[(ei + 1) % 5].p;
      const ab = b.clone().sub(a);
      const abLenSq = ab.lengthSq();
      const uniq = new Map();
      for (const t of onFace) {
        const attr = t.mesh.geometry.getAttribute('position');
        const us = [];
        for (let i = 0; i < attr.count; i++) {
          v.fromBufferAttribute(attr, i).applyMatrix4(t.mesh.matrixWorld);
          const ap2 = v.clone().sub(a);
          const u2 = ap2.dot(ab) / abLenSq;
          const uClamped = Math.max(0, Math.min(1, u2));
          const proj2 = a.clone().addScaledVector(ab, uClamped);
          if (v.distanceTo(proj2) < EDGE_TOL && u2 > -0.05 && u2 < 1.05) us.push(uClamped);
        }
        if (us.length < 2) continue;
        us.sort((x, y) => x - y);
        const span = us[us.length - 1] - us[0];
        if (span < MIN_SPAN) continue; // tip-only contact (e.g. ring touching midpoint)
        uniq.set(t.pieceId, t.kind);
      }
      if (uniq.size !== N) {
        console.error('parallelCut', N, face.id, 'edge', ei, {
          stickersOnEdge: uniq.size,
          expect: N,
          kinds: [...uniq.values()],
        });
        return false;
      }
    }

    if (N === 4) {
      // ★ void: no sticker near face center; no overlay mesh.
      if (q.debugStarOverlays().length !== 0) {
        console.error('parallelCut', N, face.id, 'unexpected ★ overlay mesh');
        return false;
      }
      for (const t of onFace) {
        const pos = q['tileWorldCenter'](t);
        const radial = pos.clone().sub(faceC);
        radial.addScaledVector(axis, -radial.dot(axis));
        if (radial.length() < 0.25) {
          console.error('parallelCut', N, face.id, 'sticker in ★ void core', t.kind, radial.length());
          return false;
        }
      }
    } else {
      // Center sticker should sit near face center (filled, not a star void).
      const cenTile = centers[0];
      const cenPos = q['tileWorldCenter'](cenTile);
      const radial = cenPos.clone().sub(faceC);
      radial.addScaledVector(axis, -radial.dot(axis));
      if (radial.length() > 0.35) {
        console.error('parallelCut', N, face.id, 'center too far from face center', radial.length());
        return false;
      }
    }
    facesOk++;
  }
  const ok = facesOk === 12;
  console.log('parallelCut', N, { facesOk, expected, ok });
  return ok;
}
// --- N=4 ★ void: tips → edge midpoints AND tips reach outer edges (挨到棱);
// no overlay mesh; no center sticker. Lattice outer cuts checked by parallelCut(4).
function assertEvenStarOrientation(N) {
  const q = new Megaminx(N, 'sticker');
  q.group.updateMatrixWorld(true);
  const overlays = q.debugStarOverlays();
  if (overlays.length !== 0) {
    console.error('starOrient', N, 'overlay count', overlays.length, 'expected 0 (★ is a void)');
    return false;
  }
  const voids = q.debugStarVoids();
  if (voids.length !== 12) {
    console.error('starOrient', N, 'void count', voids.length, 'expected 12');
    return false;
  }
  let facesOk = 0;
  const v = new THREE.Vector3();
  for (const face of q['faces']) {
    const axis = face.axis.clone().normalize();
    const onFace = q.stickersOnFace(face.id);
    const centers = onFace.filter((t) => t.kind === 'center');
    if (centers.length !== 0) {
      console.error('starOrient', N, face.id, 'N=4 must have no center sticker', centers.length);
      return false;
    }
    if (onFace.length !== q.expectedPerFace()) {
      console.error('starOrient', N, face.id, 'perFace', onFace.length, 'expected', q.expectedPerFace());
      return false;
    }
    const faceC = new THREE.Vector3();
    for (const t of onFace) faceC.add(q['tileWorldCenter'](t));
    faceC.multiplyScalar(1 / onFace.length);

    const ref = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const xAxis = new THREE.Vector3().crossVectors(axis, ref).normalize();
    const yAxis = new THREE.Vector3().crossVectors(axis, xAxis).normalize();

    const angOf = (p) => {
      const radial = p.clone().sub(faceC);
      radial.addScaledVector(axis, -radial.dot(axis));
      return {
        r: radial.length(),
        ang: Math.atan2(radial.dot(yAxis), radial.dot(xAxis)),
        p: p.clone(),
      };
    };
    const angDist = (a, b) => {
      let d = Math.abs(a - b) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      return d;
    };

    // Outer pentagon from corner stickers (lattice — unchanged by ★ void).
    const corners = onFace.filter((t) => t.kind === 'corner');
    if (corners.length !== 5) {
      console.error('starOrient', N, face.id, 'need 5 corners', corners.length);
      return false;
    }
    const outerVerts = [];
    for (const t of corners) {
      const attr = t.mesh.geometry.getAttribute('position');
      let best = null;
      let bestR = -1;
      for (let i = 0; i < attr.count; i++) {
        v.fromBufferAttribute(attr, i).applyMatrix4(t.mesh.matrixWorld);
        const a = angOf(v);
        if (a.r > bestR) {
          bestR = a.r;
          best = a;
        }
      }
      outerVerts.push(best);
    }
    outerVerts.sort((a, b) => a.ang - b.ang);
    const vertexAngs = outerVerts.map((o) => o.ang);
    const midAngs = vertexAngs.map((a, i) => {
      let b = vertexAngs[(i + 1) % 5];
      if (b < a) b += Math.PI * 2;
      let m = (a + b) / 2;
      if (m > Math.PI) m -= Math.PI * 2;
      if (m <= -Math.PI) m += Math.PI * 2;
      return m;
    });
    const edgeMids = outerVerts.map((a, i) => {
      const b = outerVerts[(i + 1) % 5];
      return a.p.clone().lerp(b.p, 0.5);
    });

    const star = voids.find((s) => s.faceId === face.id);
    if (!star || !star.tips || star.tips.length !== 5 || !star.dents || star.dents.length !== 5) {
      console.error('starOrient', N, face.id, 'missing tip/dent void data');
      return false;
    }
    const tips = star.tips.map((arr) => angOf(new THREE.Vector3().fromArray(arr)));
    const dentSamples = star.dents.map((arr) => angOf(new THREE.Vector3().fromArray(arr)));

    // Match each tip to nearest edge midpoint (by distance).
    const geoTips = [];
    for (let ei = 0; ei < 5; ei++) {
      const mid = edgeMids[ei];
      let best = null;
      let bestD = Infinity;
      for (const t of tips) {
        const d = t.p.distanceTo(mid);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      if (!best) {
        console.error('starOrient', N, face.id, 'no tip near mid', ei);
        return false;
      }
      geoTips.push(best);
    }

    let alignMid = 0;
    for (const t of geoTips) {
      const dMid = Math.min(...midAngs.map((m) => angDist(t.ang, m)));
      const dVert = Math.min(...vertexAngs.map((m) => angDist(t.ang, m)));
      if (dMid < dVert) alignMid++;
    }
    if (alignMid < 5) {
      console.error('starOrient', N, face.id, {
        alignMid,
        tipAngs: geoTips.map((t) => +t.ang.toFixed(3)),
        note: 'star tips must aim at edge midpoints',
      });
      return false;
    }

    const TIP_EDGE_TOL = 0.08;
    for (let i = 0; i < 5; i++) {
      const tip = geoTips[i];
      let bestEdge = 0;
      let bestD = Infinity;
      for (let e = 0; e < 5; e++) {
        const d = angDist(tip.ang, midAngs[e]);
        if (d < bestD) {
          bestD = d;
          bestEdge = e;
        }
      }
      const a = outerVerts[bestEdge].p;
      const b = outerVerts[(bestEdge + 1) % 5].p;
      const ab = b.clone().sub(a);
      const ap = tip.p.clone().sub(a);
      const u = Math.max(0, Math.min(1, ap.dot(ab) / ab.lengthSq()));
      const proj = a.clone().addScaledVector(ab, u);
      const dist = tip.p.distanceTo(proj);
      if (dist > TIP_EDGE_TOL) {
        console.error('starOrient', N, face.id, {
          tipEdgeDist: +dist.toFixed(4),
          tipR: +tip.r.toFixed(4),
          tol: TIP_EDGE_TOL,
          note: 'star tips must reach outer edges (挨到棱)',
        });
        return false;
      }
    }

    const dentR = Math.max(...dentSamples.map((d) => d.r));
    const tipR = Math.min(...geoTips.map((t) => t.r));
    if (!(dentR < tipR) || !(tipR > dentR * 2.0)) {
      console.error('starOrient', N, face.id, {
        tipR: +tipR.toFixed(4),
        dentR: +dentR.toFixed(4),
        ratio: +(tipR / dentR).toFixed(3),
        note: 'dent radius must be < tip radius (sharper ★; 内角往中心缩)',
      });
      return false;
    }
    facesOk++;
  }
  const ok = facesOk === 12;
  console.log('starOrient', N, {
    facesOk,
    ok,
    overlays: overlays.length,
    voids: voids.length,
    expected: q.expectedPerFace(),
  });
  return ok;
}

const starOrient4 = assertEvenStarOrientation(4);
const parallelCut4 = assertParallelCuts(4);
const parallelCut5 = assertParallelCuts(5);
const parallelCut6 = assertParallelCuts(6);
const parallelCut7 = assertParallelCuts(7);

// --- Multi-slice depth bands (N≥4): thin lattice-step slabs, closed orbits ---
const FACE_LAYER_THRESH = 2.17;
function assertMultiDepth(N) {
  const q = new Megaminx(N, 'sticker');
  const vv = q.debugVerifyLayers();
  const L = Math.max(1, Math.floor(N / 2));
  const expected = q.expectedPerFace();
  if (vv.depths !== L) {
    console.error('multiDepth', N, 'depths', vv.depths, 'expected', L);
    return false;
  }
  if (!vv.bandsDisjoint) {
    console.error('multiDepth', N, 'bands overlap');
    return false;
  }
  // Thin lattice-step slabs: thresh[0]=FACE_LAYER_THRESH; depth k≥1 is a narrow
  // ring just inside the outer cut (NOT equal split of [0, thresh] to equator).
  const thresh = q.debugThresholds();
  if (thresh.length !== L) {
    console.error('multiDepth', N, 'thresh length', thresh.length, 'expected', L);
    return false;
  }
  if (Math.abs(thresh[0] - FACE_LAYER_THRESH) > 1e-9) {
    console.error('multiDepth', N, 'thresh[0]', thresh[0], 'expected', FACE_LAYER_THRESH);
    return false;
  }
  // Inner lower bounds must be strictly decreasing and well above the equator
  // (thin rings — old equal-width put thresh[L-1]=0 and grabbed half the puzzle).
  for (let k = 1; k < L; k++) {
    if (!(thresh[k] < thresh[k - 1] - 0.05)) {
      console.error('multiDepth', N, 'thresh not decreasing', thresh);
      return false;
    }
  }
  if (L > 1 && thresh[L - 1] < 0.5) {
    console.error('multiDepth', N, 'deepest thresh too low (wide belt?)', thresh[L - 1]);
    return false;
  }
  // Band width of depth 1 must be a thin lattice step, not ≈FACE_LAYER_THRESH.
  if (L > 1) {
    const band1Width = thresh[0] - thresh[1];
    if (band1Width > FACE_LAYER_THRESH * 0.55) {
      console.error('multiDepth', N, 'depth-1 band too wide', band1Width, thresh);
      return false;
    }
  }
  for (let d = 0; d < L; d++) {
    if (!vv.bandCounts[d] || !vv.bandClosed[d] || !vv.bandFiveClosed[d]) {
      console.error('multiDepth', N, 'band', d, {
        count: vv.bandCounts[d],
        closed: vv.bandClosed[d],
        five: vv.bandFiveClosed[d],
      });
      return false;
    }
  }
  // Buttons: U / 2U / 3U … (Master Kilominx / 4×4 style)
  const buttons = q.getFaceButtons();
  if (buttons.length !== L * 12) {
    console.error('multiDepth', N, 'buttons', buttons.length, 'expected', L * 12);
    return false;
  }
  const uOuter = buttons.find((b) => b.id === 'U' && !b.depth);
  const uInner = L > 1 ? buttons.find((b) => b.id === 'U' && b.depth === 1) : null;
  if (!uOuter || uOuter.label !== 'U') {
    console.error('multiDepth', N, 'outer U button', uOuter);
    return false;
  }
  if (L > 1 && (!uInner || uInner.label !== '2U')) {
    console.error('multiDepth', N, 'inner 2U button', uInner);
    return false;
  }

  const apply = (face, steps, depth) => {
    const move = { kind: 'face', face, steps, ...(depth ? { depth } : {}) };
    const selected = q['selectLayer'](move);
    const axis = q['faceOf'](face).axis;
    const angle = q['turnAngle'](move);
    const pivot = q['pivot'];
    pivot.rotation.set(0, 0, 0);
    for (const tile of selected) reparent(tile.mesh, pivot);
    pivot.setRotationFromAxisAngle(axis, angle);
    q.group.updateMatrixWorld(true);
    for (const tile of selected) reparent(tile.mesh, q.group);
    pivot.rotation.set(0, 0, 0);
    return selected.length;
  };

  if (L > 1) {
    q.reset();
    const n1 = apply('U', 1, 1);
    if (n1 !== vv.bandCounts[1]) {
      console.error('multiDepth', N, 'inner select size', n1, vv.bandCounts[1]);
      return false;
    }
    // After one inner turn, U face sticker count still full (outer untouched)
    if (q.stickersOnFace('U').length !== expected) {
      console.error('multiDepth', N, 'U face count after 2U', q.stickersOnFace('U').length);
      return false;
    }
    // Five × 72° inner turns restore solved face coverage
    q.reset();
    for (let i = 0; i < 5; i++) apply('U', 1, 1);
    const faceOk5 = q['faces'].every((f) => q.stickersOnFace(f.id).length === expected);
    if (!faceOk5) {
      console.error('multiDepth', N, 'coverage after 5×2U');
      return false;
    }
    // Round-trip
    q.reset();
    apply('U', 1, 1);
    apply('U', -1, 1);
    const faceOk = q['faces'].every((f) => q.stickersOnFace(f.id).length === expected);
    if (!faceOk) {
      console.error('multiDepth', N, 'coverage after inner round-trip');
      return false;
    }
    // Outer and inner must select different piece sets
    const outer = new Set(q['selectLayer']({ kind: 'face', face: 'U', steps: 1 }).map((t) => t.pieceId));
    const inner = new Set(
      q['selectLayer']({ kind: 'face', face: 'U', steps: 1, depth: 1 }).map((t) => t.pieceId),
    );
    let overlap = 0;
    for (const id of outer) if (inner.has(id)) overlap++;
    if (overlap !== 0) {
      console.error('multiDepth', N, 'outer/inner piece overlap', overlap);
      return false;
    }
    // Thin ring: outer covers on-face stickers; inner is non-empty, no on-face stickers,
    // and much smaller than the old half-puzzle belt (which was ~100 tiles for N=4).
    if (vv.bandCounts[0] < expected) {
      console.error('multiDepth', N, 'outer too small', vv.bandCounts[0], expected);
      return false;
    }
    if (vv.bandCounts[1] < 15) {
      console.error('multiDepth', N, 'inner belt empty/tiny', vv.bandCounts[1]);
      return false;
    }
    // Inner must be a thin ring: fewer tiles than outer (N=4 was wrongly ~100 vs 40).
    if (vv.bandCounts[1] >= vv.bandCounts[0] * 1.5) {
      console.error('multiDepth', N, 'inner not thin vs outer', vv.bandCounts);
      return false;
    }
    const innerTiles = q['selectLayer']({ kind: 'face', face: 'U', steps: 1, depth: 1 });
    const axis = q['faceOf']('U').axis;
    let onU = 0;
    for (const t of innerTiles) {
      if (q['tileWorldCenter'](t).dot(axis) > FACE_LAYER_THRESH) onU++;
    }
    if (onU !== 0) {
      console.error('multiDepth', N, 'inner selects U-face stickers', onU);
      return false;
    }
    // After one 2U: outer U-face piece ids unchanged AND zero positional drift
    q.reset();
    const beforeIds = q.stickersOnFace('U').map((t) => t.pieceId).sort().join(',');
    const uTiles = q.stickersOnFace('U');
    const snap = uTiles.map((t) => ({ mesh: t.mesh, c: q['tileWorldCenter'](t).clone() }));
    apply('U', 1, 1);
    const afterIds = q.stickersOnFace('U').map((t) => t.pieceId).sort().join(',');
    if (beforeIds !== afterIds) {
      console.error('multiDepth', N, '2U moved outer U-face piece set');
      return false;
    }
    let outerDrift = 0;
    for (const s of snap) {
      const c = new THREE.Vector3();
      const attr = s.mesh.geometry.getAttribute('position');
      for (let i = 0; i < attr.count; i++) c.add(new THREE.Vector3().fromBufferAttribute(attr, i));
      c.multiplyScalar(1 / attr.count).applyMatrix4(s.mesh.matrixWorld);
      outerDrift = Math.max(outerDrift, s.c.distanceTo(c));
    }
    if (outerDrift > 1e-6) {
      console.error('multiDepth', N, '2U drifted outer-face stickers', outerDrift);
      return false;
    }
    q.reset();

    // Log R vs 2R piece/tile counts (Master Kilominx red-line ring check)
    const rTiles = q['selectLayer']({ kind: 'face', face: 'R', steps: 1 });
    const r2Tiles = q['selectLayer']({ kind: 'face', face: 'R', steps: 1, depth: 1 });
    const rPieces = new Set(rTiles.map((t) => t.pieceId)).size;
    const r2Pieces = new Set(r2Tiles.map((t) => t.pieceId)).size;
    console.log('layerCounts', N, {
      R: { tiles: rTiles.length, pieces: rPieces },
      '2R': { tiles: r2Tiles.length, pieces: r2Pieces },
      thresh: thresh.map((t) => +t.toFixed(4)),
    });
    // N=4: thin 2R ring ≈ 20 tiles / 15 pieces (not ~100 tiles)
    if (N === 4) {
      if (rTiles.length !== 40 || rPieces !== 20) {
        console.error('multiDepth', N, 'R counts', rTiles.length, rPieces);
        return false;
      }
      if (r2Tiles.length !== 20 || r2Pieces !== 15) {
        console.error('multiDepth', N, '2R thin ring counts', r2Tiles.length, r2Pieces);
        return false;
      }
    }
    if (N === 5) {
      if (r2Tiles.length !== 25 || r2Pieces !== 20) {
        console.error('multiDepth', N, '2R Gigaminx counts', r2Tiles.length, r2Pieces);
        return false;
      }
    }
  }
  console.log('multiDepth', N, {
    L,
    bandCounts: vv.bandCounts,
    thresh: thresh.map((t) => +t.toFixed(4)),
    buttons: buttons.length,
    labels: ['U', ...(L > 1 ? ['2U'] : []), ...(L > 2 ? ['3U'] : [])],
    ok: true,
  });
  return true;
}
const multiDepth4 = assertMultiDepth(4);
const multiDepth5 = assertMultiDepth(5);
const multiDepth6 = assertMultiDepth(6);

const smokeMega2 = smokeMegaOrder(2);
const smokeMega4 = smokeMegaOrder(4);
const smokeMega5 = smokeMegaOrder(5);
const smokeMega6 = smokeMegaOrder(6);
const smokeMega7 = smokeMegaOrder(7);

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
  staleTrapOk &&
  dragScoringOk &&
  smokeMega2 &&
  smokeMega4 &&
  smokeMega5 &&
  smokeMega6 &&
  smokeMega7 &&
  starOrient4 &&
  parallelCut4 &&
  parallelCut5 &&
  parallelCut6 &&
  parallelCut7 &&
  multiDepth4 &&
  multiDepth5 &&
  multiDepth6;

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
  dragScoringOk,
  starOrient4,
  parallelCut4,
  parallelCut5,
  parallelCut6,
  parallelCut7,
  multiDepth4,
  multiDepth5,
  multiDepth6,
});
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
