// Centralized batched arena entry (ADR-0028, the "one PTB → games explode" flow, PR #95 pattern).
// Mounted ONCE inside the wallet provider (renders nothing). On wallet connect it reserves a fleet bot
// and deposits seat A for each arena game whose window is OPEN (per the persisted desktop layout) in a
// SINGLE batched PTB (the shared `TunnelOpenBatcher` coalesces them — one wallet popup), then publishes
// each {allocation, keypair} to the arena store. Each game window's PvP hook reads its entry and
// auto-`enterArenaMatch`es — so the open floor comes alive from one signature, no per-game "Play" click.
// Scoping to open windows avoids funding tunnels + reserving bots for games the user isn't showing.
import { useEffect, useRef } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { list, arenaGameIdForModule } from "@/games/registry";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { configureSharedBatcher } from "@/onchain/sharedTunnelOpenBatcher";
import { enterArena } from "@/onchain/arenaEnter";
import { setArenaEntry } from "@/onchain/arenaAllocationStore";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { resolveBackendUrl } from "@/backend/controlPlane";
import { listActiveTunnels, readResumeRecord } from "@/pvp/resume";
import { resumingGameKeysOf } from "@/onchain/arenaAllocationSkip";

/** localStorage key the desktop persists its window layout under (`Desktop.tsx`). */
const LAYOUT_KEY = "mtps.desktop.layouts.v1";

/** Open game windows (instance id + base module id) from the persisted layout, WITHOUT deduping — so
 *  N windows of the same game are each counted. Empty ⇒ unknown (caller falls back to all defaults). */
function openWindowInstances(): { windowId: string; moduleId: string }[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return [];
    const layouts = JSON.parse(raw) as Record<string, Array<{ id?: unknown }>>;
    const out: { windowId: string; moduleId: string }[] = [];
    for (const items of Object.values(layouts)) {
      if (!Array.isArray(items)) continue;
      for (const it of items)
        if (typeof it?.id === "string")
          out.push({ windowId: it.id, moduleId: it.id.split("#")[0] });
    }
    return out;
  } catch {
    return [];
  }
}

/** Canonicalize a game id for comparison (resume keys are kebab `chicken-cross`, arena ids underscore
 *  `chicken_cross`); strip both separators. Mirrors `arenaAllocationSkip`. */
const canonGameId = (id: string): string => id.replace(/[-_]/g, "");

/** Remove ONE `games` entry per resuming record whose game matches, so a window that will resume its
 *  in-flight tunnel isn't also handed a fresh allocation (which would strand a second stake). */
function subtractResumingPerGame(
  games: string[],
  resumingGameKeys: string[],
): string[] {
  const remaining = [...games];
  for (const key of resumingGameKeys) {
    const idx = remaining.findIndex((g) => canonGameId(g) === canonGameId(key));
    if (idx >= 0) remaining.splice(idx, 1);
  }
  return remaining;
}

/** Arena ids to allocate at connect, WITH MULTIPLICITY — one per open window (3 caro tabs → 3 caro
 *  requests), minus the windows that will RESUME an in-flight tunnel instead. A multi-protocol module
 *  (tic-tac-toe + caro) resolves to its DEFAULT arena id (caro). When the open set is unknown (empty
 *  layout) we fall back to one of each arena module's default so a fresh desktop still comes alive. */
function arenaGamesForOpenWindows(): string[] {
  const wins = openWindowInstances();
  const games: string[] = [];
  if (wins.length > 0) {
    for (const w of wins) {
      const arenaId = arenaGameIdForModule(w.moduleId);
      if (arenaId) games.push(arenaId);
    }
  } else {
    for (const m of list()) {
      const arenaId = arenaGameIdForModule(m.id);
      if (arenaId) games.push(arenaId);
    }
  }
  // Subtract windows that will RESUME instead: each open window's PvP hook re-attaches its persisted
  // IN-FLIGHT tunnel, so allocating a second one would strand its stake. A FINISHED (terminal) record
  // does NOT suppress (settle+reload should allocate a new game) — `resumingGameKeysOf` trusts the
  // record's stamped flag, keeping allocate and resume consistent order-independently.
  const resumingGameKeys = resumingGameKeysOf(
    listActiveTunnels().map((id) => readResumeRecord(id)),
  );
  return subtractResumingPerGame(games, resumingGameKeys);
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
    const games = arenaGamesForOpenWindows();
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

    void (async () => {
      try {
        // `enterArena` mints one ephemeral key PER request (games may repeat — one per open window),
        // allocates a bot each, deposits all seat-A's in ONE batched PTB, and returns each match's
        // {allocation, keypair}. Publish each under its game so every same-game window claims one.
        const matches = await enterArena({
          games,
          userAddress: owner,
          coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
          apiBase: resolveBackendUrl(),
        });
        for (const m of matches) setArenaEntry(m.allocation.game, m);
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
