import type { GameWindowProps } from "../../../types";
import { RefObject, useRef, useState } from "react";
import { MatchInfo, MpClient, PvpChannel } from "@/pvp/mpClient";

import { PaymentsFinding } from "../PaymentsFinding";
import PaymentsChallenge from "../PaymentsChallenge";
import { KeyPair } from "sui-tunnel-ts/core";

export interface PaymentsTunnelState {
  tunnelId: string;
  channel: PvpChannel;
  ephemeral: KeyPair;
  created_at: number;
  totalBalance: bigint;

  initialBalances: {
    a: bigint;
    b: bigint;
  };
  initialAddress: {
    a: string;
    b: string;
  };

  coinType: string; // something like: "0x2::sui::SUI"
}

/**
 * Reference game stub. To add a game: copy this folder, rename it, swap this
 * content for your game UI, and call register() in index.ts. The `_props`
 * (windowId, onClose) are how a real game would settle and close itself.
 */
export function PaymentsWindow(_props: GameWindowProps) {
  const [tunnel, setTunnel] = useState<PaymentsTunnelState | null>(null);

  const mpClientRef = useRef<MpClient>(null);

  return (
    <>
      {tunnel ? (
        <PaymentsChallenge
          tunnel={tunnel}
          mpClientRef={mpClientRef as RefObject<MpClient>}
          setTunnel={setTunnel}
        />
      ) : (
        <PaymentsFinding mpClientRef={mpClientRef} setTunnel={setTunnel} />
      )}
    </>
  );
}
