export type MachinePhase =
  | "spawning"
  | "running"
  | "settling"
  | "closed"
  | "error";

export type NftTier = "common" | "rare" | "epic" | "unknown";

export type MachineSessionView = {
  id: string;
  label: string;
  phase: MachinePhase;
  error?: string | null;
  tickCount: number;
  tickMax: number;
  tps: number;
  tier: NftTier;
};
