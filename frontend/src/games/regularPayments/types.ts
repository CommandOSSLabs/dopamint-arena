export type MachinePhase =
  | "spawning"
  | "running"
  | "settling"
  | "closed"
  | "error";

export type NftTier = "common" | "rare" | "epic" | "unknown";

export type NftReward = {
  title: string;
  description: string;
  imageUrl: string;
};

export type MachineSessionView = {
  id: string;
  label: string;
  phase: MachinePhase;
  error?: string | null;
  tickCount: number;
  tickMax: number;
  tps: number;
  tier: NftTier;
  reward: NftReward | null;
  digest: string | null;
};
