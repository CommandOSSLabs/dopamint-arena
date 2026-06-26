// Generic ON-CHAIN bot-vs-bot self-play for a tunnel payment GameKit — the same lifecycle every
// game uses: one wallet (a sponsored bot keypair) opens + funds BOTH seats, the consumer bot pays
// the provider off-chain over an `OffchainTunnel.selfPlay`, then the tunnel closes cooperatively
// through the backend `/settle` (Walrus), falling back to a bot-key on-chain close. Kept OUT of
// React (a per-window session) so it survives minimize / maximize / desktop reflow (ADR-0003).
import { useSyncExternalStore } from "react";
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  generateKeyPair,
  keyPairFromSecret,
  type KeyPair,
} from "sui-tunnel-ts/core/crypto";
import { OffchainTunnel, type CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { getControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleBody } from "@/backend/settleRequest";
import {
  closeCooperativeWithRoot,
  openAndFundSelfPlay,
  readCreatedAt,
  type SignExec,
} from "@/onchain/tunnelTx";
import { makeKeypairSponsoredSignExec } from "@/onchain/sponsor";
import {
  MTPS_COIN_TYPE,
  ensureMtpsAddressBalance,
  isMtpsAddressBalance,
  isMtpsConfigured,
} from "@/onchain/mtps";
import type { GameKit } from "@/agent/gameKit";

const STEP_MS = 420; // pace the on-chain stream so it's watchable
const SETTLE_URL = (d: string) => `https://suiscan.xyz/testnet/tx/${d}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type SelfPlayStatus =
  | "idle"
  | "opening"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface TunnelSelfPlayConfig<S, M> {
  /** Build the kit for a given per-seat stake (price/cost scales to the stake). */
  createKit: (stakePerSeat: bigint) => GameKit<S, M>;
  /** Per-seat stake (the consumer's spendable budget; provider stakes the same). */
  stakePerSeat: bigint;
  /** Read the unit counter (requests / calls) from the protocol state. */
  countOf: (state: S) => bigint;
}

/** One metered call as a REAL co-signed state update — nonce, amount, state hash, co-signature. */
export interface SelfPlayCall {
  nonce: number;
  amount: bigint;
  stateHash: string;
  sig: string;
}

export interface TunnelSelfPlaySnapshot {
  status: SelfPlayStatus;
  /** Consumer (A) remaining balance. */
  consumerLeft: bigint;
  /** Provider (B) earnings above its own stake. */
  providerEarned: bigint;
  /** Per-seat stake — the provider's max earnings / consumer's start. */
  budget: bigint;
  count: bigint;
  /** Most recent metered calls as real co-signed updates (newest first). */
  log: SelfPlayCall[];
  openDigest: string | null;
  settleDigest: string | null;
  settleUrl: string | null;
  proofUrl: string | null;
  error: string | null;
}

interface Bot {
  coreKey: KeyPair;
  keypair: Ed25519Keypair;
  address: string;
  publicKey: Uint8Array;
}

function makeBot(): Bot {
  const seed = generateKeyPair().secretKey;
  const coreKey = keyPairFromSecret(seed);
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  return {
    coreKey,
    keypair,
    address: keypair.getPublicKey().toSuiAddress(),
    publicKey: coreKey.publicKey,
  };
}

/** Per-window self-play session, kept out of React so a reflow never aborts a live match. */
class TunnelSelfPlaySession<S, M> {
  client: unknown = null;
  private cfg: TunnelSelfPlayConfig<S, M> | null = null;
  private gen = 0;

  private snap: TunnelSelfPlaySnapshot = {
    status: "idle",
    consumerLeft: 0n,
    providerEarned: 0n,
    budget: 0n,
    count: 0n,
    log: [],
    openDigest: null,
    settleDigest: null,
    settleUrl: null,
    proofUrl: null,
    error: null,
  };
  private listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): TunnelSelfPlaySnapshot => this.snap;

  private patch(p: Partial<TunnelSelfPlaySnapshot>) {
    this.snap = { ...this.snap, ...p };
    for (const l of this.listeners) l();
  }

  configure(cfg: TunnelSelfPlayConfig<S, M>) {
    this.cfg = cfg;
    if (this.snap.budget === 0n) this.patch({ budget: cfg.stakePerSeat });
  }

  start = () => {
    if (this.snap.status === "opening" || this.snap.status === "playing")
      return;
    void this.run();
  };

  dispose = () => {
    this.gen += 1;
    this.listeners.clear();
  };

  private async run() {
    const cfg = this.cfg;
    const client = this.client;
    if (!cfg || !client) return;
    if (!isMtpsConfigured || !isMtpsAddressBalance) {
      this.patch({
        status: "error",
        error: "MTPS address-balance mode is required (VITE_MTPS_* env).",
      });
      return;
    }
    const myGen = ++this.gen;
    const stake = cfg.stakePerSeat;
    const kit = cfg.createKit(stake);
    this.patch({
      status: "opening",
      error: null,
      openDigest: null,
      settleDigest: null,
      settleUrl: null,
      proofUrl: null,
      count: 0n,
      log: [],
      consumerLeft: stake,
      providerEarned: 0n,
      budget: stake,
    });

    try {
      const botA = makeBot();
      const botB = makeBot();
      const sign: SignExec = makeKeypairSponsoredSignExec({
        address: botA.address,
        keypair: botA.keypair,
        client: client as never,
      });
      const reads = client as Parameters<
        typeof openAndFundSelfPlay
      >[0]["reads"];

      // Bot A funds both seats from its MTPS address balance (faucet + sweep first).
      await ensureMtpsAddressBalance({
        client: client as never,
        signExec: sign,
        owner: botA.address,
        need: 2n * stake,
      });
      if (this.gen !== myGen) return;

      const tunnelId = await openAndFundSelfPlay({
        reads,
        signExec: sign,
        partyA: { address: botA.address, publicKey: botA.publicKey },
        partyB: { address: botB.address, publicKey: botB.publicKey },
        aAmount: stake,
        bAmount: stake,
        coinType: MTPS_COIN_TYPE,
        stakeFromBalance: { amount: 2n * stake, coinType: MTPS_COIN_TYPE },
      });
      if (this.gen !== myGen) return;
      this.patch({ openDigest: tunnelId });

      const createdAt = await readCreatedAt(reads, tunnelId);
      if (this.gen !== myGen) return;

      const transcript = new Transcript(tunnelId);
      const tunnel = OffchainTunnel.selfPlay(
        kit.protocol,
        tunnelId,
        botA.coreKey,
        botB.coreKey,
        botA.address,
        botB.address,
        { a: stake, b: stake },
      );
      // Capture each real co-signed update as it's produced (step() signs synchronously). A holder
      // object (not a bare `let`) keeps TS from narrowing the closure-set value to null.
      const updateRef: { current: CoSignedUpdate | null } = { current: null };
      tunnel.onUpdate = (u) => {
        transcript.append(u);
        updateRef.current = u;
      };

      const bot = kit.createBot("A", {
        rngForSeat: () => Math.random,
      });
      this.patch({ status: "playing" });

      let ts = 1n;
      let prevB = stake;
      while (!kit.protocol.isTerminal(tunnel.state)) {
        if (this.gen !== myGen) return;
        const move = bot.plan(tunnel.state);
        if (!move) break;
        tunnel.step(move, "A", { timestamp: ts++ });
        bot.confirm(tunnel.state, move);
        const bal = kit.protocol.balances(tunnel.state);
        // Build the log row from the REAL signed update: nonce, amount, state hash, co-signature.
        const u = updateRef.current;
        const call: SelfPlayCall | null = u
          ? {
              nonce: Number(u.update.nonce),
              amount: bal.b - prevB,
              stateHash: `0x${toHex(u.update.stateHash).slice(0, 8)}`,
              sig: `0x${toHex(u.sigA).slice(0, 8)}`,
            }
          : null;
        prevB = bal.b;
        this.patch({
          consumerLeft: bal.a,
          providerEarned: bal.b > stake ? bal.b - stake : 0n,
          count: cfg.countOf(tunnel.state),
          ...(call ? { log: [call, ...this.snap.log].slice(0, 8) } : {}),
        });
        await sleep(STEP_MS);
      }
      if (this.gen !== myGen) return;

      // Cooperative close: backend /settle (Walrus), fall back to a bot-key on-chain close.
      this.patch({ status: "settling" });
      const settlement = tunnel.buildSettlementWithRoot(
        createdAt,
        transcript.root(),
        0n,
      );
      let settleDigest: string;
      let proofUrl: string | null = null;
      try {
        const r = await getControlPlaneClient().settle(
          tunnelId,
          coSignedToSettleBody(settlement, transcript.rawEntries()),
        );
        settleDigest = r.txDigest;
        proofUrl = r.proofUrl;
      } catch (e) {
        console.error("[self-play] backend /settle failed; bot-key close:", e);
        settleDigest = await closeCooperativeWithRoot({
          signExec: sign,
          tunnelId,
          settlement,
          coinType: MTPS_COIN_TYPE,
        });
      }
      if (this.gen !== myGen) return;
      this.patch({
        status: "settled",
        settleDigest,
        settleUrl: SETTLE_URL(settleDigest),
        proofUrl,
      });
    } catch (e) {
      if (this.gen !== myGen) return;
      this.patch({
        status: "error",
        error: String((e as Error)?.message ?? e),
      });
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessions = new Map<string, TunnelSelfPlaySession<any, any>>();

function getSession<S, M>(windowId: string): TunnelSelfPlaySession<S, M> {
  let s = sessions.get(windowId);
  if (!s) {
    s = new TunnelSelfPlaySession<S, M>();
    sessions.set(windowId, s);
    const created = s;
    registerWindowDisposer(windowId, "tunnel-self-play", () => {
      created.dispose();
      sessions.delete(windowId);
    });
  }
  return s;
}

export interface TunnelSelfPlayView extends TunnelSelfPlaySnapshot {
  ready: boolean;
  start: () => void;
}

export function useTunnelSelfPlay<S, M>(
  windowId: string,
  config: TunnelSelfPlayConfig<S, M>,
): TunnelSelfPlayView {
  const client = useSuiClient();
  const account = useCurrentAccount();
  const session = getSession<S, M>(windowId);
  session.client = client;
  session.configure(config);

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snap,
    ready: Boolean(account?.address),
    start: session.start,
  };
}
