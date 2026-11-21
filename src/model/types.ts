import type { BoxParams, RoomParams, ShadeParams } from './generators';

export type RoomPiece = 'floor' | 'roof' | 'walls' | 'glazing';

/** How a generated part was made, so it can be regenerated when parameters change. */
export type GenInfo =
  | { kind: 'box'; params: BoxParams }
  | { kind: 'room'; group: number; piece: RoomPiece; params: RoomParams }
  | { kind: 'shade'; sourceId: number; params: ShadeParams };
