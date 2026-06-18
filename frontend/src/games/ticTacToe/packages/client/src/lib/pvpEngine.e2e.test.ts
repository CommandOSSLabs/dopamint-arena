// frontend/src/games/ticTacToe/packages/client/src/lib/pvpEngine.e2e.test.ts
import { test, expect, describe } from "bun:test";
import { core, bytesToHex, type protocols } from "sui-tunnel-ts";
import {
  MultiGameTicTacToeProtocol, MultiGameCaroProtocol,
  optimalMoves, CELL_EMPTY, CELL_SERVER, CELL_PLAYER, pickCaroMove,
} from "@ttt/shared";

type CellMove = { cell: number };
type AnyState = { inner: { board: number[]; turn: "A" | "B"; winner: number; size?: number }; gamesPlayed: number; maxGames: number };

// A pair of in-memory transports that forward frames to each other synchronously.
function linkedTransports() {
  let aCb: ((f: Uint8Array) => void) | null = null;
  let bCb: ((f: Uint8Array) => void) | null = null;
  return {
    a: { send: (f: Uint8Array) => bCb?.(f), onFrame: (cb: (f: Uint8Array) => void) => { aCb = cb; } },
    b: { send: (f: Uint8Array) => aCb?.(f), onFrame: (cb: (f: Uint8Array) => void) => { bCb = cb; } },
  };
}

function endpoints(tunnelId: string) {
  const ka = core.generateKeyPair(), kb = core.generateKeyPair();
  const backend = core.defaultBackend();
  return {
    selfA: core.makeEndpoint(backend, "0xA", { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey }, true),
    oppB:  core.makeEndpoint(backend, "0xB", { publicKey: kb.publicKey, scheme: 0 }, false),
    selfB: core.makeEndpoint(backend, "0xB", { publicKey: kb.publicKey, scheme: 0, secretKey: kb.secretKey }, true),
    oppA:  core.makeEndpoint(backend, "0xA", { publicKey: ka.publicKey, scheme: 0 }, false),
  };
}

function tttBestCell(inner: { board: number[] }, by: "A" | "B"): number {
  const mark = by === "A" ? 1 : 2;
  const board = inner.board.map((v) => (v === 0 ? CELL_EMPTY : v === mark ? CELL_SERVER : CELL_PLAYER));
  return optimalMoves(board, CELL_SERVER)[0];
}

// Drive a full session: both seats auto-play with a deterministic strategy; A advances between
// games. Returns the two tunnels (their states must agree) after playing `maxGames`.
function playOut(variant: "ttt" | "caro", maxGames: number) {
  const tunnelId = "0x" + "11".repeat(32);
  const proto = (variant === "caro"
    ? new MultiGameCaroProtocol(maxGames, 9)
    : new MultiGameTicTacToeProtocol(maxGames, 1n)) as unknown as protocols.Protocol<AnyState, CellMove>;
  const t = linkedTransports();
  const e = endpoints(tunnelId);
  const balances = { a: 1000n, b: 1000n };
  let ts = 1n;
  const A = new core.DistributedTunnel<AnyState, CellMove>(proto, { tunnelId, self: e.selfA, opponent: e.oppB, selfParty: "A" }, t.a, balances);
  const B = new core.DistributedTunnel<AnyState, CellMove>(proto, { tunnelId, self: e.selfB, opponent: e.oppA, selfParty: "B" }, t.b, balances);
  const pick = (s: AnyState, by: "A" | "B"): CellMove =>
    variant === "caro" ? { cell: pickCaroMove(s.inner as any, by, () => 0.5, "strong") } : { cell: tttBestCell(s.inner, by) };

  // Loop until the *session* is terminal. The seat whose turn it is proposes; A drives advances.
  for (let guard = 0; guard < 100_000; guard++) {
    const s = A.state;
    if (proto.isTerminal(s)) break;
    if (s.inner.winner !== 0) { A.propose({ cell: 0 }, ts++); continue; } // between games: A advances
    const mover = s.inner.turn === "A" ? A : B;
    mover.propose(pick(s, s.inner.turn), ts++);
  }
  return { A, B, proto };
}

describe("ttt PvP engine (two DistributedTunnels over a link)", () => {
  for (const variant of ["ttt", "caro"] as const) {
    test(`${variant}: both seats agree and balances are conserved after the session`, () => {
      const { A, B, proto } = playOut(variant, variant === "ttt" ? 3 : 2);
      // Both seats converged on the same state hash.
      expect(bytesToHex(A.protocol.encodeState(A.state))).toBe(bytesToHex(B.protocol.encodeState(B.state)));
      // Settlement: each builds its half, then combines with the other's, verifying signatures.
      const ha = A.buildSettlementHalf(0n);
      const hb = B.buildSettlementHalf(0n);
      const co = A.combineSettlement(ha.settlement, ha.sigSelf, hb.sigSelf);
      expect(co.settlement.partyABalance + co.settlement.partyBBalance).toBe(2000n);
      // Caro never moves money (stake 0); ttt may shift the 1-MIST stake on decisive games.
      if (variant === "caro") {
        expect(co.settlement.partyABalance).toBe(1000n);
        expect(co.settlement.partyBBalance).toBe(1000n);
      }
    });
  }
});
