import { useCallback, useRef, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  ed25519Address,
  generateKeyPair,
  type KeyPair,
} from "sui-tunnel-ts/core/crypto";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import {
  QuantumPokerProtocol,
  type PokerMove,
  type PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import {
  JULES_PROFILE,
  NARI_PROFILE,
  QuantumPokerPersonaDriver,
} from "sui-tunnel-ts/protocol/quantumPokerPersona";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import { getControlPlaneClient } from "../../backend/controlPlane";
import { coSignedToSettleRequest } from "../../backend/settleRequest";
import {
  closeCooperativeWithRoot,
  openAndFundSelfPlay,
  readCreatedAt,
} from "../../onchain/tunnelTx";
import {
  BET_PHASES,
  HAND_CAP,
  legalFor,
  plumbingProposer,
  stakePerSeatMist,
  type PvpPokerLegal,
  type PvpPokerStatus,
} from "./usePvpQuantumPoker";
import {
  loadOrCreateBots,
  getSuiClient,
  botBalances,
  buildFundTx,
} from "./pokerBots";

/** Bot lane is on-chain self-play (one funder funds both seats in one tx, like Blackjack) but the
 *  off-chain hand is driven locally by the persona bots. `vsBot` lets the human hold seat A and the
 *  connected wallet funds two ephemeral seats; `auto` runs Nari vs Jules with no human, with two
 *  PERSISTENT localStorage bots as the on-chain parties (no ephemeral keys, no sweep). */
export type BotPokerMode = "vsBot" | "auto";

/** Below this (MIST) a bot can't safely fund both stakes + cover gas for a game, so AUTO tops the
 *  bots up from the connected wallet first. Both stakes (2×perSeat) plus gas headroom; sized like
 *  Blackjack's MIN_PLAY_MIST against the default per-seat stake. */
const AUTO_MIN_GAS_MIST = 30_000_000n;

/** Counts AUTO games started this session so the funder (who funds BOTH seats in one tx) alternates
 *  between the two persistent bots — it pays both stakes upfront but only its own seat returns at
 *  close, so alternating keeps that transfer from steadily draining one wallet into the other. */
let autoGameCount = 0;

/** The human always sits at A in vs-bot; the bot drives B (and all of A's plumbing). */
const HUMAN: Party = "A";
/** Bot lane runs instant — 0ms between steps (still via setTimeout so each tick yields and the UI
 *  stays responsive) to maximize off-chain tx throughput; bot-vs-bot benchmarks the co-sign path. */
const BOT_STEP_MS = 0;

/** Crypto-strong [0,1) source for commit secrets + bot decisions. */
const secureRng = (): number => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
};

export interface BotQuantumPoker {
  status: PvpPokerStatus;
  mode: BotPokerMode | null;
  selfParty: Party | null;
  state: PokerState | null;
  myHole: number[] | null;
  myTurnToBet: boolean;
  legal: PvpPokerLegal | null;
  /** Always null — the bot lane has no per-turn countdown; present for table-render parity. */
  secondsLeft: number | null;
  /** Always null — no remote opponent; present for table-render parity. */
  opponentWallet: string | null;
  error: string | null;
  start: (mode: BotPokerMode, topUpSui?: number) => void;
  /** Seed the persistent AUTO bots from the wallet (separate step, fires the wallet popup).
   *  `onFunded` runs once the funding has landed — pass it to chain straight into a game. */
  fundBots: (topUpSui?: number, onFunded?: () => void) => void;
  fundingBots: boolean;
  fold: () => void;
  check: () => void;
  call: () => void;
  bet: (amount: bigint) => void;
  endRequested: boolean;
  requestSettle: () => void;
  reset: () => void;
}

/** After settle, seat B's payout sits at a throwaway ephemeral address — sweep the whole coin back
 *  to the funder (gas is taken from it). Skips when seat B ended with nothing. Needs the stake to
 *  exceed gas, which the top-up provides; the bot key signs via a standalone JSON-RPC client. */
async function sweepToFunder(
  ephB: KeyPair,
  ephBAddr: string,
  funder: string,
  balanceB: bigint,
): Promise<void> {
  if (balanceB === 0n) return;
  const client = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl("testnet"),
    network: "testnet",
  });
  // The close's effects can lag the RPC view; poll a few times for seat B's coin to land.
  for (let i = 0; i < 8; i++) {
    const bal = BigInt(
      (await client.getBalance({ owner: ephBAddr })).totalBalance,
    );
    if (bal > 0n) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tx = new Transaction();
  tx.transferObjects([tx.gas], funder); // send the whole returned-stake coin; gas auto-deducted
  await client.signAndExecuteTransaction({
    signer: Ed25519Keypair.fromSecretKey(ephB.secretKey),
    transaction: tx,
  });
}

export function useBotQuantumPoker(): BotQuantumPoker {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const { report } = useTelemetry();

  const [status, setStatus] = useState<PvpPokerStatus>("idle");
  const [mode, setMode] = useState<BotPokerMode | null>(null);
  const [state, setState] = useState<PokerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [endRequested, setEndRequested] = useState(false);
  const [fundingBots, setFundingBots] = useState(false);

  const tunnelRef = useRef<OffchainTunnel<PokerState, PokerMove> | null>(null);
  const timerRef = useRef<number | null>(null);
  const settlingRef = useRef(false);
  const endRef = useRef(false);
  const modeRef = useRef<BotPokerMode | null>(null);
  // Set inside start(): the human seat's move applier and the loop pump, reachable from the
  // exposed fold/check/call/bet + requestSettle callbacks.
  const humanActRef = useRef<((m: PokerMove) => void) | null>(null);
  const pumpRef = useRef<(() => void) | null>(null);

  const clearTimer = () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const reset = useCallback(() => {
    clearTimer();
    tunnelRef.current = null;
    settlingRef.current = false;
    endRef.current = false;
    modeRef.current = null;
    humanActRef.current = null;
    pumpRef.current = null;
    setStatus("idle");
    setMode(null);
    setState(null);
    setError(null);
    setEndRequested(false);
  }, []);

  const start = useCallback(
    (chosen: BotPokerMode, topUpSui?: number) => {
      if (!account) {
        setError("connect a wallet to stake the tunnel");
        setStatus("error");
        return;
      }
      // Wallet-signed exec (dapp-kit popup) — used by vsBot to fund the seats + close.
      const walletSignExec = async (
        tx: Parameters<typeof signAndExecute>[0]["transaction"],
      ) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      };

      (async () => {
        try {
          setError(null);
          setMode(chosen);
          modeRef.current = chosen;
          endRef.current = false;
          settlingRef.current = false;

          // Open + fund BOTH seats in ONE signature; play runs off-chain. Two keys co-sign the
          // hand. The seat layout, who funds, and how the close/cleanup runs differ by mode:
          //  - vsBot: ephemeral keys; seat A's on-chain ADDRESS is the connected wallet (the funder),
          //    so close pays seat A straight back to it; seat B is a throwaway whose balance is swept
          //    back to the funder after settle. The wallet signs the funding tx + close — never per-move.
          //  - auto: two PERSISTENT bots ARE the on-chain parties. The connected wallet only tops the
          //    bots up with gas if low (one popup, reused across games); the funder bot then signs
          //    create_and_fund AND the close fallback with its OWN keypair via a standalone client (no
          //    popup). Stakes stay in the two bot wallets and recycle — no sweep.
          setStatus("funding");
          const perSeat = stakePerSeatMist(topUpSui);

          let coreKeyA: KeyPair;
          let coreKeyB: KeyPair;
          let addrA: string;
          let addrB: string;
          // Standalone-client read surface + sign+exec for opening/closing without a wallet popup.
          let reads: Parameters<typeof openAndFundSelfPlay>[0]["reads"];
          let openSignExec: typeof walletSignExec;
          let closeSignExec: typeof walletSignExec;
          // Post-settle cleanup: vsBot sweeps seat B's payout to the funder; auto leaves it in place.
          let afterSettle: (balanceB: bigint) => Promise<void>;

          if (chosen === "auto") {
            const bots = loadOrCreateBots();
            const botClient = getSuiClient();
            // The bots must already hold their stake + gas. Funding is a SEPARATE user step (the
            // "Fund bots" button → fundBots) so the wallet popup fires inside the click gesture;
            // here we only verify and bail with a clear message if they're short.
            const need = 2n * perSeat + AUTO_MIN_GAS_MIST;
            const bal = await botBalances(botClient, bots);
            if (bal.a < need || bal.b < need) {
              // Not a dead error — drop back to the lobby with a hint so one tap on "Fund bots"
              // (which keeps the wallet-popup gesture) gets the user straight into a game.
              setError("Fund the bots first to start a game.");
              setStatus("idle");
              return;
            }

            // The funder funds BOTH seats in one tx; it alternates per game so paying both stakes
            // upfront doesn't steadily drain one wallet into the other over a long session.
            const funderBot = autoGameCount % 2 === 0 ? bots.a : bots.b;
            autoGameCount += 1;

            coreKeyA = bots.a.coreKey;
            coreKeyB = bots.b.coreKey;
            addrA = bots.a.address;
            addrB = bots.b.address;
            reads = botClient as unknown as Parameters<
              typeof openAndFundSelfPlay
            >[0]["reads"];
            const botSignExec = async (tx: Transaction) => {
              const r = await botClient.signAndExecuteTransaction({
                signer: funderBot.keypair,
                transaction: tx,
                options: { showEffects: true },
              });
              if (r.effects?.status?.status !== "success") {
                throw new Error(
                  `bot tx ${r.digest} failed: ${r.effects?.status?.error ?? "unknown"}`,
                );
              }
              await botClient.waitForTransaction({ digest: r.digest });
              return { digest: r.digest };
            };
            openSignExec = botSignExec as never;
            closeSignExec = botSignExec as never;
            afterSettle = async () => {}; // funds stay in the two bot wallets and recycle
          } else {
            const funder = account.address;
            const ephA = generateKeyPair();
            const ephB = generateKeyPair();
            const ephBAddr = ed25519Address(ephB.publicKey);
            coreKeyA = ephA;
            coreKeyB = ephB;
            addrA = funder;
            addrB = ephBAddr;
            reads = client as unknown as Parameters<
              typeof openAndFundSelfPlay
            >[0]["reads"];
            openSignExec = walletSignExec;
            closeSignExec = walletSignExec;
            afterSettle = (balanceB: bigint) =>
              sweepToFunder(ephB, ephBAddr, funder, balanceB);
          }

          // Top-up split evenly → perSeat each; the funder funds both halves in one signature.
          const tunnelId = await openAndFundSelfPlay({
            reads,
            signExec: openSignExec,
            partyA: { address: addrA, publicKey: coreKeyA.publicKey },
            partyB: { address: addrB, publicKey: coreKeyB.publicKey },
            aAmount: perSeat,
            bAmount: perSeat,
          });
          const createdAt = await readCreatedAt(reads, tunnelId);

          const proto = new QuantumPokerProtocol(HAND_CAP);
          const tunnel = OffchainTunnel.selfPlay(
            proto,
            tunnelId,
            coreKeyA,
            coreKeyB,
            addrA,
            addrB,
            { a: perSeat, b: perSeat },
          );
          const transcript = new Transcript(tunnelId);
          // Report off-chain actions to the backend (registerSession + periodic heartbeats) so the
          // live Total Actions / TPS climb after each tunnel — mirrors the Blackjack bot. Without
          // this the updates only hit LOCAL telemetry and the dashboard stays at 0.
          const cp = getControlPlaneClient();
          let statsSession: Awaited<
            ReturnType<typeof cp.registerSession>
          > | null = null;
          let actionsAccum = 0;
          let moveCount = 0;
          let lastBeat = Date.now();
          const flushHeartbeat = (force: boolean) => {
            if (
              !statsSession ||
              (!force && (Date.now() - lastBeat < 1000 || actionsAccum === 0))
            )
              return;
            const windowMs = Math.max(1, Date.now() - lastBeat);
            const actionsDelta = actionsAccum;
            actionsAccum = 0;
            lastBeat = Date.now();
            void cp
              .sendHeartbeat(statsSession.sessionId, statsSession.statsToken, {
                tunnelId,
                nonce: String(moveCount),
                actionsDelta,
                windowMs,
              })
              .catch(() => {});
          };
          tunnel.onUpdate = (u, bytes) => {
            transcript.append(u);
            moveCount += 1;
            actionsAccum += 1;
            flushHeartbeat(false);
            report.bumpCounters({
              updates: 1,
              signatures: 2,
              verifications: 2,
              bytes,
            });
          };
          tunnelRef.current = tunnel;
          report.bumpCounters({ tunnelsOpened: 1 });
          // Register the session up front (await) so heartbeats have a token before play starts;
          // best-effort — a failure just means this tunnel's actions won't show in the stats.
          try {
            statsSession = await cp.registerSession({
              userAddress: addrA,
              game: "quantum_poker",
              tunnels: [{ tunnelId, partyA: addrA, partyB: addrB }],
            });
          } catch (e) {
            console.error("[poker-bot] registerSession failed:", e);
          }

          // Nari (A) vs Jules (B) drive plumbing for both seats + betting for bot seats.
          const driverA = new QuantumPokerPersonaDriver("A", NARI_PROFILE);
          const driverB = new QuantumPokerPersonaDriver("B", JULES_PROFILE);
          const sync = () => setState({ ...tunnel.state });
          const settle = () => {
            if (settlingRef.current) return;
            settlingRef.current = true;
            clearTimer();
            setStatus("settling");
            sync();
            flushHeartbeat(true); // upload this tunnel's remaining off-chain actions before close
            (async () => {
              try {
                // Root-anchored settle through the backend /settle (sponsors gas, archives the
                // transcript); close_cooperative_with_root is the fallback — signed by the wallet
                // (vsBot) or the funder bot's own keypair (auto), per `closeSignExec`. Each seat's
                // balance returns to its on-chain address; vsBot then sweeps seat B's throwaway
                // payout back to the funder, auto leaves both in the bot wallets (afterSettle).
                const co = tunnel.buildSettlementWithRoot(
                  createdAt,
                  transcript.root(),
                );
                try {
                  await cp.settle(
                    tunnelId,
                    coSignedToSettleRequest(co, transcript.toRecord().entries),
                  );
                } catch (e) {
                  console.error(
                    "[poker-bot] /settle failed; close fallback:",
                    e,
                  );
                  await closeCooperativeWithRoot({
                    signExec: closeSignExec,
                    tunnelId,
                    settlement: co,
                  });
                }
                await afterSettle(co.settlement.partyBBalance);
                setStatus("settled");
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setStatus("error");
              }
            })();
          };

          // One step of the hand: settle at the end (or early), wait on the human's bet in vs-bot,
          // else apply the acting seat's bot move and schedule the next step.
          const pump = () => {
            const t = tunnelRef.current;
            if (!t || settlingRef.current) return;
            const s = t.state;
            if (
              proto.isTerminal(s) ||
              (endRef.current && s.phase === "hand_over")
            ) {
              settle();
              return;
            }
            const betting = BET_PHASES.has(s.phase);
            const actor: Party | null = betting ? s.toAct : plumbingProposer(s);
            if (!actor) return;
            if (modeRef.current === "vsBot" && betting && actor === HUMAN) {
              return; // human's turn — fold/check/call/bet will resume the pump
            }
            const move = (actor === "A" ? driverA : driverB).chooseMove(
              s,
              secureRng,
            );
            if (!move) return;
            try {
              t.step(move, actor);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setStatus("error");
              return;
            }
            sync();
            clearTimer();
            timerRef.current = window.setTimeout(pump, BOT_STEP_MS);
          };
          pumpRef.current = pump;

          humanActRef.current = (move: PokerMove) => {
            const t = tunnelRef.current;
            if (!t || settlingRef.current) return;
            const s = t.state;
            if (!BET_PHASES.has(s.phase) || s.toAct !== HUMAN) return;
            try {
              t.step(move, HUMAN);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              return;
            }
            sync();
            clearTimer();
            timerRef.current = window.setTimeout(pump, BOT_STEP_MS);
          };

          sync();
          setStatus("playing");
          timerRef.current = window.setTimeout(pump, BOT_STEP_MS);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      })();
    },
    [account, client, signAndExecute, report],
  );

  // Seed the two persistent AUTO bots from the connected wallet. A SEPARATE user action (its own
  // button) so the wallet popup fires inside the click gesture — calling signAndExecute after the
  // async balance reads in `start()` silently dropped the popup. Funds each bot the stake it must
  // front (2×perSeat) plus gas; the keys persist, so this is one-and-done like Blackjack.
  const fundBots = useCallback(
    (topUpSui?: number, onFunded?: () => void) => {
      if (!account) {
        setError("connect a wallet to fund the bots");
        return;
      }
      const bots = loadOrCreateBots();
      const perSeat = stakePerSeatMist(topUpSui);
      const need = 2n * perSeat + AUTO_MIN_GAS_MIST;
      setError(null);
      setFundingBots(true);
      // signAndExecute FIRST (no await before it) so the wallet prompt stays in the click gesture.
      signAndExecute({ transaction: buildFundTx(bots, Number(need)) as never })
        .then(async ({ digest }) => {
          // Fullnode lags the funding tx — wait, then poll until both bots reflect the new coins.
          const botClient = getSuiClient();
          await botClient.waitForTransaction({ digest });
          for (let i = 0; i < 10; i++) {
            const b = await botBalances(botClient, bots);
            if (b.a >= need && b.b >= need) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          onFunded?.(); // e.g. start the game so "Fund bots & play" is one tap
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setFundingBots(false));
    },
    [account, signAndExecute],
  );

  const requestSettle = useCallback(() => {
    if (endRef.current || settlingRef.current) return;
    endRef.current = true;
    setEndRequested(true);
    pumpRef.current?.(); // re-evaluate now (settles immediately if already at hand_over)
  }, []);

  const fold = useCallback(() => humanActRef.current?.({ kind: "fold" }), []);
  const check = useCallback(() => humanActRef.current?.({ kind: "check" }), []);
  const call = useCallback(() => humanActRef.current?.({ kind: "call" }), []);
  const bet = useCallback(
    (amount: bigint) => humanActRef.current?.({ kind: "bet", amount }),
    [],
  );

  const selfParty: Party | null = status === "idle" ? null : HUMAN;
  const myHole = state ? state.holeA : null;
  const myTurnToBet =
    mode === "vsBot" &&
    status === "playing" &&
    !!state &&
    BET_PHASES.has(state.phase) &&
    state.toAct === HUMAN;
  const legal = myTurnToBet && state ? legalFor(state, HUMAN) : null;

  return {
    status,
    mode,
    selfParty,
    state,
    myHole,
    myTurnToBet,
    legal,
    secondsLeft: null,
    opponentWallet: null,
    error,
    start,
    fundBots,
    fundingBots,
    fold,
    check,
    call,
    bet,
    endRequested,
    requestSettle,
    reset,
  };
}
