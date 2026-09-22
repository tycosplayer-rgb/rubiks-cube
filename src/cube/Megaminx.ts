import * as THREE from 'three';
import { PolyPuzzle, type PolyTile } from './PolyPuzzle';
import type { FaceTurnMove, VisualStyle } from './puzzle';

const COLORS = [
  0xf5f5f5, 0xc41e3a, 0x1646c4, 0xffd500, 0x7b2cbf, 0x009e60,
  0xff8c00, 0x69d2e7, 0xff69b4, 0x8b4513, 0x9acd32, 0x808080,
];
const CSS = COLORS.map((c) => `#${c.toString(16).padStart(6, '0')}`);
const IDS = ['U', 'R', 'FR', 'DR', 'D', 'DL', 'L', 'FL', 'BR', 'B', 'BL', 'DB'];

/** Center pentagon radius as fraction of outer vertex distance from face center. */
const INNER_SCALE = 0.40;
/** Corner tip depth along each outer edge (fraction of edge length from the vertex). */
const CORNER_EDGE_T = 0.32;
const STICKER_SHRINK = 0.97;
const KEY_DECIMALS = 4;

interface FoundFace {
  normal: THREE.Vector3;
  points: THREE.Vector3[];
}

interface MegaTile extends PolyTile {
  pieceId: string;
  kind: 'center' | 'edge' | 'corner';
  faceIndex: number;
}

function vertKey(p: THREE.Vector3): string {
  return `${p.x.toFixed(KEY_DECIMALS)},${p.y.toFixed(KEY_DECIMALS)},${p.z.toFixed(KEY_DECIMALS)}`;
}

function edgeKey(a: THREE.Vector3, b: THREE.Vector3): string {
  const ka = vertKey(a);
  const kb = vertKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/**
 * Dodecahedron Megaminx with classic star-cut faces:
 * each face = 1 center + 5 corners + 5 edges (11 stickers). Grooves read as 五角星.
 * Face turns are 72°; layer selection is piece-id based (C5-closed).
 */
export class Megaminx extends PolyPuzzle {
  readonly puzzleType = 'megaminx' as const;
  private readonly megaTiles: MegaTile[] = [];
  /** pieceIds that rotate with each face (center + 5 edges + 5 corners). */
  private readonly facePieces = new Map<string, Set<string>>();

  constructor(style: VisualStyle = 'sticker') {
    super(style);
    this.build();
    this.finishBuild();
  }

  private build(): void {
    const source = new THREE.DodecahedronGeometry(2.7, 0);
    const pos = source.getAttribute('position');
    const found: FoundFace[] = [];
    for (let i = 0; i < pos.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(pos, i);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1);
      const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
      const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
      if (n.dot(a) < 0) n.negate();
      let face = found.find((f) => f.normal.dot(n) > 0.999);
      if (!face) {
        face = { normal: n.clone(), points: [] };
        found.push(face);
      }
      for (const v of [a, b, c]) {
        if (!face.points.some((p) => p.distanceToSquared(v) < 1e-8)) face.points.push(v.clone());
      }
    }
    source.dispose();

    found.sort(
      (a, b) =>
        b.normal.y - a.normal.y ||
        Math.atan2(a.normal.z, a.normal.x) - Math.atan2(b.normal.z, b.normal.x),
    );
    this.faces = found.map((f, i) => ({
      id: IDS[i],
      label: IDS[i],
      axis: f.normal.clone().normalize(),
      color: COLORS[i],
      colorCss: CSS[i],
    }));

    this.core = new THREE.Mesh(
      new THREE.DodecahedronGeometry(2.58, 0),
      new THREE.MeshStandardMaterial({
        color: 0x3a3f4a,
        roughness: 0.78,
        metalness: 0.02,
        flatShading: true,
      }),
    );
    this.group.add(this.core);

    found.forEach((f, faceIndex) => {
      const faceId = IDS[faceIndex];
      const layer = new Set<string>();
      this.facePieces.set(faceId, layer);

      const center = f.points
        .reduce((sum, p) => sum.add(p), new THREE.Vector3())
        .multiplyScalar(1 / f.points.length);
      const normal = f.normal.clone().normalize();
      const u = f.points[0].clone().sub(center).normalize();
      const v = new THREE.Vector3().crossVectors(normal, u).normalize();

      // Canonical outer vertices (pre-offset) for stable piece keys across faces.
      const raw = [...f.points].sort((a, b) => {
        const aa = Math.atan2(a.clone().sub(center).dot(v), a.clone().sub(center).dot(u));
        const bb = Math.atan2(b.clone().sub(center).dot(v), b.clone().sub(center).dot(u));
        return aa - bb;
      });

      const points = raw.map((p) => p.clone().addScaledVector(normal, 0.045));
      const c = center.clone().addScaledVector(normal, 0.045);
      const inner = points.map((p) => c.clone().lerp(p, INNER_SCALE));

      const addPoly = (
        poly: THREE.Vector3[],
        pieceId: string,
        kind: MegaTile['kind'],
      ) => {
        const mid = poly.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / poly.length);
        const inset = poly.map((p) => mid.clone().lerp(p, STICKER_SHRINK));
        const verts: THREE.Vector3[] = [];
        for (let k = 1; k < inset.length - 1; k++) verts.push(inset[0], inset[k], inset[k + 1]);
        const geo = new THREE.BufferGeometry().setFromPoints(verts);
        this.addTile(geo, COLORS[faceIndex], faceId);
        const tile = this.tiles[this.tiles.length - 1] as MegaTile;
        tile.pieceId = pieceId;
        tile.kind = kind;
        tile.faceIndex = faceIndex;
        tile.mesh.userData.pieceId = pieceId;
        tile.mesh.userData.kind = kind;
        tile.mesh.userData.faceIndex = faceIndex;
        this.megaTiles.push(tile);
        layer.add(pieceId);
      };

      // 1 center (same orientation as outer face).
      const centerId = `center:${faceId}`;
      addPoly(inner, centerId, 'center');

      for (let i = 0; i < 5; i++) {
        const i1 = (i + 1) % 5;
        const i0 = (i + 4) % 5;
        const Vi = points[i];
        const Vprev = points[i0];
        const Vnext = points[i1];

        // Cut points along outer edges, measured from the corner vertex.
        const cutPrev = Vi.clone().lerp(Vprev, CORNER_EDGE_T);
        const cutNext = Vi.clone().lerp(Vnext, CORNER_EDGE_T);
        // Shared cut on edge i→i1 from the far vertex side for the edge quad.
        const cutNearI = Vi.clone().lerp(points[i1], CORNER_EDGE_T);
        const cutNearI1 = points[i1].clone().lerp(Vi, CORNER_EDGE_T);

        const cornerId = `corner:${vertKey(raw[i])}`;
        // Kite tip at outer vertex → reads as star point.
        addPoly([Vi, cutNext, inner[i], cutPrev], cornerId, 'corner');

        const eId = `edge:${edgeKey(raw[i], raw[i1])}`;
        // Quad along outer edge between the two corner cuts, against inner edge.
        addPoly([cutNearI, cutNearI1, inner[i1], inner[i]], eId, 'edge');
      }
    });
  }

  protected selectLayer(move: FaceTurnMove): PolyTile[] {
    this.group.updateMatrixWorld(true);
    const pieces = this.facePieces.get(move.face);
    if (!pieces) return [];
    // All stickers on pieces that belong to this face's layer (face + neighboring ring).
    return this.megaTiles.filter((t) => pieces.has(t.pieceId));
  }

  protected turnAngle(move: FaceTurnMove): number {
    return move.steps * ((Math.PI * 2) / 5);
  }

  protected scrambleLength(): number {
    return 24;
  }

  getFitDistance(): number {
    return 8.2;
  }

  getFloorY(): number {
    return -3.05;
  }

  /** Test helper: counts and C5 closure (no animation). */
  debugVerifyLayers(): {
    tiles: number;
    perFace: number;
    layerCount: number;
    centers: number;
    edges: number;
    corners: number;
    layerClosed: boolean;
    fiveTurnClosed: boolean;
  } {
    this.group.updateMatrixWorld(true);
    const faceId = this.faces[0].id;
    const axis = this.faces[0].axis;
    const selected = this.selectLayer({ kind: 'face', face: faceId, steps: 1 });
    const slots = this.tiles.map((t) => this.tileWorldCenter(t).clone());
    const q = new THREE.Quaternion().setFromAxisAngle(axis, (Math.PI * 2) / 5);
    const layerClosed = selected.every((t) => {
      const dest = this.tileWorldCenter(t).applyQuaternion(q);
      return slots.some((s) => s.distanceTo(dest) < 0.12);
    });
    let fiveTurnClosed = true;
    for (const t of selected) {
      const c = this.tileWorldCenter(t).clone();
      for (let i = 0; i < 5; i++) c.applyQuaternion(q);
      if (c.distanceTo(this.tileWorldCenter(t)) > 0.12) fiveTurnClosed = false;
    }
    const kinds = { center: 0, edge: 0, corner: 0 };
    for (const t of this.megaTiles) kinds[t.kind]++;
    // Stickers on the turned face itself should be 11.
    const onFace = this.megaTiles.filter((t) => t.mesh.userData.turnFace === faceId).length;
    return {
      tiles: this.tiles.length,
      perFace: onFace,
      layerCount: selected.length,
      centers: kinds.center,
      edges: kinds.edge,
      corners: kinds.corner,
      layerClosed,
      fiveTurnClosed,
    };
  }
}
