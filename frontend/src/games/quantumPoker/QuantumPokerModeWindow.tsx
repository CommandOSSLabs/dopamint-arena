import { useState } from "react";
import type { GameWindowProps } from "../types";
import { QuantumPokerPvpWindow } from "./QuantumPokerPvpWindow";
import { ArenaPokerTile } from "./ArenaPokerTile";

// Quantum Poker: PvP-only, with an arena "Play vs Bot" entry (ADR-0028) alongside the live PvP
// lane. The arena tile runs the one-signature flow (fleet pre-creates + funds seat B, user deposits
// seat A in one batched PTB); the PvP window is the matchmaking lane (two real wallets). Back
// settles this hand and closes the window.
export function QuantumPokerModeWindow(props: GameWindowProps) {
  // Pick the lane at the window level: "arena" (vs the co-located fleet bot) or "pvp" (matchmaking).
  // Default to arena so the one-signature flow is the front door; the lobby's Back returns to pvp.
  const [lane, setLane] = useState<"arena" | "pvp">("arena");
  if (lane === "arena") {
    return (
      <ArenaPokerTile
        onClose={() => {
          props.onClose();
        }}
      />
    );
  }
  return <QuantumPokerPvpWindow {...props} onExit={props.onClose} />;
}
