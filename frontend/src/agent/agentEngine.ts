// Game-agnostic agent engine: rotate tunnel games, play each over the REAL relay + on-chain
// lifecycle via the protocol's randomMove, settle root-anchored through the backend (Walrus).
// Mirrors usePvpTicTacToe (the proven browser path) + pvpTttBot's auto-move loop — made
// React-free, generic over createBehaviorProtocol, and run as M concurrent slots per agent.
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
import { createBehaviorProtocol } from "sui-tunnel-ts/agents/behaviors";
import { MpClient, resolveMpWsUrl, type PvpChannel } from "../pvp/mpClient";
import { getControlPlaneClient, resolveBackendUrl } from "../backend/controlPlane";
import {
  closeCooperativeWithRoot,
  depositStake,
  openAndFundSharedTunnel,
  readCreatedAt,
  type SignExec,
  type SuiReads,
} from "../onchain/tunnelTx";
import { coSignedToSettleRequest } from "../backend/settleRequest";
import { AGENT_GAMES, nextGameIndex, type GameSpec } from "./agentConfig";

export interface AgentDeps {
  wallet: string; // programmatic wallet address
  signExec: SignExec; // dapp-kit wrapper -> programmatic wallet (popup-free)
  reads: SuiReads; // SuiClient
  onStatus?: (s: string) => void;
}

// The slice of a Protocol the engine needs; createBehaviorProtocol returns Protocol<unknown,*>.
interface Proto {
  randomMove?: (s: unknown, by: "A" | "B", rng: () => number) => unknown | null;
  isTerminal: (s: unknown) => boolean;
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

async function playOneMatch(mp: MpClient, deps: AgentDeps, spec: GameSpec): Promise<void> {
  const eph: KeyPair = generateKeyPair(); // per-slot move-signing key
  const match = await mp.quickMatch(spec.id);
  const channel = mp.channel(match.matchId);
  const waitPeer = makeInbox(channel);

  channel.sendPeer({ t: "hello", ephemeralPubkey: toHex(eph.publicKey) });
  const oppPub = fromHex((await waitPeer<{ ephemeralPubkey: string }>("hello")).ephemeralPubkey);

  // Fund: seat A opens + funds its seat in one tx then announces; seat B gated-deposits.
  let tunnelId: string;
  if (match.role === "A") {
    tunnelId = await openAndFundSharedTunnel({
      reads: deps.reads,
      signExec: deps.signExec,
      partyA: { address: deps.wallet, publicKey: eph.publicKey },
      partyB: { address: match.opponentWallet, publicKey: oppPub },
      amount: spec.stake,
    });
    mp.announceTunnel(match.matchId, tunnelId);
    channel.sendPeer({ t: "open", tunnelId });
  } else {
    tunnelId = (await waitPeer<{ tunnelId: string }>("open")).tunnelId;
    await depositStake({ signExec: deps.signExec, tunnelId, amount: spec.stake });
  }

  // Build the distributed engine over the relay transport; protocol chosen by game.
  const proto = createBehaviorProtocol(spec.behavior) as unknown as Proto;
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
    proto as never,
    { tunnelId, self, opponent: opp, selfParty: match.role },
    channel.transport,
    { a: spec.stake, b: spec.stake },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any;
  const transcript = new Transcript(tunnelId);

  // Auto-play: propose a random legal move whenever it is our turn (pvpTttBot's loop).
  const move = () => {
    if (proto.isTerminal(dt.state)) return;
    if (dt.state.turn === match.role) {
      const m = proto.randomMove?.(dt.state, match.role, Math.random);
      if (m) dt.propose(m, 0n);
    }
  };

  await new Promise<void>((resolve, reject) => {
    let settling = false;
    dt.onConfirmed = (u: CoSignedUpdate) => {
      transcript.append(u);
      if (proto.isTerminal(dt.state)) {
        if (settling) return;
        settling = true;
        settle(dt, match.role, channel, waitPeer, deps, tunnelId, transcript).then(resolve, reject);
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
    combineSettlementWithRoot: (s: SettlementHalf, a: Uint8Array, b: Uint8Array) => unknown;
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
    partyABalance: half.settlement.partyABalance.toString(),
    partyBBalance: half.settlement.partyBBalance.toString(),
    finalNonce: half.settlement.finalNonce.toString(),
    timestamp: half.settlement.timestamp.toString(),
    transcriptRoot: toHex(root),
    sig: toHex(half.sigSelf),
  });
  const other = await waitPeer<{ sig: string; transcriptRoot: string }>("settleHalf");
  if (other.transcriptRoot !== toHex(root)) {
    throw new Error("settlement transcript-root mismatch between parties");
  }
  const co = dt.combineSettlementWithRoot(half.settlement, half.sigSelf, fromHex(other.sig));
  if (role !== "A") return; // single submitter
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getControlPlaneClient().settle(tunnelId, coSignedToSettleRequest(co as any, transcript.toRecord().entries));
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await closeCooperativeWithRoot({ signExec: deps.signExec, tunnelId, settlement: co as any });
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
): Promise<void> {
  const connectKey = generateKeyPair(); // authenticates the one shared WS
  const mp = new MpClient(resolveMpWsUrl(resolveBackendUrl()), deps.wallet, connectKey);
  await mp.connect();

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

  const slot = async (i: number) => {
    let gi = i % AGENT_GAMES.length; // stagger starts so the fleet spreads across games
    while (!shouldStop()) {
      const spec = AGENT_GAMES[gi];
      deps.onStatus?.(`slot${i}:queue:${spec.id}`);
      try {
        await playOneMatch(mp, slotDeps, spec);
        deps.onStatus?.(`slot${i}:settled:${spec.id}`);
      } catch (e) {
        deps.onStatus?.(`slot${i}:error:${spec.id}:${String((e as Error)?.message ?? e)}`);
      }
      gi = nextGameIndex(gi, AGENT_GAMES.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_, i) => slot(i)));
  mp.close();
}
