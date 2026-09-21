/**
 * 标准魔方配色（Western / BOY 约定）
 * White↔Yellow, Red↔Orange, Blue↔Green
 * 默认朝向：U白 D黄 F绿 B蓝 R红 L橙
 */
export const FACE_COLORS = {
  U: 0xf5f5f5, // White
  D: 0xffd500, // Yellow
  F: 0x009e60, // Green
  B: 0x0051ba, // Blue
  R: 0xc41e3a, // Red
  L: 0xff5800, // Orange
  plastic: 0x1a1a1a,
} as const;

export type FaceId = 'U' | 'D' | 'F' | 'B' | 'R' | 'L';

/** Three.js BoxGeometry material index → face */
export const MAT_INDEX: Record<number, FaceId | 'plastic'> = {
  0: 'R', // +X
  1: 'L', // -X
  2: 'U', // +Y
  3: 'D', // -Y
  4: 'F', // +Z
  5: 'B', // -Z
};

export const FACE_AXIS: Record<FaceId, { axis: 'x' | 'y' | 'z'; sign: 1 | -1 }> = {
  R: { axis: 'x', sign: 1 },
  L: { axis: 'x', sign: -1 },
  U: { axis: 'y', sign: 1 },
  D: { axis: 'y', sign: -1 },
  F: { axis: 'z', sign: 1 },
  B: { axis: 'z', sign: -1 },
};

/** Hex string for UI swatches */
export const FACE_HEX: Record<FaceId, string> = {
  U: '#F5F5F5',
  D: '#FFD500',
  F: '#009E60',
  B: '#0051BA',
  R: '#C41E3A',
  L: '#FF5800',
};
