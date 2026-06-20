// Adapter layer: bridges the session-core seam interfaces (seams.ts) to the
// existing ttt relay/identity/onchain code. Browser concerns (localStorage,
// import.meta.env, WebSocket) live here — the session core never imports this.
import { core } from "sui-tunnel-ts";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import {
  openAndFundSharedTunnel,
  depositStake,
  closeCooperativeWithRoot,
  type SignExec,
  type SuiReads,
  type PartyOnchain,
} from "@/onchain/tunnelTx";
import { getControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleRequest } from "@/backend/settleRequest";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type {
  SessionRelay,
  MatchChannel,
  MatchFound,
  PartyEndpointFactory,
  SettlementSigner,
  SettleHalf,
  SessionTransport,
} from "@/agent/session/seams";
import type { RelayClient } from "../app/lib/pvpRelay";
import type { PvpEphemeral } from "../app/lib/pvpIdentity";

// ── SessionRelay ─────────────────────────────────────────────────────────────

/**
 * Wrap an existing RelayClient as a SessionRelay. The relay client handles WS
 * auth internally; queueJoin awaits ready before forwarding the join message.
 * Each call to channel(matchId) returns the same MatchChannel instance for a
 * given matchId (channels are per-match singletons in the relay's routing).
 */
export function makeTttRelay(client: RelayClient): SessionRelay {
  const channels = new Map<string, MatchChannel>();

  let matchCb: ((m: MatchFound) => void) | null = null;
  client.on("match.found", (m) => {
    matchCb?.({
      matchId: String(m.matchId),
      role: (m.role as "A" | "B") ?? "A",
      opponentWallet: String(m.opponentWallet),
    });
  });

  return {
    async queueJoin(game: string): Promise<void> {
      await client.ready;
      client.queueJoin(game);
    },

    onMatch(cb: (match: MatchFound) => void): void {
      matchCb = cb;
    },

    channel(matchId: string): MatchChannel {
      const existing = channels.get(matchId);
      if (existing) return existing;
      const ch = makeTttMatchChannel(client, matchId);
      channels.set(matchId, ch);
      return ch;
    },
  };
}

/**
 * Build a MatchChannel for a specific matchId by routing messages through
 * the relay's app-channel (sendApp/onApp) and the party.hello event.
 *
 * Envelope types used on the app channel:
 *   {t:'hello', ...}   — ephemeral pubkey exchange (via relay.on('party.hello'))
 *   {t:'opened', ...}  — seat A broadcasts the on-chain tunnelId
 *   {t:'settle', ...}  — settle-half exchange (sig + root)
 *
 * Buffering: each one-shot resolver is stored; if the message arrives before
 * the callback is registered it is buffered so the callback fires immediately.
 */
function makeTttMatchChannel(client: RelayClient, matchId: string): MatchChannel {
  // Buffers for messages that arrive before the handler is registered.
  let bufferedHello: string | null = null;
  let helloResolve: ((pub: string) => void) | null = null;

  let bufferedOpened: string | null = null;
  let openedResolve: ((tunnelId: string) => void) | null = null;

  let bufferedSettle: SettleHalf | null = null;
  let settleResolve: ((half: SettleHalf) => void) | null = null;

  // Wire the relay's party.hello server event for pubkey exchange.
  client.on("party.hello", (h) => {
    if (h.matchId !== matchId) return;
    const pub = String(h.ephemeralPubkey);
    if (helloResolve) {
      helloResolve(pub);
      helloResolve = null;
    } else {
      bufferedHello = pub;
    }
  });

  // Wire the app-channel for opened/settle messages.
  client.onApp(matchId, (msg) => {
    if (msg.t === "opened") {
      const tunnelId = String(msg.tunnelId);
      if (openedResolve) {
        openedResolve(tunnelId);
        openedResolve = null;
      } else {
        bufferedOpened = tunnelId;
      }
    } else if (msg.t === "settle") {
      const half: SettleHalf = { sig: String(msg.sig), root: String(msg.root) };
      if (settleResolve) {
        settleResolve(half);
        settleResolve = null;
      } else {
        bufferedSettle = half;
      }
    }
  });

  // Build the transport once (relay.transport() registers the onFrame callback).
  const relayTransport = client.transport(matchId);
  const transport: SessionTransport = {
    send: relayTransport.send.bind(relayTransport),
    onFrame: relayTransport.onFrame.bind(relayTransport),
    onClose(_cb: () => void): void {
      // RelayClient does not surface per-match close events; no-op for now.
    },
    onError(_cb: (err: unknown) => void): void {
      // Same — no per-match error event on this relay version.
    },
    close(): void {
      // Channel transport close is a no-op; use SessionRelay.close() to tear down the WS.
    },
  };

  return {
    transport,

    partyHello(pubkeyHex: string): void {
      // walletSig unused in v1 — pass empty string as the existing hook does.
      client.partyHello(matchId, pubkeyHex, "");
    },

    onPeerHello(cb: (pubkeyHex: string) => void): void {
      if (bufferedHello !== null) {
        const pub = bufferedHello;
        bufferedHello = null;
        cb(pub);
      } else {
        helloResolve = cb;
      }
    },

    announceOpened(tunnelId: string): void {
      // Two signals for compatibility: the typed relay message + the app envelope.
      client.tunnelOpened(matchId, tunnelId);
      client.sendApp(matchId, { t: "opened", tunnelId });
    },

    onOpened(cb: (tunnelId: string) => void): void {
      if (bufferedOpened !== null) {
        const id = bufferedOpened;
        bufferedOpened = null;
        cb(id);
      } else {
        openedResolve = cb;
      }
    },

    sendSettleHalf(half: SettleHalf): void {
      client.sendApp(matchId, { t: "settle", sig: half.sig, root: half.root });
    },

    onSettleHalf(cb: (half: SettleHalf) => void): void {
      if (bufferedSettle !== null) {
        const h = bufferedSettle;
        bufferedSettle = null;
        cb(h);
      } else {
        settleResolve = cb;
      }
    },
  };
}

// ── PartyEndpointFactory ──────────────────────────────────────────────────────

/**
 * Build the endpoint factory from a loaded PvpEphemeral. The ephemeral key is
 * the move-signer (off-chain ed25519); the on-chain party addresses are
 * injected at buildConfig time once they are known from the match payload.
 */
export function makeTttEndpointFactory(
  eph: PvpEphemeral,
  walletAddress: string = "",
): PartyEndpointFactory {
  return {
    self(): { publicKey: Uint8Array } {
      return { publicKey: eph.coreKey.publicKey };
    },

    buildConfig(args: {
      tunnelId: string;
      selfParty: Party;
      opponentPublicKey: Uint8Array;
      opponentAddress: string;
    }): unknown {
      const backend = defaultBackend();
      const self = core.makeEndpoint(
        backend,
        walletAddress,
        { publicKey: eph.coreKey.publicKey, scheme: 0, secretKey: eph.coreKey.secretKey },
        true,
      );
      const opponent = core.makeEndpoint(
        backend,
        args.opponentAddress,
        { publicKey: args.opponentPublicKey, scheme: 0 },
        false,
      );
      return { tunnelId: args.tunnelId, selfParty: args.selfParty, self, opponent };
    },
  };
}

// ── SettlementSigner ──────────────────────────────────────────────────────────

/** Static context the signer needs — set once per match from the match payload. */
export interface TttSignerContext {
  walletAddress: string;
  opponentAddress: string;
  selfPublicKey: Uint8Array;
  opponentPublicKey: Uint8Array;
  reads: SuiReads;
}

/**
 * Internal overrides for unit tests — lets tests swap the tunnelTx helpers
 * without hitting the SDK's PACKAGE_ID requirement. Production callers omit this.
 */
export interface TttSignerOverrides {
  openAndFund?: (opts: {
    reads: SuiReads;
    signExec: SignExec;
    partyA: PartyOnchain;
    partyB: PartyOnchain;
    amount: bigint;
  }) => Promise<string>;
  deposit?: (opts: { signExec: SignExec; tunnelId: string; amount: bigint }) => Promise<void>;
  cooperativeClose?: (opts: {
    signExec: SignExec;
    tunnelId: string;
    settlement: unknown;
  }) => Promise<string>;
}

/**
 * Wrap the existing tunnelTx helpers as a SettlementSigner. The signExec
 * function comes from dapp-kit and signs with the connected zkLogin wallet.
 *
 * submitCooperativeClose mirrors the backend→wallet fallback pattern from
 * usePvpTicTacToe.finishSettle and agentEngine.settle(): try the backend
 * /settle route first, fall back to closeCooperativeWithRoot on failure.
 *
 * @param overrides - Internal seam for unit tests; omit in production.
 */
export function makeTttSettlementSigner(
  signExec: SignExec,
  ctx: TttSignerContext,
  overrides?: TttSignerOverrides,
): SettlementSigner {
  const partyA: PartyOnchain = {
    address: ctx.walletAddress,
    publicKey: ctx.selfPublicKey,
  };
  const partyB: PartyOnchain = {
    address: ctx.opponentAddress,
    publicKey: ctx.opponentPublicKey,
  };

  const doOpenAndFund = overrides?.openAndFund ?? openAndFundSharedTunnel;
  const doDeposit = overrides?.deposit ?? depositStake;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doClose: (opts: { signExec: SignExec; tunnelId: string; settlement: any }) => Promise<string> =
    overrides?.cooperativeClose ?? closeCooperativeWithRoot;

  return {
    async openAndFundSeatA(args: { stake: bigint }): Promise<{ tunnelId: string }> {
      const tunnelId = await doOpenAndFund({
        reads: ctx.reads,
        signExec,
        partyA,
        partyB,
        amount: args.stake,
      });
      return { tunnelId };
    },

    async depositSeatB(args: { tunnelId: string; stake: bigint }): Promise<void> {
      await doDeposit({ signExec, tunnelId: args.tunnelId, amount: args.stake });
    },

    async submitCooperativeClose(args: {
      tunnelId: string;
      coSigned: unknown;
    }): Promise<{ digest: string }> {
      // Try the backend /settle route (Walrus archival) first; fall back to a
      // wallet-submitted close_cooperative_with_root — mirrors agentEngine.settle().
      try {
        const result = await getControlPlaneClient().settle(
          args.tunnelId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          coSignedToSettleRequest(args.coSigned as any, []),
        );
        return { digest: result.txDigest };
      } catch {
        const digest = await doClose({
          signExec,
          tunnelId: args.tunnelId,
          settlement: args.coSigned,
        });
        return { digest };
      }
    },

    async closeOnTimeout(args: { tunnelId: string }): Promise<{ digest: string }> {
      // Timeout close is wallet-only (no co-signature available).
      // The session core calls this when the settle-half exchange times out.
      // We reuse closeCooperativeWithRoot's tx builder pathway via a dummy
      // settlement is not available here — this branch requires a dedicated
      // `close_on_timeout` transaction builder which is not yet exposed by
      // tunnelTx.ts. For now we signal the error with a clear message so the
      // caller can escalate. This matches the current usePvpTicTacToe behavior
      // (it does not implement timeout close either).
      throw new Error(
        `closeOnTimeout not yet implemented for tunnel ${args.tunnelId}: ` +
          "a close_on_timeout tx builder is not exposed by tunnelTx.ts",
      );
    },
  };
}
