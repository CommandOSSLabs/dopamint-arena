import type { Settlement, StateUpdate } from "sui-tunnel-ts/core/wire";

export interface CoSignedUpdate {
  update: StateUpdate;
  sigA: Uint8Array;
  sigB: Uint8Array;
}

export interface CoSignedSettlement {
  settlement: Settlement;
  sigA: Uint8Array;
  sigB: Uint8Array;
}
