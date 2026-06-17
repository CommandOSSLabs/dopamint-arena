import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, bytesToHex } from "sui-tunnel-ts";
import { useCurrentAccount, useSignAndExecuteTransaction, useSignPersonalMessage } from "@mysten/dapp-kit";
import { SuiClient } from "@mysten/sui/client";
import { getSuiClient } from "@/lib/bjBots";
import { getOrCreateEphemeral, attestationMessage, verifyAttestation } from "@/lib/bjPvpIdentity";
import { buildCreateAndShareTx, buildDepositTx, buildCloseTx, parseTunnelId } from "@/lib/bjPvpOnchain";
import { RelayClient } from "@/lib/bjRelay";
import { BlackjackDuelProtocol, STAKE, type DuelState, type DuelMove } from "@/lib/bjDuelProtocol";

const MP_URL = import.meta.env.VITE_MP_URL ?? "ws://127.0.0.1:8080";
const BOT_MOVE_MS = 700;

export type PvpPhase =
  | "idle" | "connecting" | "queuing" | "opening" | "funding" | "playing" | "settling" | "done" | "error";

export interface PvpView {
  phase: PvpPhase;
  error: string | null;
  role: "A" | "B" | null;
  myHand: number[];
  oppHand: number[];
  dealerHand: number[];
  myTurn: boolean;
  state: DuelState | null;
  result: "win" | "lose" | "push" | null;
  auto: boolean;
  walletAddress: string;
  walletBalance: bigint;
  digests: { create?: string; deposit?: string; close?: string };
  fund: () => void;
  queue: () => void;
  hit: () => void;
  stand: () => void;
  setAuto: (on: boolean) => void;
  leave: () => void;
}

export function usePvpBlackjack(): PvpView {
  const client = useMemo<SuiClient>(() => getSuiClient(), []);
  // On-chain identity = the wallet connected on the main menu (dapp-kit). It funds the stake,
  // receives winnings, and signs the party.hello attestation. The ephemeral key still signs moves.
  const account = useCurrentAccount();
  const walletAddress = account?.address ?? "";
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const proto = useMemo(() => new BlackjackDuelProtocol(), []);

  const [phase, setPhase] = useState<PvpPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"A" | "B" | null>(null);
  const [state, setState] = useState<DuelState | null>(null);
  const [auto, setAutoState] = useState(false);
  const [walletBalance, setWalletBalance] = useState<bigint>(0n);
  const [digests, setDigests] = useState<{ create?: string; deposit?: string; close?: string }>({});

  const relayRef = useRef<RelayClient | null>(null);
  const tunnelRef = useRef<core.DistributedTunnel<DuelState, DuelMove> | null>(null);
  const roleRef = useRef<"A" | "B" | null>(null);
  const autoRef = useRef(false);
  const createdAtRef = useRef<bigint>(0n);
  const settledRef = useRef(false);
  // Stable ref to the latest onMatch so the (once-registered) match.found handler never
  // captures a stale closure — avoids the exhaustive-deps suppression on `queue`.
  const onMatchRef = useRef<(relay: RelayClient, m: { matchId: string; role: "A" | "B"; opponentWallet: string }) => Promise<void>>();
  // App-channel resolvers (the backend forwards `relay` payloads but NOT tunnel.opened, so the
  // opener delivers the tunnelId to B over the app channel; settle halves arrive the same way).
  const openedResolveRef = useRef<((id: string) => void) | null>(null);
  const settleResolveRef = useRef<((sig: Uint8Array) => void) | null>(null);
  const bufferedSettleRef = useRef<Uint8Array | null>(null);

  const refreshBalance = useCallback(async () => {
    try { const b = await client.getBalance({ owner: walletAddress }); setWalletBalance(BigInt(b.totalBalance)); } catch { /* ignore */ }
  }, [client, walletAddress]);
  useEffect(() => { void refreshBalance(); }, [refreshBalance]);

  const submit = useCallback(async (tx: any) => {
    // The connected wallet signs + executes (popup); then fetch the full response (objectChanges).
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

  const finishSettle = useCallback(async (t: core.DistributedTunnel<DuelState, DuelMove>, relay: RelayClient, matchId: string) => {
    if (settledRef.current) return; settledRef.current = true;
    setPhase("settling");
    const half = t.buildSettlementHalf(createdAtRef.current); // both sign with the on-chain created_at
    relay.sendApp(matchId, { t: "settle", sig: bytesToHex(half.sigSelf) });
    // Use the opponent's half if it already arrived (buffered by the dispatcher), else await it.
    const otherSig = bufferedSettleRef.current ?? await new Promise<Uint8Array>((res) => { settleResolveRef.current = res; });
    const coSigned = t.combineSettlement(half.settlement, half.sigSelf, otherSig);
    if (roleRef.current === "A") { // A submits the cooperative close, then broadcasts the digest
      const res = await submit(buildCloseTx(t.tunnelId, coSigned));
      setDigests((d) => ({ ...d, close: res.digest }));
      relay.sendApp(matchId, { t: "closed", digest: res.digest });
    }
    await refreshBalance();
    setPhase("done");
  }, [submit, refreshBalance]);

  const queue = useCallback(() => { void (async () => {
    if (!walletAddress) { setError("Connect a wallet on the menu first"); setPhase("error"); return; }
    setError(null); setPhase("connecting"); settledRef.current = false;
    try {
      // Per-connection ephemeral key is bound at match time; use a temporary one for connect auth.
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
      roleRef.current = m.role; setRole(m.role);
      // One persistent app-channel dispatcher per match: opened tunnelId, settle half, closed digest.
      relay.onApp(m.matchId, (mm) => {
        if (mm.t === "opened") openedResolveRef.current?.(String(mm.tunnelId));
        else if (mm.t === "settle") {
          const sig = Uint8Array.from(Buffer.from(String(mm.sig), "hex"));
          if (settleResolveRef.current) settleResolveRef.current(sig);
          else bufferedSettleRef.current = sig;
        } else if (mm.t === "closed") setDigests((d) => ({ ...d, close: String(mm.digest) }));
      });
      // Register the party.hello capture SYNCHRONOUSLY (before any await) so an early arrival
      // from the opponent can't be dropped.
      let helloResolve!: (h: { ephemeralPubkey: string; walletSig: string }) => void;
      const oppHelloMsg = new Promise<{ ephemeralPubkey: string; walletSig: string }>((res) => { helloResolve = res; });
      relay.on("party.hello", (h) => {
        if (h.matchId === m.matchId) helloResolve({ ephemeralPubkey: String(h.ephemeralPubkey), walletSig: String(h.walletSig) });
      });

      const myEph = await getOrCreateEphemeral(m.matchId);
      const { signature: walletSig } = await signPersonalMessage({ message: attestationMessage(m.matchId, myEph.pubkeyHex) });
      relay.partyHello(m.matchId, myEph.pubkeyHex, walletSig);

      // Exchange + verify wallet-attested ephemeral pubkeys.
      const oppHello = await oppHelloMsg;
      if (!(await verifyAttestation(m.matchId, oppHello.ephemeralPubkey, oppHello.walletSig, m.opponentWallet))) {
        throw new Error("opponent attestation failed");
      }
      const oppEphPubkey = Uint8Array.from(Buffer.from(oppHello.ephemeralPubkey, "hex"));

      // Open (A) or wait for tunnel.opened (B).
      let tunnelId: string;
      if (m.role === "A") {
        setPhase("opening");
        const res = await submit(buildCreateAndShareTx(
          { walletAddress, ephemeralPubkey: myEph.coreKey.publicKey },
          { walletAddress: m.opponentWallet, ephemeralPubkey: oppEphPubkey },
          STAKE,
        ));
        const id = parseTunnelId(res.objectChanges); if (!id) throw new Error("no tunnelId");
        tunnelId = id; setDigests((d) => ({ ...d, create: res.digest }));
        relay.tunnelOpened(m.matchId, tunnelId);              // server record
        relay.sendApp(m.matchId, { t: "opened", tunnelId }); // deliver to B (server doesn't forward tunnel.opened)
      } else {
        setPhase("opening");
        tunnelId = await new Promise<string>((resolve) => { openedResolveRef.current = resolve; });
      }

      // Read created_at (shared settlement timestamp) + verify own seat.
      const obj = await client.getObject({ id: tunnelId, options: { showContent: true } });
      const fields = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
      createdAtRef.current = BigInt((fields?.created_at as string | undefined) ?? 0);

      // Fund own seat, then wait for activation (both deposits) on-chain.
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

      // Build the engine over the relay transport and start playing.
      const backend = core.defaultBackend();
      const t = new core.DistributedTunnel<DuelState, DuelMove>(proto, {
        tunnelId,
        self: core.makeEndpoint(backend, walletAddress, { publicKey: myEph.coreKey.publicKey, scheme: 0, secretKey: myEph.coreKey.secretKey }, true),
        opponent: core.makeEndpoint(backend, m.opponentWallet, { publicKey: oppEphPubkey, scheme: 0 }, false),
        selfParty: m.role,
      }, relay.transport(m.matchId), { a: STAKE, b: STAKE });
      tunnelRef.current = t;

      const onAdvance = () => {
        setState({ ...t.state });
        if (proto.isTerminal(t.state)) { void finishSettle(t, relay, m.matchId); return; }
        const turn = t.state.phase === "a_turn" ? "A" : "B";
        if (turn === m.role && autoRef.current) {
          const mv = proto.randomMove(t.state, m.role, Math.random);
          if (mv) setTimeout(() => { try { t.propose(mv, BigInt(Date.now())); } catch { /* not my turn / in flight */ } }, BOT_MOVE_MS);
        }
      };
      t.onConfirmed = () => onAdvance();
      setPhase("playing");
      setState({ ...t.state });
      onAdvance(); // if it's my turn and auto, kick off
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setPhase("error"); }
  }, [client, proto, submit, signPersonalMessage, walletAddress, finishSettle]);
  onMatchRef.current = onMatch; // keep the match.found handler pointed at the latest onMatch

  const propose = useCallback((action: "hit" | "stand") => {
    const t = tunnelRef.current; if (!t) return;
    const turn = t.state.phase === "a_turn" ? "A" : "B";
    if (turn !== roleRef.current) return;
    try { t.propose({ action }, BigInt(Date.now())); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  const hit = useCallback(() => propose("hit"), [propose]);
  const stand = useCallback(() => propose("stand"), [propose]);
  const setAuto = useCallback((on: boolean) => {
    autoRef.current = on; setAutoState(on);
    const t = tunnelRef.current;
    if (on && t && !proto.isTerminal(t.state)) {
      const turn = t.state.phase === "a_turn" ? "A" : "B";
      if (turn === roleRef.current) { const mv = proto.randomMove(t.state, roleRef.current!, Math.random); if (mv) setTimeout(() => { try { t.propose(mv, BigInt(Date.now())); } catch { /* ignore */ } }, BOT_MOVE_MS); }
    }
  }, [proto]);
  const leave = useCallback(() => {
    relayRef.current?.close(); relayRef.current = null; tunnelRef.current = null;
    setPhase("idle"); setState(null); setRole(null); setDigests({});
    settledRef.current = false;
    openedResolveRef.current = null; settleResolveRef.current = null; bufferedSettleRef.current = null;
  }, []);

  useEffect(() => () => relayRef.current?.close(), []);

  const s = state;
  const myTurn = !!s && s.phase !== "over" && (s.phase === "a_turn" ? "A" : "B") === roleRef.current;
  const myHand = s ? (roleRef.current === "A" ? s.handA : s.handB) : [];
  const oppHand = s ? (roleRef.current === "A" ? s.handB : s.handA) : [];
  // Hide the dealer's hole card(s) until the duel is over.
  const dealerHand = s ? (s.phase === "over" ? s.dealerHand : s.dealerHand.slice(0, 1)) : [];
  let result: "win" | "lose" | "push" | null = null;
  if (s?.phase === "over") {
    const mine = roleRef.current === "A" ? s.balanceA : s.balanceB;
    result = mine > STAKE ? "win" : mine < STAKE ? "lose" : "push";
  }

  return {
    phase, error, role, myHand, oppHand, dealerHand, myTurn, state: s, result, auto,
    walletAddress, walletBalance, digests, fund, queue, hit, stand, setAuto, leave,
  };
}
