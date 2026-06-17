import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, protocols, bytesToHex, hexToBytes } from "sui-tunnel-ts";
import { useCurrentAccount, useSignAndExecuteTransaction, useSignPersonalMessage } from "@mysten/dapp-kit";
import { SuiClient } from "@mysten/sui/client";
import { getSuiClient } from "@/lib/bjBots";
import { getOrCreateEphemeral, attestationMessage, verifyAttestation } from "@/lib/bjPvpIdentity";
import { buildCreateAndShareTx, buildDepositTx, buildCloseTx, parseTunnelId } from "@/lib/bjPvpOnchain";
import { RelayClient } from "@/lib/bjRelay";
import { handValue } from "@/lib/bjCards";

type BlackjackState = protocols.BlackjackState;
type BlackjackMove = protocols.BlackjackMove;

const MP_URL = import.meta.env.VITE_MP_URL ?? "ws://127.0.0.1:8080";
/** Per-seat bankroll deposited on-chain (MIST). The protocol stakes WAGER per round. */
const STAKE = 10_000_000n; // 0.01 SUI
const BOT_MOVE_MS = 700; // player auto-bot move cadence
const DEALER_MS = 600; // dealer reveal pause before auto-drawing
const NEXT_MS = 900; // pause before auto-dealing the next round

export type PvpPhase =
  | "idle" | "connecting" | "queuing" | "opening" | "funding" | "playing" | "settling" | "done" | "error";

export interface RoundResult {
  round: number;
  outcome: "win" | "lose" | "push"; // from the PLAYER's perspective
  playerSum: number;
  dealerSum: number;
}

export interface PvpView {
  phase: PvpPhase;
  error: string | null;
  role: "A" | "B" | null; // A = player (draws), B = dealer (host/auto)
  isDealer: boolean;
  playerHand: number[];
  dealerHand: number[]; // dealer hole card hidden until the dealer's turn / round over
  playerSum: number;
  dealerSum: number;
  balancePlayer: bigint;
  balanceDealer: bigint;
  round: number;
  gamePhase: "player" | "dealer" | "round_over" | null;
  myTurn: boolean; // I'm the player and it's the player's turn (Hit/Stand)
  inRoundOver: boolean; // round resolved — can Next / Stop
  terminal: boolean; // round cap or a side can't fund — only Stop
  rounds: RoundResult[];
  auto: boolean;
  walletAddress: string;
  walletBalance: bigint;
  digests: { create?: string; deposit?: string; close?: string };
  fund: () => void;
  queue: () => void;
  hit: () => void;
  stand: () => void;
  next: () => void;
  stop: () => void;
  setAuto: (on: boolean) => void;
  leave: () => void;
}

export function usePvpBlackjack(): PvpView {
  const client = useMemo<SuiClient>(() => getSuiClient(), []);
  const account = useCurrentAccount();
  const walletAddress = account?.address ?? "";
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const proto = useMemo(() => new protocols.BlackjackProtocol(), []);

  const [phase, setPhase] = useState<PvpPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"A" | "B" | null>(null);
  const [state, setState] = useState<BlackjackState | null>(null);
  const [rounds, setRounds] = useState<RoundResult[]>([]);
  const [auto, setAutoState] = useState(false);
  const [walletBalance, setWalletBalance] = useState<bigint>(0n);
  const [digests, setDigests] = useState<{ create?: string; deposit?: string; close?: string }>({});

  const relayRef = useRef<RelayClient | null>(null);
  const tunnelRef = useRef<core.DistributedTunnel<BlackjackState, BlackjackMove> | null>(null);
  const roleRef = useRef<"A" | "B" | null>(null);
  const autoRef = useRef(false);
  const createdAtRef = useRef<bigint>(0n);
  const matchIdRef = useRef<string>("");
  const settledRef = useRef(false);
  const stoppingRef = useRef(false);
  const onMatchRef = useRef<(relay: RelayClient, m: { matchId: string; role: "A" | "B"; opponentWallet: string }) => Promise<void>>();
  const openedResolveRef = useRef<((id: string) => void) | null>(null);
  const settleResolveRef = useRef<((sig: Uint8Array) => void) | null>(null);
  const bufferedSettleRef = useRef<Uint8Array | null>(null);

  const refreshBalance = useCallback(async () => {
    try { const b = await client.getBalance({ owner: walletAddress }); setWalletBalance(BigInt(b.totalBalance)); } catch { /* ignore */ }
  }, [client, walletAddress]);
  useEffect(() => { void refreshBalance(); }, [refreshBalance]);

  const submit = useCallback(async (tx: any) => {
    const { digest } = await signAndExecute({ transaction: tx });
    const res = await client.waitForTransaction({ digest, options: { showObjectChanges: true, showEffects: true } });
    if (res.effects?.status?.status !== "success") throw new Error(res.effects?.status?.error ?? "tx failed");
    return res;
  }, [client, signAndExecute]);

  const fund = useCallback(() => { void (async () => {
    if (!walletAddress) { setError("Connect a wallet on the menu first"); return; }
    try {
      const { requestSuiFromFaucetV2, getFaucetHost } = await import("@mysten/sui/faucet");
      await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: walletAddress });
      for (let i = 0; i < 8; i++) { await refreshBalance(); await new Promise((r) => setTimeout(r, 1500)); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  })(); }, [walletAddress, refreshBalance]);

  const finishSettle = useCallback(async (t: core.DistributedTunnel<BlackjackState, BlackjackMove>, relay: RelayClient, matchId: string) => {
    if (settledRef.current) return; settledRef.current = true;
    setPhase("settling");
    const half = t.buildSettlementHalf(createdAtRef.current); // both sign with the on-chain created_at
    relay.sendApp(matchId, { t: "settle", sig: bytesToHex(half.sigSelf) });
    const otherSig = bufferedSettleRef.current ?? await new Promise<Uint8Array>((res) => { settleResolveRef.current = res; });
    const coSigned = t.combineSettlement(half.settlement, half.sigSelf, otherSig);
    if (roleRef.current === "B") { // the dealer (the opener) submits the cooperative close
      const res = await submit(buildCloseTx(t.tunnelId, coSigned));
      setDigests((d) => ({ ...d, close: res.digest }));
      relay.sendApp(matchId, { t: "closed", digest: res.digest });
    }
    await refreshBalance();
    setPhase("done");
  }, [submit, refreshBalance]);

  const queue = useCallback(() => { void (async () => {
    if (!walletAddress) { setError("Connect a wallet on the menu first"); setPhase("error"); return; }
    setError(null); setPhase("connecting"); settledRef.current = false; stoppingRef.current = false; setRounds([]);
    try {
      const connEph = core.generateKeyPair();
      const relay = new RelayClient(MP_URL, walletAddress, core.keyPairFromSecret(connEph.secretKey));
      relayRef.current = relay;
      await relay.ready;
      setPhase("queuing");
      relay.on("error", (m) => { setError(`${m.code}: ${m.message}`); setPhase("error"); });
      relay.on("match.found", (m) => { void onMatchRef.current?.(relay, m as any); });
      relay.queueJoin("blackjack");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setPhase("error"); }
  })(); }, [walletAddress]);

  const onMatch = useCallback(async (relay: RelayClient, m: { matchId: string; role: "A" | "B"; opponentWallet: string }) => {
    try {
      matchIdRef.current = m.matchId; roleRef.current = m.role; setRole(m.role);
      // App-channel dispatcher: opened tunnelId, settle half, closed digest, and stop request.
      relay.onApp(m.matchId, (mm) => {
        if (mm.t === "opened") openedResolveRef.current?.(String(mm.tunnelId));
        else if (mm.t === "settle") {
          const sig = hexToBytes(String(mm.sig));
          if (settleResolveRef.current) settleResolveRef.current(sig);
          else bufferedSettleRef.current = sig;
        } else if (mm.t === "closed") setDigests((d) => ({ ...d, close: String(mm.digest) }));
        else if (mm.t === "stop") {
          stoppingRef.current = true;
          if (tunnelRef.current) void finishSettle(tunnelRef.current, relay, m.matchId);
        }
      });
      // Register the party.hello capture synchronously (before any await).
      let helloResolve!: (h: { ephemeralPubkey: string; walletSig: string }) => void;
      const oppHelloMsg = new Promise<{ ephemeralPubkey: string; walletSig: string }>((res) => { helloResolve = res; });
      relay.on("party.hello", (h) => {
        if (h.matchId === m.matchId) helloResolve({ ephemeralPubkey: String(h.ephemeralPubkey), walletSig: String(h.walletSig) });
      });

      const myEph = await getOrCreateEphemeral(m.matchId);
      const { signature: walletSig } = await signPersonalMessage({ message: attestationMessage(m.matchId, myEph.pubkeyHex) });
      relay.partyHello(m.matchId, myEph.pubkeyHex, walletSig);

      const oppHello = await oppHelloMsg;
      const attestOk = await verifyAttestation(m.matchId, oppHello.ephemeralPubkey, oppHello.walletSig, m.opponentWallet);
      if (!attestOk) console.warn("[pvp] opponent attestation did not verify; proceeding (lobby identity is self-asserted in v1)");
      const oppEphPubkey = hexToBytes(oppHello.ephemeralPubkey);

      // Roles: A = player (party A), B = dealer (party B). The DEALER (role B) opens the tunnel
      // and registers partyA = the player (the opponent), partyB = the dealer (self).
      let tunnelId: string;
      if (m.role === "B") {
        setPhase("opening");
        const res = await submit(buildCreateAndShareTx(
          { walletAddress: m.opponentWallet, ephemeralPubkey: oppEphPubkey }, // partyA = player
          { walletAddress, ephemeralPubkey: myEph.coreKey.publicKey },        // partyB = dealer (self)
          STAKE,
        ));
        const id = parseTunnelId(res.objectChanges); if (!id) throw new Error("no tunnelId");
        tunnelId = id; setDigests((d) => ({ ...d, create: res.digest }));
        relay.tunnelOpened(m.matchId, tunnelId);
        relay.sendApp(m.matchId, { t: "opened", tunnelId });
      } else {
        setPhase("opening");
        tunnelId = await new Promise<string>((resolve) => { openedResolveRef.current = resolve; });
      }

      const obj = await client.getObject({ id: tunnelId, options: { showContent: true } });
      const fields = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
      createdAtRef.current = BigInt((fields?.created_at as string | undefined) ?? 0);

      setPhase("funding");
      const dep = await submit(buildDepositTx(tunnelId, STAKE));
      setDigests((d) => ({ ...d, deposit: dep.digest }));
      let activated = false;
      for (let i = 0; i < 40; i++) {
        const o = await client.getObject({ id: tunnelId, options: { showContent: true } });
        const f = (o.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
        if (Number(f?.status ?? 0) >= 1 && BigInt((f?.party_a_deposit as string) ?? 0) > 0n && BigInt((f?.party_b_deposit as string) ?? 0) > 0n) { activated = true; break; }
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!activated) throw new Error("tunnel did not activate (opponent may not have funded)");

      const backend = core.defaultBackend();
      const t = new core.DistributedTunnel<BlackjackState, BlackjackMove>(proto, {
        tunnelId,
        self: core.makeEndpoint(backend, walletAddress, { publicKey: myEph.coreKey.publicKey, scheme: 0, secretKey: myEph.coreKey.secretKey }, true),
        opponent: core.makeEndpoint(backend, m.opponentWallet, { publicKey: oppEphPubkey, scheme: 0 }, false),
        selfParty: m.role, // A = player, B = dealer
      }, relay.transport(m.matchId), { a: STAKE, b: STAKE });
      tunnelRef.current = t;

      // Per-round log: record the player's (party A) result whenever a new round resolves.
      let lastLoggedRound = 0;
      let lastBalanceA = Number(STAKE);
      const onAdvance = () => {
        const st = t.state;
        setState({ ...st });
        if (st.phase === "round_over" && Number(st.round) > lastLoggedRound) {
          const balA = Number(st.balanceA);
          const delta = balA - lastBalanceA;
          const outcome: RoundResult["outcome"] = delta > 0 ? "win" : delta < 0 ? "lose" : "push";
          const rr: RoundResult = { round: Number(st.round), outcome, playerSum: handValue(st.playerHand), dealerSum: handValue(st.dealerHand) };
          setRounds((prev) => [...prev, rr].slice(-30));
          lastLoggedRound = Number(st.round);
          lastBalanceA = balA;
        }
        if (stoppingRef.current) return; // a stop/settle is in progress
        if (proto.isTerminal(st)) { void finishSettle(t, relay, m.matchId); return; }
        if (st.phase === "player" && m.role === "A") {
          if (autoRef.current) {
            const mv = proto.randomMove(st, "A", Math.random);
            if (mv) setTimeout(() => { try { t.propose(mv, BigInt(Date.now())); } catch { /* not my turn / in flight */ } }, BOT_MOVE_MS);
          }
        } else if (st.phase === "dealer" && m.role === "B") {
          // The dealer is deterministic — always auto-stand (triggers draw-to-17), regardless of the toggle.
          setTimeout(() => { try { t.propose({ action: "stand" }, BigInt(Date.now())); } catch { /* in flight */ } }, DEALER_MS);
        } else if (st.phase === "round_over" && autoRef.current) {
          setTimeout(() => { try { t.propose({ action: "hit" }, BigInt(Date.now())); } catch { /* raced / in flight */ } }, NEXT_MS);
        }
      };
      t.onConfirmed = () => onAdvance();
      setPhase("playing");
      setState({ ...t.state });
      onAdvance(); // kick off (deal already dealt round 1 -> player phase)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setPhase("error"); }
  }, [client, proto, submit, signPersonalMessage, walletAddress, finishSettle]);
  onMatchRef.current = onMatch;

  // Player Hit/Stand (only the player, only on the player's turn).
  const proposePlayer = useCallback((action: "hit" | "stand") => {
    const t = tunnelRef.current; if (!t) return;
    if (roleRef.current !== "A" || t.state.phase !== "player") return;
    try { t.propose({ action }, BigInt(Date.now())); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  const hit = useCallback(() => proposePlayer("hit"), [proposePlayer]);
  const stand = useCallback(() => proposePlayer("stand"), [proposePlayer]);

  // Deal the next round (either seat, only at round_over and not terminal).
  const next = useCallback(() => {
    const t = tunnelRef.current; if (!t) return;
    if (t.state.phase !== "round_over" || proto.isTerminal(t.state)) return;
    try { t.propose({ action: "hit" }, BigInt(Date.now())); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [proto]);

  // Stop & settle the tunnel from a round boundary (either seat). Co-signed; the dealer closes.
  const stop = useCallback(() => {
    const t = tunnelRef.current; const relay = relayRef.current; if (!t || !relay) return;
    if (t.state.phase !== "round_over") return; // settle cleanly between rounds
    stoppingRef.current = true;
    relay.sendApp(matchIdRef.current, { t: "stop" });
    void finishSettle(t, relay, matchIdRef.current);
  }, [finishSettle]);

  const setAuto = useCallback((on: boolean) => {
    autoRef.current = on; setAutoState(on);
    const t = tunnelRef.current;
    if (!on || !t || stoppingRef.current || proto.isTerminal(t.state)) return;
    // Resume auto from the current state.
    const st = t.state;
    if (st.phase === "player" && roleRef.current === "A") {
      const mv = proto.randomMove(st, "A", Math.random);
      if (mv) setTimeout(() => { try { t.propose(mv, BigInt(Date.now())); } catch { /* ignore */ } }, BOT_MOVE_MS);
    } else if (st.phase === "round_over") {
      setTimeout(() => { try { t.propose({ action: "hit" }, BigInt(Date.now())); } catch { /* ignore */ } }, NEXT_MS);
    }
  }, [proto]);

  const leave = useCallback(() => {
    relayRef.current?.close(); relayRef.current = null; tunnelRef.current = null;
    setPhase("idle"); setState(null); setRole(null); setDigests({}); setRounds([]);
    settledRef.current = false; stoppingRef.current = false;
    openedResolveRef.current = null; settleResolveRef.current = null; bufferedSettleRef.current = null;
  }, []);

  useEffect(() => () => relayRef.current?.close(), []);

  const s = state;
  const isDealer = roleRef.current === "B";
  const gamePhase = s ? s.phase : null;
  const playerHand = s ? s.playerHand : [];
  // Hide the dealer's hole card during the player's turn (revealed once the dealer acts / round ends).
  const dealerHand = s ? (s.phase === "player" ? s.dealerHand.slice(0, 1) : s.dealerHand) : [];
  const terminal = s ? proto.isTerminal(s) : false;
  const myTurn = !!s && s.phase === "player" && roleRef.current === "A";
  const inRoundOver = !!s && s.phase === "round_over";

  return {
    phase, error, role, isDealer,
    playerHand, dealerHand,
    playerSum: handValue(playerHand),
    dealerSum: s && s.phase !== "player" ? handValue(s.dealerHand) : handValue(dealerHand),
    balancePlayer: s ? s.balanceA : 0n,
    balanceDealer: s ? s.balanceB : 0n,
    round: s ? Number(s.round) : 0,
    gamePhase, myTurn, inRoundOver, terminal, rounds, auto,
    walletAddress, walletBalance, digests,
    fund, queue, hit, stand, next, stop, setAuto, leave,
  };
}
