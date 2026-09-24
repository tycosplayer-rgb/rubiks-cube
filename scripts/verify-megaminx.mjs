/**
 * Headless Megaminx star-cut / layer checks (no WebGL).
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
  const apply = (face, steps) => {
    const move = { kind: 'face', face, steps };
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
    rt < 0.05;
  console.log('smokeMega', N, {
    perFace: vv.perFace,
    expected,
    layer: layer.length,
    centers: vv.centers,
    edges: vv.edges,
    corners: vv.corners,
    rings: vv.rings,
    pieceGraphOk: vv.pieceGraphOk,
    faceOk,
    rt,
    ok,
  });
  return ok;
}

// --- Even-N star: tips → edge midpoints AND tips reach outer edges (挨到棱) ---
function assertEvenStarOrientation(N) {
  const q = new Megaminx(N, 'sticker');
  q.group.updateMatrixWorld(true);
  let facesOk = 0;
  const v = new THREE.Vector3();
  for (const face of q['faces']) {
    const axis = face.axis.clone().normalize();
    const onFace = q.stickersOnFace(face.id);
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

    const corners = onFace.filter((t) => t.kind === 'corner');
    const rings = onFace.filter((t) => t.kind === 'ring');
    const edges = onFace.filter((t) => t.kind === 'edge');
    if (corners.length !== 5 || rings.length < 5) {
      console.error('starOrient', N, face.id, 'bad counts', {
        corners: corners.length,
        rings: rings.length,
      });
      return false;
    }

    // Outer pentagon vertices = farthest vert of each corner sticker.
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

    // Tips = sticker verts closest to each outer-edge midpoint (ring+edge).
    // When STAR_TIP_SCALE=1, tips lie on the edge; max-r would wrongly pick
    // near-vertex edge samples (larger radius than the apothem).
    const allSamples = [];
    for (const t of [...rings, ...edges]) {
      const attr = t.mesh.geometry.getAttribute('position');
      for (let i = 0; i < attr.count; i++) {
        v.fromBufferAttribute(attr, i).applyMatrix4(t.mesh.matrixWorld);
        allSamples.push(angOf(v));
      }
    }
    const tips = [];
    for (let ei = 0; ei < 5; ei++) {
      const mid = edgeMids[ei];
      let best = null;
      let bestD = Infinity;
      for (const s of allSamples) {
        const d = s.p.distanceTo(mid);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (!best) {
        console.error('starOrient', N, face.id, 'no tip near mid', ei);
        return false;
      }
      tips.push(best);
    }

    let alignMid = 0;
    for (const t of tips) {
      const dMid = Math.min(...midAngs.map((m) => angDist(t.ang, m)));
      const dVert = Math.min(...vertexAngs.map((m) => angDist(t.ang, m)));
      if (dMid < dVert) alignMid++;
    }
    if (alignMid < 5) {
      console.error('starOrient', N, face.id, {
        alignMid,
        tipAngs: tips.map((t) => +t.ang.toFixed(3)),
        midAngs: midAngs.map((a) => +a.toFixed(3)),
        vertexAngs: vertexAngs.map((a) => +a.toFixed(3)),
        note: 'star tips must aim at edge midpoints',
      });
      return false;
    }

    // Tip reach (挨到棱): each tip near the corresponding outer edge segment.
    // Tolerance allows STICKER_SHRINK inset (~0.01–0.05 of face size).
    const TIP_EDGE_TOL = 0.08;
    for (let i = 0; i < 5; i++) {
      const tip = tips[i];
      // Match tip to nearest edge by angle
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
          midR: +angOf(edgeMids[bestEdge]).r.toFixed(4),
          tol: TIP_EDGE_TOL,
          note: 'star tips must reach outer edges (挨到棱)',
        });
        return false;
      }
    }

    // Dent radius (内角) must sit well inside tip radius (外角) — sharper ★.
    const dentR = Math.max(
      ...corners.map((t) => {
        const attr = t.mesh.geometry.getAttribute('position');
        let minR = Infinity;
        for (let i = 0; i < attr.count; i++) {
          v.fromBufferAttribute(attr, i).applyMatrix4(t.mesh.matrixWorld);
          minR = Math.min(minR, angOf(v).r);
        }
        return minR;
      }),
    );
    const tipR = Math.min(...tips.map((t) => t.r));
    // tip≈apothem≈0.809 R_v; dent≈STAR_DENT_SCALE·R_v (~0.20) → ratio ≳ 3.
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
  console.log('starOrient', N, { facesOk, ok });
  return ok;
}
const starOrient4 = assertEvenStarOrientation(4);
const starOrient6 = assertEvenStarOrientation(6);

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
  starOrient6;

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
  starOrient6,
});
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
