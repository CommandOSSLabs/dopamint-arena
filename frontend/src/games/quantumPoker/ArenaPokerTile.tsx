import { useCallback, useRef, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { enterArena, type ArenaAllocation } from "@/onchain/arenaEnter";
import { configureSharedBatcher } from "@/onchain/sharedTunnelOpenBatcher";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { isMtpsConfigured, MTPS_COIN_TYPE } from "@/onchain/mtps";
import type { PartyOnchain } from "@/onchain/tunnelTx";
import { usePvpQuantumPoker } from "./usePvpQuantumPoker";
import { POKER_BUYIN } from "./constants";
import { SketchDefs } from "../sketch";

type ArenaState =
  | { kind: "idle" }
  | { kind: "allocating" }
  | { kind: "depositing" }
  | { kind: "playing"; allocation: ArenaAllocation; eph: KeyPair }
  | { kind: "error"; message: string };

/**
 * Arena "Play vs Bots" tile (ADR-0028) — the one-signature entry for poker against the co-located
 * fleet. Connect wallet → click Play → `enterArena` reserves a bot, the fleet pre-creates + funds
 * seat B, then the user signs ONE batched deposit PTB (seat A) → the poker PvP window mounts with
 * `enterArenaMatch` (relay + engine over the now-active tunnel) and auto-plays (the bot plays seat
 * B server-side; the user's `auto` toggle drives this seat).
 *
 * Vertical slice: poker only (the confirmed Rust↔TS parity-clean game). The same shape generalizes
 * to the other games once their parity is verified — add their `enterArenaMatch` + a per-game open.
 */
export function ArenaPokerTile({ onClose }: { onClose?: () => void }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();
  const poker = usePvpQuantumPoker();
  const [state, setState] = useState<ArenaState>({ kind: "idle" });
  // The per-game ephemeral key is generated before allocate (baked into the tunnel) and reused to
  // co-sign moves — held here so enterArena and enterArenaMatch see the SAME key.
  const ephRef = useRef<KeyPair | null>(null);

  // Configure the shared open batcher with the wallet-bound deps, so enterArena's deposit-mode
  // requests coalesce into one wallet popup. Mirrors useRegularPaymentsSession's wiring.
  configureSharedBatcher({
    reads: client as never,
    sponsoredSignExec: sponsored.signExec as never,
    signExec: (async (tx: Parameters<typeof signAndExecute>[0]["transaction"]) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never,
    ensureStakeBalance: sponsored.ensureStakeBalance,
    prepareStake: sponsored.prepareStake,
    selectStakeCoin: sponsored.selectStakeCoin,
  });

  const playVsBot = useCallback(async () => {
    if (!account) {
      setState({ kind: "error", message: "connect a wallet first" });
      return;
    }
    try {
      setState({ kind: "allocating" });
      const eph = generateKeyPair();
      ephRef.current = eph;
      const makeUserParty = async (_game: string): Promise<PartyOnchain> => ({
        address: account.address,
        publicKey: eph.publicKey,
      });
      // enterArena: allocate (fleet pre-creates + funds seat B) → ONE batched deposit PTB (seat A)
      // → report opened. Returns the full allocations (with bot keys + the live tunnelId).
      const allocations = await enterArena({
        games: ["quantum_poker"],
        userAddress: account.address,
        stakePerGame: POKER_BUYIN,
        makeUserParty,
        coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
        usesAddressBalance: isMtpsConfigured,
      });
      if (allocations.length === 0) {
        setState({ kind: "error", message: "no arena bot available for poker" });
        return;
      }
      const allocation = allocations[0];
      // Seat A + seat B are funded; the tunnel is active. Wire the relay + engine (no deposit —
      // enterArenaMatch is wire-only; the batched PTB already funded seat A).
      setState({ kind: "depositing" });
      poker.enterArenaMatch(allocation, eph);
      setState({ kind: "playing", allocation, eph });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [account, poker]);

  if (poker.status === "error") {
    return (
      <div className="sketch grid h-full min-h-[14rem] place-items-center overflow-hidden p-[clamp(12px,4cqmin,28px)] text-center">
        <SketchDefs />
        <div className="sketch-panel sketch-stroke max-w-[min(22rem,92%)] p-[clamp(14px,4cqmin,26px)]">
          <div className="qp-title mb-2">Arena error</div>
          <p className="sketch-note mb-3 text-[var(--sketch-red)]">{poker.error}</p>
          <button
            type="button"
            className="sketch-btn"
            onClick={() => {
              poker.reset();
              setState({ kind: "idle" });
            }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  if (
    state.kind === "playing" &&
    (poker.status === "playing" ||
      poker.status === "settling" ||
      poker.status === "settled")
  ) {
    // The poker hook is driving the match; defer its own board. This tile only owns the entry.
    // A real integration renders QuantumPokerTable here; for the vertical slice the hook's state
    // is the proof the flow connected (status: playing, role: A, state populated).
    return (
      <div className="sketch grid h-full min-h-[14rem] place-items-center overflow-hidden p-[clamp(12px,4cqmin,28px)] text-center">
        <SketchDefs />
        <div className="sketch-panel sketch-stroke max-w-[min(22rem,92%)] p-[clamp(14px,4cqmin,26px)]">
          <div className="qp-title mb-1">In the arena</div>
          <p className="sketch-note">
            status: {poker.status} · role: {poker.role}
          </p>
          <p className="sketch-note mt-1">
            vs {poker.opponentWallet?.slice(0, 10)}…
          </p>
          <p className="sketch-note mt-2">
            The poker hook is wired over the arena tunnel — render QuantumPokerTable for the full
            board (vertical slice surfaces the hook state).
          </p>
          {onClose && (
            <button type="button" className="sketch-btn mt-3" onClick={onClose}>
              Back
            </button>
          )}
        </div>
      </div>
    );
  }

  if (state.kind === "allocating" || state.kind === "depositing") {
    return (
      <div className="sketch grid h-full min-h-[14rem] place-items-center overflow-hidden p-[clamp(12px,4cqmin,28px)] text-center">
        <SketchDefs />
        <div className="sketch-panel sketch-stroke max-w-[min(22rem,92%)] p-[clamp(14px,4cqmin,26px)]">
          <div className="qp-title mb-1">
            {state.kind === "allocating" ? "Reserving a bot…" : "Fund your seat"}
          </div>
          <p className="sketch-note">
            {state.kind === "allocating"
              ? "The fleet is pre-creating your tunnel + funding the bot's seat."
              : "Approve the deposit in your wallet — one signature funds your seat."}
          </p>
        </div>
      </div>
    );
  }

  // idle or error (pre-entry)
  return (
    <div className="sketch grid h-full min-h-[14rem] place-items-center overflow-hidden p-[clamp(12px,4cqmin,28px)] text-center">
      <SketchDefs />
      <div className="sketch-panel sketch-stroke max-w-[min(22rem,92%)] p-[clamp(14px,4cqmin,26px)]">
        <span className="sketch-eyebrow">arena · vs the house</span>
        <div className="qp-title mb-1 mt-1">Quantum Poker</div>
        <p className="sketch-note mb-3">
          Play the co-located fleet bot heads-up. One signature opens + funds your seat; the bot
          plays the other side on-chain.
        </p>
        {state.kind === "error" && (
          <p className="sketch-note mb-2 text-[var(--sketch-red)]">{state.message}</p>
        )}
        <div className="flex flex-wrap justify-center gap-[clamp(6px,2cqmin,12px)]">
          <button type="button" className="sketch-btn sketch-btn--go" onClick={playVsBot}>
            Play vs Bot
          </button>
          {onClose && (
            <button type="button" className="sketch-btn" onClick={onClose}>
              Back
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
