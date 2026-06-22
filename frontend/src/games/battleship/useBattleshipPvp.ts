import { useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { registerWindowDisposer } from "@/lib/windowSessions";
import {
  BattleshipProtocol,
  battleshipMoveCodec,
  type BattleshipMove,
  type BattleshipState,
} from "./protocol/battleship";
import {
  MpClient,
  resolveMpWsUrl,
  type PvpChannel,
  type Role,
} from "../../pvp/mpClient";
import {
  getControlPlaneClient,
  resolveBackendUrl,
} from "../../backend/controlPlane";
import {
  closeCooperativeWithRoot,
  depositStake,
  openAndFundSharedTunnel,
  readCreatedAt,
} from "../../onchain/tunnelTx";
import { useSponsoredSignExec } from "../../onchain/useSponsoredSignExec";
import { withSponsorFallback } from "../../onchain/sponsor";
import { coSignedToSettleRequest } from "../../backend/settleRequest";
import { type FleetSecret, makeFleetSecret } from "./engine/selfPlay";
import { type Placement, placementsToBoard } from "./engine/fleet";
import { randomSalts } from "./engine/merkle";
import { proposeDue } from "./engine/pvpDriver";
import { deriveBattleshipView, type BattleshipView } from "./view";

const STAKE_BALANCE = 500n; // locked per seat (MIST)
const STAKE_SHIFT = 100n; // moves loser → winner on a decisive result

export type PvpStatus =
  | "idle"
  | "matching"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface BattleshipPvp {
  status: PvpStatus;
  role: Role | null;
  view: BattleshipView | null;
  opponentWallet: string | null;
  error: string | null;
  /** Commit the placed fleet and join matchmaking. */
  findMatch: (placements: Placement[]) => void;
  fire: (cell: number) => void;
  reset: () => void;
}

type BattleshipTunnel = DistributedTunnel<BattleshipState, BattleshipMove>;

interface PvpDeps {
  account: { address: string } | null;
  client: unknown;
  /** Wallet sender-pays signer — used for the close fallback (close is sponsored via /settle). */
  signExec: (tx: never) => Promise<{ digest: string }>;
  /** Backend-gas-sponsored signer (ADR-0009) — used for the open/fund tx. */
  sponsoredSignExec: (tx: never) => Promise<{ digest: string }>;
  /** Pick a user coin to fund this seat's stake (gas is sponsored, the stake is not). */
  selectStakeCoin: (minAmount: bigint) => Promise<string>;
}

interface PvpSnapshot {
  status: PvpStatus;
  role: Role | null;
  view: BattleshipView | null;
  opponentWallet: string | null;
  error: string | null;
}

/** Buffer peer messages so a waiter never misses one that arrived early. */
function makeInbox(channel: PvpChannel) {
  const buf = new Map<string, unknown>();
  const waiters = new Map<string, (m: unknown) => void>();
  channel.onPeer((m) => {
    const w = waiters.get(m.t);
    if (w) {
      waiters.delete(m.t);
      w(m);
    } else {
      buf.set(m.t, m);
    }
  });
  return <T = unknown>(t: string): Promise<T> =>
    new Promise((res) => {
      const b = buf.get(t);
      if (b) {
        buf.delete(t);
        res(b as T);
      } else {
        waiters.set(t, res as (m: unknown) => void);
      }
    });
}

/**
 * A PvP match's whole session — matchmaking socket, tunnel, fleet secret — kept
 * OUT of React so a minimized or reflowed window stays CONNECTED in the
 * background instead of dropping the opponent. The component subscribes; only an
 * explicit window close disposes it. See `lib/windowSessions`.
 */
class PvpSession {
  deps: PvpDeps | null = null;

  private status: PvpStatus = "idle";
  private role: Role | null = null;
  private view: BattleshipView | null = null;
  private opponentWallet: string | null = null;
  private error: string | null = null;
  private snap: PvpSnapshot = {
    status: "idle",
    role: null,
    view: null,
    opponentWallet: null,
    error: null,
  };
  private listeners = new Set<() => void>();

  private mp: MpClient | null = null;
  private dt: BattleshipTunnel | null = null;
  private secret: FleetSecret | null = null;
  private placements: Placement[] = []; // your fleet layout, for ship-status display
  private lastYourShot: number | null = null;
  private lastEnemyShot: number | null = null;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): PvpSnapshot => this.snap;

  private emit() {
    this.snap = {
      status: this.status,
      role: this.role,
      view: this.view,
      opponentWallet: this.opponentWallet,
      error: this.error,
    };
    for (const l of this.listeners) l();
  }
  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }
  private sync = () => {
    if (this.dt && this.secret && this.role) {
      this.view = deriveBattleshipView(
        this.dt.displayState,
        this.placements,
        this.role,
        {
          lastYourShot: this.lastYourShot,
          lastEnemyShot: this.lastEnemyShot,
          onChain: true,
        },
      );
    }
    this.emit();
  };

  reset = () => {
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.secret = null;
    this.role = null;
    this.lastYourShot = null;
    this.lastEnemyShot = null;
    this.status = "idle";
    this.view = null;
    this.opponentWallet = null;
    this.error = null;
    this.emit();
  };

  dispose = () => {
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.secret = null;
    this.listeners.clear();
  };

  findMatch = (placements: Placement[]) => {
    const deps = this.deps;
    if (!deps?.account) {
      this.error = "connect a wallet first";
      this.status = "error";
      this.emit();
      return;
    }
    const wallet = deps.account.address;
    this.placements = placements;
    const secret = makeFleetSecret(
      placementsToBoard(placements),
      randomSalts(),
    );
    this.secret = secret;
    const signExec = deps.signExec;
    const sponsoredSignExec = deps.sponsoredSignExec;
    const reads = deps.client as unknown as Parameters<
      typeof openAndFundSharedTunnel
    >[0]["reads"];

    void (async () => {
      try {
        this.error = null;
        this.status = "matching";
        this.emit();
        const ephemeral: KeyPair = generateKeyPair();
        const mp = new MpClient(
          resolveMpWsUrl(resolveBackendUrl()),
          wallet,
          ephemeral,
        );
        this.mp = mp;
        await mp.connect();
        const match = await mp.quickMatch("battleship");
        this.role = match.role;
        this.opponentWallet = match.opponentWallet;
        this.emit();

        const channel = mp.channel(match.matchId);
        const waitPeer = makeInbox(channel);

        // 1) exchange ephemeral pubkeys (wallet is only the matchmaking label).
        channel.sendPeer({
          t: "hello",
          ephemeralPubkey: toHex(ephemeral.publicKey),
        });
        const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
        const oppPub = fromHex(hello.ephemeralPubkey);

        // 2) fund on-chain: try the backend gas sponsor (settler pays gas; the stake splits off a
        //    user coin), and if the sponsor is unavailable fall back to the wallet paying its own
        //    gas (the stake then splits off the gas coin — needs SUI in the wallet). ADR-0009.
        this.status = "funding";
        this.emit();
        const partyA = { address: wallet, publicKey: ephemeral.publicKey };
        const partyB = { address: match.opponentWallet, publicKey: oppPub };
        let tunnelId: string;
        if (match.role === "A") {
          tunnelId = await withSponsorFallback(
            async () =>
              openAndFundSharedTunnel({
                reads,
                signExec: sponsoredSignExec as never,
                partyA,
                partyB,
                amount: STAKE_BALANCE,
                stakeCoinId: await deps.selectStakeCoin(STAKE_BALANCE),
              }),
            () =>
              openAndFundSharedTunnel({
                reads,
                signExec: signExec as never,
                partyA,
                partyB,
                amount: STAKE_BALANCE,
              }),
            "battleship open/fund",
          );
          mp.announceTunnel(match.matchId, tunnelId);
          channel.sendPeer({ t: "open", tunnelId });
        } else {
          const open = await waitPeer<{ tunnelId: string }>("open");
          tunnelId = open.tunnelId;
          await withSponsorFallback(
            async () =>
              depositStake({
                signExec: sponsoredSignExec as never,
                tunnelId,
                amount: STAKE_BALANCE,
                stakeCoinId: await deps.selectStakeCoin(STAKE_BALANCE),
              }),
            () =>
              depositStake({
                signExec: signExec as never,
                tunnelId,
                amount: STAKE_BALANCE,
              }),
            "battleship deposit",
          );
        }

        // 3) build the distributed engine over the relay transport.
        const proto = new BattleshipProtocol(STAKE_SHIFT);
        const backend = defaultBackend();
        const self = makeEndpoint(backend, wallet, ephemeral, true);
        const opp = makeEndpoint(
          backend,
          match.opponentWallet,
          { publicKey: oppPub, scheme: ephemeral.scheme },
          false,
        );
        const dt = new DistributedTunnel<BattleshipState, BattleshipMove>(
          proto,
          {
            tunnelId,
            self,
            opponent: opp,
            selfParty: match.role,
            moveCodec: battleshipMoveCodec,
          },
          channel.transport,
          { a: STAKE_BALANCE, b: STAKE_BALANCE },
        );
        this.dt = dt;
        const transcript = new Transcript(tunnelId);

        let settling = false;
        dt.onConfirmed = (u) => {
          transcript.append(u); // verifiable move log, root-anchored at settle
          const st = dt.state;
          if (st.pendingShot && st.pendingShot.by !== match.role) {
            this.lastEnemyShot = st.pendingShot.cell;
          }
          this.sync();
          proposeDue(dt, match.role, secret); // ordered commit + defender reveals
          if (proto.isTerminal(st) && !settling) {
            settling = true;
            this.status = "settling";
            this.emit();
            void settle(
              dt,
              match.role,
              channel,
              waitPeer,
              reads,
              signExec as never,
              tunnelId,
              transcript,
              getControlPlaneClient(),
            ).then(
              () => {
                this.status = "settled";
                this.emit();
              },
              (e) => this.fail(e),
            );
          }
        };

        // 4) readiness handshake before the opening commit can reach the peer.
        this.status = "playing";
        this.sync();
        if (match.role === "A") {
          await waitPeer("ready");
        } else {
          channel.sendPeer({ t: "ready" });
        }
        proposeDue(dt, match.role, secret); // kick off the ordered commits
        this.sync();
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  fire = (cell: number) => {
    const dt = this.dt;
    const r = this.role;
    if (!dt || !r) return;
    const st = dt.state;
    if (
      st.phase !== "playing" ||
      st.pendingShot ||
      st.turn !== r ||
      st.winner !== 0
    ) {
      return;
    }
    const atOpponent = r === "A" ? st.shotsAtB : st.shotsAtA;
    if (atOpponent.some((s) => s.cell === cell)) return;
    try {
      dt.propose({ type: "shoot", cell }, 0n);
      this.lastYourShot = cell;
      this.sync();
    } catch (e) {
      this.fail(e);
    }
  };
}

const pvpSessions = new Map<string, PvpSession>();

function getPvpSession(windowId: string): PvpSession {
  let session = pvpSessions.get(windowId);
  if (!session) {
    session = new PvpSession();
    pvpSessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "battleship-pvp", () => {
      created.dispose();
      pvpSessions.delete(windowId);
    });
  }
  return session;
}

export function useBattleshipPvp(windowId: string): BattleshipPvp {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();

  const session = getPvpSession(windowId);
  session.deps = {
    account,
    client,
    signExec: (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never,
    // Open/fund routes through the backend gas sponsor (ADR-0009): the settler pays gas, the
    // stake stays the user's own coin. (Close keeps signExec above — it's sponsored via /settle.)
    sponsoredSignExec: sponsored.signExec as never,
    selectStakeCoin: sponsored.selectStakeCoin,
  };

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    status: snap.status,
    role: snap.role,
    view: snap.view,
    opponentWallet: snap.opponentWallet,
    error: snap.error,
    findMatch: session.findMatch,
    fire: session.fire,
    reset: session.reset,
  };
}

/**
 * Exchange root-anchored settlement halves over the relay, then seat A submits the
 * close via the backend /settle (falling back to a wallet close if it's down). Both
 * seats MUST anchor the same transcript root, else close_cooperative_with_root
 * rebuilds different bytes and on-chain verify fails — so roots are asserted equal.
 */
async function settle(
  dt: BattleshipTunnel,
  role: Role,
  channel: PvpChannel,
  waitPeer: <T>(t: string) => Promise<T>,
  reads: Parameters<typeof readCreatedAt>[0],
  signExec: Parameters<typeof closeCooperativeWithRoot>[0]["signExec"],
  tunnelId: string,
  transcript: Transcript,
  cp: ReturnType<typeof getControlPlaneClient>,
): Promise<void> {
  const createdAt = await readCreatedAt(reads, tunnelId);
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
  if (role !== "A") return; // single submitter, mirrors the cooperative-close pattern
  try {
    await cp.settle(
      tunnelId,
      coSignedToSettleRequest(co, transcript.toRecord().entries),
    );
  } catch (e) {
    console.error(
      "[battleship] backend settle failed; falling back to wallet close:",
      e,
    );
    await closeCooperativeWithRoot({ signExec, tunnelId, settlement: co });
  }
}
