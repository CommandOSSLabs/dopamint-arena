// Centralized batched arena entry (ADR-0028, the "one PTB → all games explode" flow, PR #95 pattern).
// Mounted ONCE inside the wallet provider (renders nothing). On wallet connect it reserves a fleet bot
// for every arena-wired game and deposits ALL their seat-A stakes in a SINGLE batched PTB (the shared
// `TunnelOpenBatcher` coalesces them — one wallet popup), then publishes each {allocation, keypair} to
// the arena store. Each game window's PvP hook reads its entry and auto-`enterArenaMatch`es — so the
// whole arena comes alive from one signature, no per-game "Play" click.
import { useEffect, useRef } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { list } from "@/games/registry";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { configureSharedBatcher } from "@/onchain/sharedTunnelOpenBatcher";
import { enterArena, type MakeUserParty } from "@/onchain/arenaEnter";
import { setArenaEntry } from "@/onchain/arenaAllocationStore";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { resolveBackendUrl } from "@/backend/controlPlane";
import type { PartyOnchain } from "@/onchain/tunnelTx";

/** Every arena-wired game's backend id (set via `GameModule.arenaGameId`). Empty ⇒ nothing to batch. */
function arenaGameIds(): string[] {
  return list()
    .map((m) => m.arenaGameId)
    .filter((id): id is string => !!id);
}

export function useArenaAutoEnter(): void {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();
  const owner = account?.address;
  // One batched entry per connected wallet; guard StrictMode/autoConnect double-fire (→ double deposit).
  const entered = useRef<string | null>(null);

  useEffect(() => {
    if (!owner) return;
    const games = arenaGameIds();
    if (games.length === 0) return;
    if (entered.current === owner) return;
    entered.current = owner;

    const signExec = async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    };
    // Configure the process-wide batcher with this wallet's signer/sponsor so `enterArena`'s default
    // `open` (requestTunnelOpen) coalesces every game's seat-A deposit into ONE PTB (PR #95).
    configureSharedBatcher({
      reads: client as never,
      sponsoredSignExec: sponsored.signExec,
      signExec: signExec as never,
      prepareStake: sponsored.prepareStake,
      selectStakeCoin: sponsored.selectStakeCoin,
      ensureStakeBalance: sponsored.ensureStakeBalance,
    });

    // One ephemeral key per game; its pubkey is baked into the tunnel at allocate and the SAME key
    // co-signs moves later (via the store → enterArenaMatch), so stash the full keypair as it's minted.
    const keypairs = new Map<string, KeyPair>();
    const makeUserParty: MakeUserParty = async (game: string) => {
      const eph = generateKeyPair();
      keypairs.set(game, eph);
      const party: PartyOnchain = { address: owner, publicKey: eph.publicKey };
      return party;
    };

    void (async () => {
      try {
        const allocations = await enterArena({
          games,
          userAddress: owner,
          makeUserParty,
          coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
          apiBase: resolveBackendUrl(),
        });
        for (const allocation of allocations) {
          const keypair = keypairs.get(allocation.game);
          if (keypair) setArenaEntry(allocation.game, { allocation, keypair });
        }
      } catch (e) {
        // A failed batch (no free bot, deposit rejected) leaves the store empty — games just show
        // their normal lobby. Re-arm so the user can retry on reconnect.
        console.warn("[arena] batched entry failed", e);
        entered.current = null;
      }
    })();
  }, [owner, client, signAndExecute, sponsored]);
}

/** App-wide mount for the centralized batched arena entry. Render ONCE inside the wallet provider. */
export function ArenaAutoEnter(): null {
  useArenaAutoEnter();
  return null;
}
