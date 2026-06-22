import { useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import {
  QuantumPokerProtocol,
  type PokerMove,
  type PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { registerWindowDisposer } from "@/lib/windowSessions";
import {
  openAndFundSelfPlayReturnless,
  readCreatedAt,
  type SignExec,
  type SuiReads,
} from "@/onchain/tunnelTx";
import { QUANTUM_POKER_STAKE, QUANTUM_POKER_HAND_CAP } from "./constants";
import {
  makeSeatBot,
  randomPokerPersona,
  stepPokerWithHuman,
  applyHumanMove,
  legalPokerActions,
  LIVE_BOT_CONTEXT,
  type PokerSeatBot,
  type PokerTunnel,
  type PokerLegalActions,
} from "./pokerSelfPlay";
import { settlePokerTunnel } from "./pokerSettle";

const STAKE = QUANTUM_POKER_STAKE;
const HAND_CAP = QUANTUM_POKER_HAND_CAP;
const AUTO_MS = 45; // pacing between auto moves
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type QuantumPokerBotStatus =
  | "idle"
  | "funding"
  | "playing"
  | "awaitHuman"
  | "settling"
  | "settled"
  | "error";

export interface QuantumPokerBotSession {
  status: QuantumPokerBotStatus;
  state: PokerState | null;
  humanHoles: number[];
  legal: PokerLegalActions | null;
  error: string | null;
  open: () => void;
  act: (move: PokerMove) => void;
  reset: () => void;
}

interface BotDeps {
  account: { address: string } | null;
  client: unknown;
  signExec: SignExec;
}

interface Snap {
  status: QuantumPokerBotStatus;
  state: PokerState | null;
  humanHoles: number[];
  legal: PokerLegalActions | null;
  error: string | null;
}

const HUMAN: "A" = "A";

class BotSession {
  deps: BotDeps | null = null;

  private status: QuantumPokerBotStatus = "idle";
  private error: string | null = null;
  private snap: Snap = {
    status: "idle",
    state: null,
    humanHoles: [],
    legal: null,
    error: null,
  };
  private listeners = new Set<() => void>();

  private tunnel: PokerTunnel | null = null;
  private transcript: Transcript | null = null;
  private botA: PokerSeatBot | null = null;
  private botB: PokerSeatBot | null = null;
  private tunnelId = "";
  private createdAt = 0n;
  private ts = 1n;
  private gen = 0;
  private looping = false;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };
  getSnapshot = (): Snap => this.snap;

  private emit() {
    const s = this.tunnel?.state ?? null;
    this.snap = {
      status: this.status,
      state: s,
      // In self-play the tunnel state holds party A's local holeA directly.
      humanHoles: s ? (s.holeA ?? s.shownHoleA ?? []) : [],
      legal:
        this.status === "awaitHuman" && s ? legalPokerActions(s, HUMAN) : null,
      error: this.error,
    };
    for (const l of this.listeners) l();
  }

  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  reset = () => {
    this.gen += 1;
    this.looping = false;
    this.tunnel = null;
    this.transcript = null;
    this.botA = null;
    this.botB = null;
    this.status = "idle";
    this.error = null;
    this.emit();
  };

  dispose = () => {
    this.gen += 1;
    this.looping = false;
    this.listeners.clear();
  };

  open = () => {
    const deps = this.deps;
    if (!deps) return;
    if (
      this.status !== "idle" &&
      this.status !== "settled" &&
      this.status !== "error"
    )
      return;
    if (!deps.account) {
      this.fail("connect a wallet to stake the tunnel");
      return;
    }
    this.gen += 1;
    const myGen = this.gen;
    this.error = null;
    this.status = "funding";
    this.emit();

    void (async () => {
      try {
        const a = createParticipant("poker-you");
        const b = createParticipant("poker-foe");
        const reads = deps.client as unknown as SuiReads;
        const tunnelId = await openAndFundSelfPlayReturnless({
          reads,
          signExec: deps.signExec,
          partyA: { address: a.address, publicKey: a.keyPair.publicKey },
          partyB: { address: b.address, publicKey: b.keyPair.publicKey },
          aAmount: STAKE,
          bAmount: STAKE,
        });
        if (this.gen !== myGen) return;
        const createdAt = await readCreatedAt(reads, tunnelId);
        if (this.gen !== myGen) return;

        const tunnel: PokerTunnel = OffchainTunnel.selfPlay(
          new QuantumPokerProtocol(HAND_CAP),
          tunnelId,
          a.keyPair,
          b.keyPair,
          a.address,
          b.address,
          { a: STAKE, b: STAKE },
        );
        const transcript = new Transcript(tunnelId);
        tunnel.onUpdate = (u) => transcript.append(u);

        this.tunnel = tunnel;
        this.transcript = transcript;
        this.tunnelId = tunnelId;
        this.createdAt = createdAt;
        this.ts = 1n;
        this.botA = makeSeatBot(
          "A",
          STAKE,
          HAND_CAP,
          randomPokerPersona(Math.random),
          LIVE_BOT_CONTEXT,
        );
        this.botB = makeSeatBot(
          "B",
          STAKE,
          HAND_CAP,
          randomPokerPersona(Math.random),
          LIVE_BOT_CONTEXT,
        );
        this.status = "playing";
        this.emit();
        void this.drive(myGen);
      } catch (e) {
        if (this.gen === myGen) this.fail(e);
      }
    })();
  };

  /** Auto-run moves until the human must act, the tunnel ends, or gen changes. */
  private drive = async (myGen: number) => {
    if (this.looping) return;
    this.looping = true;
    try {
      const tunnel = this.tunnel;
      const botA = this.botA;
      const botB = this.botB;
      if (!tunnel || !botA || !botB) return;
      while (this.gen === myGen) {
        const r = stepPokerWithHuman(tunnel, botA, botB, HUMAN, this.ts++);
        if (r.kind === "await-human") {
          this.status = "awaitHuman";
          this.emit();
          return;
        }
        if (r.kind === "idle") break; // terminal
        this.emit();
        await sleep(AUTO_MS);
      }
      if (this.gen === myGen) await this.settle(myGen);
    } catch (e) {
      if (this.gen === myGen) this.fail(e);
    } finally {
      this.looping = false;
    }
  };

  act = (move: PokerMove) => {
    const tunnel = this.tunnel;
    const botA = this.botA;
    if (!tunnel || !botA || this.status !== "awaitHuman") return;
    const myGen = this.gen;
    try {
      applyHumanMove(tunnel, botA, HUMAN, move, this.ts++);
      this.status = "playing";
      this.emit();
      void this.drive(myGen);
    } catch (e) {
      this.fail(e);
    }
  };

  private settle = async (myGen: number) => {
    const tunnel = this.tunnel;
    const transcript = this.transcript;
    const deps = this.deps;
    if (!tunnel || !transcript || !deps) return;
    this.status = "settling";
    this.emit();
    try {
      await settlePokerTunnel({
        tunnel,
        transcript,
        tunnelId: this.tunnelId,
        createdAt: this.createdAt,
        fallbackSignExec: deps.signExec,
      });
      if (this.gen !== myGen) return;
      this.status = "settled";
      this.emit();
    } catch (e) {
      if (this.gen === myGen) this.fail(e);
    }
  };
}

const sessions = new Map<string, BotSession>();

function getSession(windowId: string): BotSession {
  let s = sessions.get(windowId);
  if (!s) {
    s = new BotSession();
    sessions.set(windowId, s);
    const created = s;
    registerWindowDisposer(windowId, "quantum-poker-bot", () => {
      created.dispose();
      sessions.delete(windowId);
    });
  }
  return s;
}

export function useQuantumPokerBot(windowId: string): QuantumPokerBotSession {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync } = useSignAndExecuteTransaction();
  const session = getSession(windowId);
  session.deps = {
    account,
    client,
    signExec: (async (tx) => {
      const r = await mutateAsync({ transaction: tx });
      return { digest: r.digest };
    }) as SignExec,
  };
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snap,
    open: session.open,
    act: session.act,
    reset: session.reset,
  };
}
