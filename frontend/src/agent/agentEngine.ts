// Game-agnostic agent engine: rotate tunnel games, play each over the REAL relay + on-chain
// lifecycle via the canonical GameKit registry, settle root-anchored through the backend
// (Walrus). Each browser context owns exactly one bot seat per match; the opponent is another
// wallet/context on the same relay path humans use.
//
// NOTE (concurrency): M>1 needs MpClient to multiplex matches by matchId (today channel()/
// quickMatch serve one match at a time). The P1 proof runs M=1, where each slot loops
// sequentially on the shared socket and the existing MpClient suffices.
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint, type CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { MpClient, resolveMpWsUrl, type PvpChannel } from "../pvp/mpClient";
import {
  getControlPlaneClient,
  resolveBackendUrl,
  type RegisterSessionResult,
} from "../backend/controlPlane";
import {
  closeCooperativeWithRoot,
  depositStake,
  openAndFundSharedTunnel,
  readCreatedAt,
  type SignExec,
  type SuiReads,
} from "../onchain/tunnelTx";
import { coSignedToSettleBody } from "../backend/settleRequest";
import { AGENT_GAMES, nextGameIndex, type GameSpec } from "./agentConfig";
import { GAME_KITS, type GameBot, type StateHash } from "./gameKit";

export interface AgentDeps {
  wallet: string; // programmatic wallet address
  signExec: SignExec; // dapp-kit wrapper -> programmatic wallet (popup-free)
  reads: SuiReads; // SuiClient
  onStatus?: (s: string) => void;
}

/** Buffer peer messages so a waiter never misses one that arrived early (mirrors usePvpTicTacToe). */
function makeInbox(channel: PvpChannel) {
  const buf = new Map<string, { t: string }>();
  const waiters = new Map<string, (m: { t: string }) => void>();
  channel.onPeer((m) => {
    const w = waiters.get(m.t);
    if (w) {
      waiters.delete(m.t);
      w(m);
    } else {
      buf.set(m.t, m);
    }
  });
  return <T = { t: string }>(t: string): Promise<T> =>
    new Promise((res) => {
      const b = buf.get(t);
      if (b) {
        buf.delete(t);
        res(b as T);
      } else {
        waiters.set(t, res as (m: { t: string }) => void);
      }
    });
}

function seedFromString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let value = seed;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createBotContext(seedLabel: string) {
  return {
    rngForSeat: (seat: "A" | "B") =>
      mulberry32(seedFromString(`${seedLabel}:${seat}`)),
  };
}

async function playOneMatch(
  mp: MpClient,
  deps: AgentDeps,
  spec: GameSpec,
): Promise<void> {
  const kit = GAME_KITS[spec.kitId];
  const stake = spec.stake ?? kit.defaultStake;
  const eph: KeyPair = generateKeyPair(); // per-slot move-signing key
  const match = await mp.quickMatch(spec.id);
  try {
    const channel = mp.channel(match.matchId);
    const waitPeer = makeInbox(channel);
    const bot = kit.createBot(
      match.role,
      createBotContext(`${spec.kitId}:${match.matchId}:${deps.wallet}`),
    ) as GameBot<unknown, unknown>;

    channel.sendPeer({ t: "hello", ephemeralPubkey: toHex(eph.publicKey) });
    const oppPub = fromHex(
      (await waitPeer<{ ephemeralPubkey: string }>("hello")).ephemeralPubkey,
    );

    // Fund: seat A opens + funds its seat in one tx then announces; seat B gated-deposits.
    let tunnelId: string;
    if (match.role === "A") {
      tunnelId = await openAndFundSharedTunnel({
        reads: deps.reads,
        signExec: deps.signExec,
        partyA: { address: deps.wallet, publicKey: eph.publicKey },
        partyB: { address: match.opponentWallet, publicKey: oppPub },
        amount: stake,
      });
      mp.announceTunnel(match.matchId, tunnelId);
      channel.sendPeer({ t: "open", tunnelId });
    } else {
      tunnelId = (await waitPeer<{ tunnelId: string }>("open")).tunnelId;
      await depositStake({
        signExec: deps.signExec,
        tunnelId,
        amount: stake,
      });
    }

    let session: RegisterSessionResult | null = null;
    let heartbeatNonce = 0n;
    let heartbeatActions = 0;
    let lastHeartbeatAt = Date.now();
    const flushHeartbeat = (force: boolean) => {
      if (match.role !== "A" || !session || heartbeatActions === 0) return;
      const now = Date.now();
      const windowMs = now - lastHeartbeatAt;
      if (!force && windowMs < 1000) return;
      const actionsDelta = heartbeatActions;
      heartbeatActions = 0;
      lastHeartbeatAt = now;
      getControlPlaneClient()
        .sendHeartbeat(session.sessionId, session.statsToken, {
          tunnelId,
          nonce: heartbeatNonce.toString(),
          actionsDelta,
          windowMs: Math.max(1, windowMs),
        })
        .catch((e) => console.error("[agent] heartbeat failed:", e));
    };

    if (match.role === "A") {
      try {
        session = await getControlPlaneClient().registerSession({
          userAddress: deps.wallet,
          game: kit.id,
          tunnels: [
            {
              tunnelId,
              partyA: deps.wallet,
              partyB: match.opponentWallet,
            },
          ],
        });
      } catch (e) {
        console.error("[agent] registerSession failed:", e);
      }
    }

    // Build the distributed engine over the relay transport; protocol and bot behavior come
    // from the canonical FE GameKit, so the state hash domain matches the human hook.
    const backend = defaultBackend();
    const self = makeEndpoint(backend, deps.wallet, eph, true);
    const opp = makeEndpoint(
      backend,
      match.opponentWallet,
      { publicKey: oppPub, scheme: eph.scheme },
      false,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic protocol bridge
    const dt = new DistributedTunnel(
      kit.protocol as never,
      {
        tunnelId,
        self,
        opponent: opp,
        selfParty: match.role,
        moveCodec: kit.moveCodec as never,
      },
      channel.transport,
      { a: stake, b: stake },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;
    const transcript = new Transcript(tunnelId);
    let lastActedHash: StateHash | null = null;
    let pendingSelfMove: {
      state: unknown;
      move: unknown;
      hash: StateHash;
    } | null = null;
    let rejectMatch: ((e: unknown) => void) | null = null;

    // Auto-play: propose the bot kit's next legal move as soon as the prior update confirms.
    const move = () => {
      if (kit.protocol.isTerminal(dt.state)) return;
      if (pendingSelfMove) return;
      const h = kit.stateHash(dt.state);
      if (lastActedHash === h) return;
      const m = bot.plan(dt.state);
      if (!m) return;

      pendingSelfMove = { state: dt.state, move: m, hash: h };
      try {
        dt.propose(m, BigInt(Date.now()));
      } catch (e) {
        pendingSelfMove = null;
        bot.abort();
        rejectMatch?.(e);
      }
    };

    await new Promise<void>((resolve, reject) => {
      rejectMatch = reject;
      let settling = false;
      dt.onConfirmed = (u: CoSignedUpdate) => {
        transcript.append(u);
        if (match.role === "A") {
          heartbeatNonce = u.update.nonce;
          heartbeatActions += 1;
          flushHeartbeat(false);
        }
        if (pendingSelfMove) {
          bot.confirm(pendingSelfMove.state, pendingSelfMove.move);
          lastActedHash = pendingSelfMove.hash;
          pendingSelfMove = null;
        }
        const balances = kit.protocol.balances(dt.state);
        if (balances.a + balances.b !== stake * 2n) {
          reject(
            new Error(
              `${kit.id} balance sum ${balances.a + balances.b} != locked total ${stake * 2n}`,
            ),
          );
          return;
        }
        if (kit.protocol.isTerminal(dt.state)) {
          if (settling) return;
          settling = true;
          flushHeartbeat(true);
          settle(
            dt,
            match.role,
            channel,
            waitPeer,
            deps,
            tunnelId,
            transcript,
          ).then(resolve, reject);
        } else {
          move();
        }
      };
      // Readiness handshake only after onConfirmed is wired, then kick off if we move first.
      if (match.role === "A") void waitPeer("ready").then(() => move());
      else {
        channel.sendPeer({ t: "ready" });
        move();
      }
    });
  } finally {
    mp.releaseMatch(match.matchId);
  }
}

/** Exchange root-anchored settlement halves, then seat A submits via backend /settle (Walrus),
 *  falling back to a wallet-submitted close_cooperative_with_root. Mirrors usePvpTicTacToe. */
async function settle(
  dt: {
    buildSettlementHalfWithRoot: (
      createdAt: bigint,
      root: Uint8Array,
      n: bigint,
    ) => { settlement: SettlementHalf; sigSelf: Uint8Array };
    combineSettlementWithRoot: (
      s: SettlementHalf,
      a: Uint8Array,
      b: Uint8Array,
    ) => unknown;
  },
  role: "A" | "B",
  channel: PvpChannel,
  waitPeer: <T>(t: string) => Promise<T>,
  deps: AgentDeps,
  tunnelId: string,
  transcript: Transcript,
): Promise<void> {
  const createdAt = await readCreatedAt(deps.reads, tunnelId);
  const root = transcript.root();
  const half = dt.buildSettlementHalfWithRoot(createdAt, root, 0n);
  channel.sendPeer({
    t: "settleHalf",
    partyABalance: half.settlement.partyABalance,
    partyBBalance: half.settlement.partyBBalance,
    finalNonce: half.settlement.finalNonce,
    timestamp: half.settlement.timestamp,
    transcriptRoot: toHex(root),
    sig: toHex(half.sigSelf),
  });
  const other = await waitPeer<{ sig: string; transcriptRoot: string }>(
    "settleHalf",
  );
  if (other.transcriptRoot !== toHex(root)) {
    throw new Error("settlement transcript-root mismatch between parties");
  }
  const co = dt.combineSettlementWithRoot(
    half.settlement,
    half.sigSelf,
    fromHex(other.sig),
  );
  if (role !== "A") return; // single submitter
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getControlPlaneClient().settle(
      tunnelId,
      coSignedToSettleBody(co as any, transcript.rawEntries()),
    );
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await closeCooperativeWithRoot({
      signExec: deps.signExec,
      tunnelId,
      settlement: co as any,
    });
  }
}

interface SettlementHalf {
  partyABalance: bigint;
  partyBBalance: bigint;
  finalNonce: bigint;
  timestamp: bigint;
}

/** Drive one agent: one WS + wallet, M concurrent slots, each looping match→settle→next game. */
export async function runAgent(
  deps: AgentDeps,
  concurrency: number,
  shouldStop: () => boolean,
  gameFilter?: string | null,
): Promise<void> {
  const connectKey = generateKeyPair(); // authenticates the one shared WS
  const wsUrl = resolveMpWsUrl(resolveBackendUrl());
  deps.onStatus?.(`ws:connecting:${wsUrl}`);
  const mp = new MpClient(wsUrl, deps.wallet, connectKey);
  await mp.connect();
  deps.onStatus?.("ws:connected");

  // Serialize this wallet's on-chain txs (one gas coin -> no Sui equivocation).
  let chain: Promise<unknown> = Promise.resolve();
  const slotDeps: AgentDeps = {
    ...deps,
    signExec: (tx) => {
      const p = chain.then(() => deps.signExec(tx));
      chain = p.catch(() => undefined);
      return p;
    },
  };

  const games = gameFilter
    ? AGENT_GAMES.filter((g) => g.id === gameFilter || g.kitId === gameFilter)
    : AGENT_GAMES;
  if (games.length === 0)
    throw new Error(`unknown agent game filter: ${gameFilter}`);

  const slot = async (i: number) => {
    let gi = i % games.length; // stagger starts so the fleet spreads across games
    while (!shouldStop()) {
      const spec = games[gi];
      deps.onStatus?.(`slot${i}:queue:${spec.id}`);
      try {
        await playOneMatch(mp, slotDeps, spec);
        deps.onStatus?.(`slot${i}:settled:${spec.id}`);
      } catch (e) {
        deps.onStatus?.(
          `slot${i}:error:${spec.id}:${String((e as Error)?.message ?? e)}`,
        );
      }
      gi = nextGameIndex(gi, games.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, (_, i) => slot(i)),
  );
  mp.close();
}
