import type { Party } from "sui-tunnel-ts/protocol/Protocol";

/** One pixel placement, for the activity feed. */
export interface PlacementEvent {
  x: number;
  y: number;
  color: number; // palette index 1..16
  by: Party;
  t: number; // ms timestamp
}
