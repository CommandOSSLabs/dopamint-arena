/**
 * Interaction protocols (Deliverable 2). Each implements the generic `Protocol`
 * interface and is driven by the off-chain tunnel engine (core/tunnel.ts).
 */
export * from "./Protocol";
export * from "./payments";
export * from "./blackjack";
export * from "./ticTacToe";
export * from "./chat";
export * from "./quantumPoker";
export * from "./cross";
export * from "./multiGameCross";
export * from "./bombIt";
export * from "./multiGameBombIt";
export * from "./quantumPokerCodec";
export * from "./quantumPokerPersona";
// Pixel protocols: re-export each class + its own types so `protocols.Pixel*` works
// like the others. Their generic cell constants (EMPTY/OWNER_A/OWNER_B/NUM_COLORS/
// Winner) collide between the two, so import those from the specific file instead.
export { PixelPaintProtocol } from "./pixelPaint";
export type {
  PixelPaintState,
  PixelPaintMove,
  PixelPaintConfig,
  PixelPaintMode,
} from "./pixelPaint";
export { PixelDuelProtocol } from "./pixelDuel";
export type {
  PixelDuelState,
  PixelDuelMove,
  PixelDuelConfig,
  PixelDuelPhase,
} from "./pixelDuel";
