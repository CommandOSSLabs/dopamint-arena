import { useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { otherParty } from "sui-tunnel-ts/protocol/Protocol";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import type { TelemetryWriter } from "../../telemetry/TelemetryProvider";
import {
  closeCooperativeWithRoot,
  openAndFundSelfPlay,
  readCreatedAt,
} from "../../onchain/tunnelTx";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { getControlPlaneClient } from "../../backend/controlPlane";
import { coSignedToSettleRequest } from "../../backend/settleRequest";
import { withSponsorFallback } from "../../onchain/sponsor";
import { useSponsoredSignExec } from "../../onchain/useSponsoredSignExec";
import { DOPAMINT_COIN_TYPE, isDopamintConfigured } from "../../onchain/dopamint";
import {
  BattleshipProtocol,
  type BattleshipMove,
  type BattleshipState,
} from "./protocol/battleship";
import { deriveBattleshipView, type BattleshipView } from "./view";
import { type Placement, placementsToBoard } from "./engine/fleet";
import { randomSalts } from "./engine/merkle";
import {
  type FleetSecret,
  makeFleetSecret,
  nextMove,
  randomFleetSecret,
} from "./engine/selfPlay";
import { type BotDifficulty, DEFAULT_BOT_DIFFICULTY } from "./engine/bot";

/** DOPAMINT stake locked per seat (1 DOPAMINT, 9 decimals). */
const LOCKED_PER_SEAT = 1_000_000_000n;
/** SUI-fallback stake per seat (MIST), when the DOPAMINT env is unset. */
const SUI_PER_SEAT = 500n;
const STAKE = 100n;
/** Animation pacing for the bot's automatic moves. */
const BOT_SHOOT_MS = 550;
const BOT_REVEAL_MS = 240;

export type BattleshipStatus =
  | "idle"
  | "placing"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface BattleshipSession {
  status: BattleshipStatus;
  view: BattleshipView | null;
  error: string | null;
  /** Enter fleet placement. */
  playBot: () => void;
  /** Commit the arranged fleet and start the match. */
  startBattle: (placements: Placement[]) => void;
  /** Fire at an enemy cell (only legal on your turn). */
  fire: (cell: number) => void;
  /** Set the foe bot's skill — applies to its next shot (safe to change mid-match). */
  setDifficulty: (difficulty: BotDifficulty) => void;
  reset: () => void;
}

/** React-supplied capabilities, refreshed each render (wallet may connect later). */
interface BotDeps {
  report: TelemetryWriter;
  account: { address: string } | null;
  client: unknown;
  signExec: (tx: never) => Promise<{ digest: string }>;
  /** Backend-gas-sponsored signer (ADR-0009); falls back to signExec when the sponsor is down. */
  sponsoredSignExec: (tx: never) => Promise<{ digest: string }>;
  /** Pick a user coin to fund the (both-seat) stake; gas is sponsored, the stake is not. */
  selectStakeCoin: (minAmount: bigint) => Promise<string>;
  /** DOPAMINT stake: faucet (invisibly, sponsored) if short, then return a stake coin id. */
  prepareStake: (minAmount: bigint) => Promise<string>;
}

interface BotSnapshot {
  status: BattleshipStatus;
  view: BattleshipView | null;
  error: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The bot game's whole session, kept OUT of React so it survives the window
 * unmounting (minimize / maximize / desktop reflow). The component subscribes to
 * it; only an explicit window close disposes it. See `lib/windowSessions`.
 */
class BotSession {
  deps: BotDeps | null = null;

  private status: BattleshipStatus = "idle";
  private view: BattleshipView | null = null;
  private error: string | null = null;
  private snap: BotSnapshot = { status: "idle", view: null, error: null };
  private listeners = new Set<() => void>();

  private tunnel: OffchainTunnel<BattleshipState, BattleshipMove> | null = null;
  private secrets: { A: FleetSecret; B: FleetSecret } | null = null;
  private placements: Placement[] = []; // your fleet layout, for ship-status display
  private tunnelId = "";
  private createdAt = 0n;
  private transcript: Transcript | null = null;
  private onChain = false;
  private advancing = false;
  // Guards re-entry: a session that has begun a match can't be restarted (only
  // reset()/Play Again returns it to idle). Stops StrictMode / double-click dupes.
  private starting = false;
  private txnId = 0;
  private lastYourShot: number | null = null;
  private lastEnemyShot: number | null = null;
  /** Foe bot skill; only affects shot selection, so it can change any time. */
  private difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY;
  // Bumped on reset/dispose so an in-flight bot loop knows to abandon ship.
  private gen = 0;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): BotSnapshot => this.snap;

  private emit() {
    this.snap = { status: this.status, view: this.view, error: this.error };
    for (const l of this.listeners) l();
  }
  private setStatus(s: BattleshipStatus) {
    this.status = s;
    this.emit();
  }
  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }
  private pushView() {
    if (this.tunnel && this.secrets) {
      this.view = deriveBattleshipView(
        this.tunnel.state,
        this.placements,
        "A",
        {
          lastYourShot: this.lastYourShot,
          lastEnemyShot: this.lastEnemyShot,
          onChain: this.onChain,
        },
      );
    }
    this.emit();
  }

  playBot = () => {
    this.gen += 1;
    this.error = null;
    this.view = null;
    this.setStatus("placing");
  };

  reset = () => {
    this.gen += 1;
    this.advancing = false;
    this.starting = false;
    this.tunnel = null;
    this.transcript = null;
    this.secrets = null;
    this.lastYourShot = null;
    this.lastEnemyShot = null;
    this.deps?.report.setActive(0);
    this.status = "idle";
    this.view = null;
    this.error = null;
    this.emit();
  };

  dispose = () => {
    this.gen += 1;
    this.advancing = false;
    this.deps?.report.setActive(0);
    this.tunnel = null;
    this.transcript = null;
    this.secrets = null;
    this.listeners.clear();
  };

  private reportShotTxn(
    move: Extract<BattleshipMove, { type: "reveal" }>,
    defender: "A" | "B",
  ) {
    const youFired = otherParty(defender) === "A";
    this.deps?.report.pushTxn({
      id: (this.txnId += 1),
      game: "battleship",
      time: new Date().toLocaleTimeString("en-GB"),
      bot: youFired ? "You" : "Foe Bot",
      type: move.isShip ? (youFired ? "Hit" : "Hit taken") : "Miss",
      status: "Success",
      amount: move.isShip
        ? `${youFired ? "+" : "-"}$${Number(STAKE)}.00`
        : "$0.00",
    });
  }

  private settle = async () => {
    const tunnel = this.tunnel;
    if (!tunnel) return;
    this.setStatus("settling");
    this.deps?.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
    this.deps?.report.setActive(0);
    if (!this.onChain || !this.deps) {
      this.setStatus("settled"); // demo: nothing to close on-chain
      return;
    }
    try {
      // Settle through the backend /settle API: the server submits the close AND archives the
      // transcript to Walrus (ADR-0002/0005). Fall back to a sponsored/wallet close if it's down.
      const transcript = this.transcript;
      const settlement = tunnel.buildSettlementWithRoot(
        this.createdAt,
        transcript ? transcript.root() : new Uint8Array(32),
        0n,
      );
      const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;
      try {
        await getControlPlaneClient().settle(
          this.tunnelId,
          coSignedToSettleRequest(
            settlement,
            transcript ? transcript.toRecord().entries : [],
          ),
        );
      } catch (e) {
        console.warn(
          "[battleship] backend settle failed; falling back to wallet close:",
          e,
        );
        // DOPAMINT path closes via the gas sponsor too (so a 0-SUI player can close their bot
        // game for free); SUI path closes sender-pays. coinType must match the tunnel's coin.
        await closeCooperativeWithRoot({
          signExec: (isDopamintConfigured
            ? this.deps.sponsoredSignExec
            : this.deps.signExec) as never,
          tunnelId: this.tunnelId,
          settlement,
          coinType,
        });
      }
      this.setStatus("settled");
    } catch (e) {
      this.fail(e);
    }
  };

  /** Drive every automatic move (bot commit, all reveals, bot shots) until the human's shot or game end. */
  private advance = async () => {
    if (this.advancing) return;
    this.advancing = true;
    const myGen = this.gen;
    const tunnel = this.tunnel;
    const secrets = this.secrets;
    try {
      while (tunnel && secrets) {
        const st = tunnel.state;
        if (st.winner !== 0) break;
        const driven = nextMove(st, secrets, Math.random, this.difficulty);
        if (!driven) break;
        if (driven.by === "A" && driven.move.type === "shoot") break; // human's turn
        if (driven.move.type === "shoot") {
          await sleep(BOT_SHOOT_MS);
          this.lastEnemyShot = driven.move.cell;
        } else if (driven.move.type === "reveal") {
          await sleep(BOT_REVEAL_MS);
        }
        if (this.gen !== myGen || this.tunnel !== tunnel) return; // reset/disposed mid-flight
        tunnel.step(driven.move, driven.by);
        if (driven.move.type === "reveal")
          this.reportShotTxn(driven.move, driven.by);
        this.pushView();
      }
      this.pushView();
      if (tunnel && tunnel.state.winner !== 0) await this.settle();
    } catch (e) {
      this.fail(e);
    } finally {
      this.advancing = false;
    }
  };

  startBattle = (placements: Placement[]) => {
    const deps = this.deps;
    if (!deps) return;
    // Only a fresh/placing session may start; a live game never restarts itself.
    if (this.starting || (this.status !== "idle" && this.status !== "placing"))
      return;
    this.starting = true;
    this.gen += 1;
    this.error = null;
    this.txnId = 0;
    this.lastYourShot = null;
    this.lastEnemyShot = null;

    this.placements = placements;
    const human = makeFleetSecret(placementsToBoard(placements), randomSalts());
    const bot = randomFleetSecret(Math.random);
    this.secrets = { A: human, B: bot };

    const a = createParticipant("you-seat");
    const b = createParticipant("foe-seat");
    const protocol = new BattleshipProtocol(STAKE);

    void (async () => {
      try {
        // The wire format reads the tunnel id as a 32-byte hex object id, so the
        // no-wallet demo needs a valid-looking one (not an arbitrary string).
        let tunnelId = `0x${toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)))}`;
        let createdAt = 0n;
        let onChain = false;

        // Per-path stake: 1 DOPAMINT vs a tiny MIST amount on the SUI fallback (so the fallback
        // doesn't lock real SUI). The same value funds on-chain AND inits the off-chain tunnel.
        const stakePerSeat = isDopamintConfigured ? LOCKED_PER_SEAT : SUI_PER_SEAT;

        if (deps.account) {
          const reads = deps.client as unknown as Parameters<
            typeof openAndFundSelfPlay
          >[0]["reads"];
          this.setStatus("funding");
          const partyA = { address: a.address, publicKey: a.keyPair.publicKey };
          const partyB = { address: b.address, publicKey: b.keyPair.publicKey };
          // DOPAMINT (ADR-0010): faucet both seats' stake invisibly (gas-sponsored) and stake
          // DOPAMINT — free for a 0-SUI player. SUI path (DOPAMINT env unset): sponsored SUI stake
          // with a sender-pays fallback (ADR-0009).
          tunnelId = isDopamintConfigured
            ? await openAndFundSelfPlay({
                reads,
                signExec: deps.sponsoredSignExec as never,
                partyA,
                partyB,
                aAmount: stakePerSeat,
                bAmount: stakePerSeat,
                coinType: DOPAMINT_COIN_TYPE,
                stakeCoinId: await deps.prepareStake(2n * stakePerSeat),
              })
            : await withSponsorFallback(
                async () =>
                  openAndFundSelfPlay({
                    reads,
                    signExec: deps.sponsoredSignExec as never,
                    partyA,
                    partyB,
                    aAmount: stakePerSeat,
                    bAmount: stakePerSeat,
                    stakeCoinId: await deps.selectStakeCoin(2n * stakePerSeat),
                  }),
                () =>
                  openAndFundSelfPlay({
                    reads,
                    signExec: deps.signExec as never,
                    partyA,
                    partyB,
                    aAmount: stakePerSeat,
                    bAmount: stakePerSeat,
                  }),
                "battleship bot open/fund",
              );
          createdAt = await readCreatedAt(reads, tunnelId);
          onChain = true;
        }

        const tunnel = OffchainTunnel.selfPlay(
          protocol,
          tunnelId,
          a.keyPair,
          b.keyPair,
          a.address,
          b.address,
          { a: stakePerSeat, b: stakePerSeat },
        );
        // Record every co-signed update so the close can anchor the transcript root on-chain
        // (close_cooperative_with_root) — the same settle path caro/poker/auto use successfully.
        const transcript = new Transcript(tunnelId);
        tunnel.onUpdate = (u, bytes) => {
          transcript.append(u);
          this.deps?.report.bumpCounters({
            updates: 1,
            signatures: 2,
            verifications: 2,
            bytes,
          });
        };

        this.tunnel = tunnel;
        this.transcript = transcript;
        this.tunnelId = tunnelId;
        this.createdAt = createdAt;
        this.onChain = onChain;
        this.deps?.report.bumpCounters({ tunnelsOpened: 1 });
        this.deps?.report.setActive(2);
        this.starting = false;
        this.setStatus("playing");
        this.pushView();
        void this.advance(); // commit A, commit B, then hand the turn to the human
      } catch (e) {
        this.starting = false;
        this.fail(e);
      }
    })();
  };

  setDifficulty = (difficulty: BotDifficulty) => {
    this.difficulty = difficulty;
  };

  fire = (cell: number) => {
    const tunnel = this.tunnel;
    if (!tunnel) return;
    const st = tunnel.state;
    if (
      st.phase !== "playing" ||
      st.pendingShot ||
      st.turn !== "A" ||
      st.winner !== 0
    ) {
      return;
    }
    if (st.shotsAtB.some((s) => s.cell === cell)) return;
    try {
      tunnel.step({ type: "shoot", cell }, "A");
      this.lastYourShot = cell;
      this.pushView();
      void this.advance();
    } catch (e) {
      this.fail(e);
    }
  };
}

const botSessions = new Map<string, BotSession>();

function getBotSession(windowId: string): BotSession {
  let session = botSessions.get(windowId);
  if (!session) {
    session = new BotSession();
    botSessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "battleship-bot", () => {
      created.dispose();
      botSessions.delete(windowId);
    });
  }
  return session;
}

export function useBattleship(windowId: string): BattleshipSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();

  const session = getBotSession(windowId);
  session.deps = {
    report,
    account,
    client,
    signExec: (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never,
    sponsoredSignExec: sponsored.signExec as never,
    selectStakeCoin: sponsored.selectStakeCoin,
    prepareStake: sponsored.prepareStake,
  };

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    status: snap.status,
    view: snap.view,
    error: snap.error,
    playBot: session.playBot,
    startBattle: session.startBattle,
    fire: session.fire,
    setDifficulty: session.setDifficulty,
    reset: session.reset,
  };
}
