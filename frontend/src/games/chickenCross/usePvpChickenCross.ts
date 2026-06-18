import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { CrossProtocol, type CrossState, type CrossMove, type CrossDir } from "sui-tunnel-ts/protocol/cross";
import { MpClient, resolveMpWsUrl, type PvpChannel, type Role } from "../../pvp/mpClient";
import { resolveBackendUrl } from "../../backend/controlPlane";
import {
  closeCooperative,
  depositStake,
  openAndFundSharedTunnel,
  readCreatedAt,
} from "../../onchain/tunnelTx";
import { deriveView, type CrossView } from "./session-core";

const STAKE = 500n; // per-seat MIST
const STEP_MS = 300; // pacing between ticks (ms)

export type PvpStatus =
  | "idle"
  | "matching"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface PvpChickenCross {
  status: PvpStatus;
  role: Role | null;
  view: CrossView | null;
  winner: "A" | "B" | null;
  error: string | null;
  create: (code: string) => void;
  join: (code: string) => void;
  setDir: (dir: CrossDir) => void;
  reset: () => void;
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

/** Which seat proposes at this nonce: A proposes nonce 0→1, B 1→2, A 2→3, … */
function turn(nonce: bigint): Role {
  return nonce % 2n === 0n ? "A" : "B";
}

export function usePvpChickenCross(): PvpChickenCross {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [status, setStatus] = useState<PvpStatus>("idle");
  const [role, setRole] = useState<Role | null>(null);
  const [view, setView] = useState<CrossView | null>(null);
  const [winner, setWinner] = useState<"A" | "B" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mpRef = useRef<MpClient | null>(null);
  const dtRef = useRef<DistributedTunnel<CrossState, CrossMove> | null>(null);
  const roleRef = useRef<Role | null>(null);
  const myDirRef = useRef<CrossDir>("north");
  const proposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settlingRef = useRef(false);

  /** Schedule a propose for this seat if it's our turn. Clears any existing timer first. */
  const maybePropose = useCallback(() => {
    const dt = dtRef.current;
    const myRole = roleRef.current;
    if (!dt || !myRole) return;
    const proto = dt.protocol as CrossProtocol;
    if (proto.isTerminal(dt.state)) return;
    if (turn(dt.nonce) !== myRole) return;

    // Clear any pending timer so we don't double-schedule.
    if (proposeTimerRef.current !== null) {
      clearTimeout(proposeTimerRef.current);
      proposeTimerRef.current = null;
    }

    proposeTimerRef.current = setTimeout(() => {
      proposeTimerRef.current = null;
      const dtNow = dtRef.current;
      const myRoleNow = roleRef.current;
      if (!dtNow || !myRoleNow) return;
      const protoNow = dtNow.protocol as CrossProtocol;
      if (protoNow.isTerminal(dtNow.state)) return;
      if (turn(dtNow.nonce) !== myRoleNow) return;
      // Guard: don't propose if a proposal is already pending.
      if ((dtNow as unknown as { pending: unknown }).pending) return;

      const dir = myDirRef.current;
      myDirRef.current = "north"; // reset to auto-forward default
      const move: CrossMove =
        myRoleNow === "A" ? { dirA: dir } : { dirB: dir };
      try {
        dtNow.propose(move, 0n);
      } catch {
        // Proposal already pending or other transient error — safe to ignore here.
      }
    }, STEP_MS);
  }, []);

  const reset = useCallback(() => {
    if (proposeTimerRef.current !== null) {
      clearTimeout(proposeTimerRef.current);
      proposeTimerRef.current = null;
    }
    mpRef.current?.close();
    mpRef.current = null;
    dtRef.current = null;
    roleRef.current = null;
    myDirRef.current = "north";
    settlingRef.current = false;
    setStatus("idle");
    setRole(null);
    setView(null);
    setWinner(null);
    setError(null);
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (proposeTimerRef.current !== null) {
        clearTimeout(proposeTimerRef.current);
      }
    };
  }, []);

  /** Shared matchmaking + lifecycle for both create and join. */
  const startMatch = useCallback(
    (code: string) => {
      if (!account) {
        setError("connect a wallet first");
        return;
      }
      const wallet = account.address;
      const signExec = async (
        tx: Parameters<typeof signAndExecute>[0]["transaction"],
      ) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      };
      const reads = client as unknown as Parameters<
        typeof openAndFundSharedTunnel
      >[0]["reads"];

      (async () => {
        try {
          setError(null);
          setStatus("matching");
          const ephemeral: KeyPair = generateKeyPair();
          const mp = new MpClient(
            resolveMpWsUrl(resolveBackendUrl()),
            wallet,
            ephemeral,
          );
          mpRef.current = mp;
          await mp.connect();

          const gameKey = "chicken-cross:" + code.trim().toUpperCase();
          const match = await mp.quickMatch(gameKey);
          roleRef.current = match.role;
          setRole(match.role);

          const channel = mp.channel(match.matchId);
          const waitPeer = makeInbox(channel);

          // 1) exchange ephemeral pubkeys
          channel.sendPeer({
            t: "hello",
            ephemeralPubkey: toHex(ephemeral.publicKey),
          });
          const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
          const oppPub = fromHex(hello.ephemeralPubkey);

          // 2) fund on-chain
          setStatus("funding");
          let tunnelId: string;
          if (match.role === "A") {
            tunnelId = await openAndFundSharedTunnel({
              reads,
              signExec,
              partyA: { address: wallet, publicKey: ephemeral.publicKey },
              partyB: {
                address: match.opponentWallet,
                publicKey: oppPub,
              },
              amount: STAKE,
            });
            mp.announceTunnel(match.matchId, tunnelId);
            channel.sendPeer({ t: "open", tunnelId });
          } else {
            const open = await waitPeer<{ tunnelId: string }>("open");
            tunnelId = open.tunnelId;
            await depositStake({ signExec, tunnelId, amount: STAKE });
          }

          // 3) build the distributed engine
          const proto = new CrossProtocol();
          const backend = defaultBackend();
          const self = makeEndpoint(backend, wallet, ephemeral, true);
          const opp = makeEndpoint(
            backend,
            match.opponentWallet,
            { publicKey: oppPub, scheme: ephemeral.scheme },
            false,
          );
          const dt = new DistributedTunnel<CrossState, CrossMove>(
            proto,
            {
              tunnelId,
              self,
              opponent: opp,
              selfParty: match.role,
            },
            channel.transport,
            { a: STAKE, b: STAKE },
          );
          dtRef.current = dt;

          dt.onConfirmed = () => {
            // Render from displayState (proposer sees their move immediately).
            setView(deriveView(dt.displayState));
            const currentWinner = dt.state.winner;
            if (currentWinner !== null) {
              setWinner(currentWinner);
            }

            if (proto.isTerminal(dt.state) && !settlingRef.current) {
              settlingRef.current = true;
              void settle(
                dt,
                match.role,
                channel,
                waitPeer,
                reads,
                signExec,
                tunnelId,
              ).then(
                () => setStatus("settled"),
                (e) => {
                  setError(String((e as Error)?.message ?? e));
                  setStatus("error");
                },
              );
              setStatus("settling");
            } else {
              maybePropose();
            }
          };

          // 4) readiness handshake — after engine is live
          setView(deriveView(dt.displayState));
          setStatus("playing");
          if (match.role === "A") await waitPeer("ready");
          else channel.sendPeer({ t: "ready" });

          // Kick off seat A's first move (nonce 0 → A's turn)
          maybePropose();
        } catch (e) {
          setError(String((e as Error)?.message ?? e));
          setStatus("error");
        }
      })();
    },
    [account, client, signAndExecute, maybePropose],
  );

  const create = useCallback(
    (code: string) => startMatch(code),
    [startMatch],
  );

  const join = useCallback(
    (code: string) => startMatch(code),
    [startMatch],
  );

  const setDir = useCallback((dir: CrossDir) => {
    myDirRef.current = dir;
  }, []);

  return {
    status,
    role,
    view,
    winner,
    error,
    create,
    join,
    setDir,
    reset,
  };
}

/** Exchange settlement halves over the relay; seat A submits the cooperative close. */
async function settle(
  dt: DistributedTunnel<CrossState, CrossMove>,
  role: Role,
  channel: PvpChannel,
  waitPeer: <T>(t: string) => Promise<T>,
  reads: Parameters<typeof readCreatedAt>[0],
  signExec: Parameters<typeof closeCooperative>[0]["signExec"],
  tunnelId: string,
): Promise<void> {
  const createdAt = await readCreatedAt(reads, tunnelId);
  const half = dt.buildSettlementHalf(createdAt, 0n);
  channel.sendPeer({
    t: "settleHalf",
    partyABalance: half.settlement.partyABalance.toString(),
    partyBBalance: half.settlement.partyBBalance.toString(),
    finalNonce: half.settlement.finalNonce.toString(),
    timestamp: half.settlement.timestamp.toString(),
    sig: toHex(half.sigSelf),
  });
  const other = await waitPeer<{ sig: string }>("settleHalf");
  const co = dt.combineSettlement(
    half.settlement,
    half.sigSelf,
    fromHex(other.sig),
  );
  if (role === "A") {
    await closeCooperative({ signExec, tunnelId, settlement: co });
  }
}
