export type MachinePhase =
  | "spawning"
  | "running"
  | "settling"
  | "closed"
  | "error";

export type NftTier = "common" | "rare" | "epic" | "unknown";

export type MicroPaymentTick = {
  index: number;
  amount: number;
  at: number;
};

export type MachineSessionView = {
  id: string;
  label: string;
  phase: MachinePhase;
  error?: string | null;
  usageSpent: number;
  priceTarget: number;
  microUnit: number;
  tickCount: number;
  tps: number;
  tier: NftTier;
  history: MicroPaymentTick[];
};