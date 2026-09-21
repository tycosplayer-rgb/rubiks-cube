export type Axis = 'x' | 'y' | 'z';

/** One layer turn: axis, layer index 0..N-1, quarter-turns (1|2|3), where +1 = CCW in Three.js right-hand sense */
export interface LayerMove {
  axis: Axis;
  layer: number;
  /** +1 | +2 | +3  (Three.js positive = right-hand rule) */
  turns: 1 | 2 | 3;
}

export interface MoveRecord extends LayerMove {
  notation: string;
}
