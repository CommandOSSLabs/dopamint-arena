/**
 * Chat protocol: an unbounded off-chain message transcript with optional
 * micropayment tips, over a tunnel.
 *
 * This is the showcase for LARGE / GROWING state handled in O(1): the signed
 * state never carries the full transcript. Instead each message is folded into a
 * fixed 32-byte rolling digest
 *
 *   transcriptDigest_0 = 32 zero bytes
 *   transcriptDigest_n = rollingDigest(
 *       blake2b256, transcriptDigest_{n-1},
 *       blake2b256(party byte || u64be(len) || messageBytes))
 *
 * so encodeState() is fixed-size and per-message work is constant, no matter how
 * long the conversation runs. Plain messages leave balances untouched; an optional
 * `tip` shifts value from the sender to the recipient (balances always conserved).
 */

import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
  otherParty,
  rollingDigest,
} from "./Protocol";
import { concatBytes, toHex } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";
import { blake2b256 } from "../core/crypto";

/** Canonical protocol state data: the rolling digest and balances. */
export interface ChatStateData {
  /** 32-byte fold of the whole transcript (NOT the transcript itself). */
  transcriptDigest: Uint8Array;
  messageCount: bigint;
  /** Sender of the most recent message, or null before any message. */
  lastSender: Party | null;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
}

/** High-level driver state for a chat match. */
export enum ChatState {
  Ready = "Ready",
  AwaitingPeer = "AwaitingPeer",
  Settled = "Settled",
}

export interface ChatMove {
  kind: "msg";
  /** UTF-8 message text; must be non-empty. */
  text: string;
  /** Optional micropayment shifted from the sender to the recipient. */
  tip?: bigint;
}

export interface ChatMessage {
  sender: string;
  text: string;
}

/** Wire wrapper for a chat move so the receiver knows which party sent it. */
interface MoveEnvelope {
  kind: "msg";
  text: string;
  by: Party;
}

export interface StatefulChatProtocol {
  readonly name: string;
  state(): ChatState;
  stateAsChat(): { messages: ChatMessage[] };
  ourTurn(): boolean;
  isTerminal(): boolean;
  createMove(text: string): Uint8Array;
  applyMove(bytes: Uint8Array): void;
}

const DOMAIN = protocolDomain("chat.v1");

/** Stable per-party byte mixed into each message delta. */
function partyByte(p: Party): number {
  return p === "A" ? 0x01 : 0x02;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ChatProtocol implements Protocol<ChatStateData, ChatMove> {
  readonly name = "chat.v1";

  initialState(ctx: ProtocolContext): ChatStateData {
    return {
      transcriptDigest: new Uint8Array(32), // 32 zero bytes
      messageCount: 0n,
      lastSender: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
    };
  }

  applyMove(state: ChatStateData, move: ChatMove, by: Party): ChatStateData {
    if (move.kind !== "msg") {
      throw new Error(`unknown chat move kind: ${(move as ChatMove).kind}`);
    }
    const messageBytes = enc.encode(move.text);
    if (messageBytes.length === 0) {
      throw new Error("chat message must be non-empty");
    }

    // Fold this message into the rolling transcript digest (O(1)).
    const delta = blake2b256(
      concatBytes([
        Uint8Array.of(partyByte(by)),
        u64ToBeBytes(messageBytes.length),
        messageBytes,
      ])
    );
    const transcriptDigest = rollingDigest(
      blake2b256,
      state.transcriptDigest,
      delta
    );

    // Optional tip: shift value from sender to recipient (balances conserved).
    let balanceA = state.balanceA;
    let balanceB = state.balanceB;
    if (move.tip !== undefined && move.tip !== 0n) {
      if (move.tip < 0n) throw new Error("tip must be non-negative");
      const senderBal = by === "A" ? state.balanceA : state.balanceB;
      if (move.tip > senderBal) {
        throw new Error(`tip ${move.tip} exceeds ${by} balance ${senderBal}`);
      }
      const recipient = otherParty(by);
      balanceA =
        by === "A" ? state.balanceA - move.tip : state.balanceA + move.tip;
      balanceB =
        by === "B" ? state.balanceB - move.tip : state.balanceB + move.tip;
      void recipient;
    }

    return {
      transcriptDigest,
      messageCount: state.messageCount + 1n,
      lastSender: by,
      balanceA,
      balanceB,
      total: state.total,
    };
  }

  encodeState(state: ChatStateData): Uint8Array {
    // Fixed-size canonical encoding: domain || digest(32) || count || balances.
    return concatBytes([
      DOMAIN,
      state.transcriptDigest,
      u64ToBeBytes(state.messageCount),
      u64ToBeBytes(state.balanceA),
      u64ToBeBytes(state.balanceB),
    ]);
  }

  balances(state: ChatStateData): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(): boolean {
    return false; // chat runs until the tunnel is explicitly closed
  }

  randomMove(state: ChatStateData, by: Party, rng: () => number): ChatMove {
    const text = `msg${state.messageCount}`;
    const bal = by === "A" ? state.balanceA : state.balanceB;
    // ~25% of messages carry a small tip the sender can actually afford.
    if (bal > 0n && rng() < 0.25) {
      const cap = bal < 10n ? bal : 10n;
      const tip = BigInt(1 + Math.floor(rng() * Number(cap)));
      return { kind: "msg", text, tip };
    }
    return { kind: "msg", text };
  }
}

/** Build a stateful chat protocol driver bound to one party. */
export function chatProtocol(ourParty: Party = "A"): StatefulChatProtocol {
  const inner = new ChatProtocol();
  const ctx: ProtocolContext = {
    tunnelId: "0x0",
    initialBalances: { a: 100n, b: 100n },
  };
  let data = inner.initialState(ctx);
  let settled = false;
  const messages: ChatMessage[] = [];
  const applied = new Set<string>();

  const our = ourParty;
  const nameOf = (p: Party): string => (p === "A" ? "A" : "B");

  return {
    name: inner.name,

    state: () => (settled ? ChatState.Settled : ChatState.Ready),

    stateAsChat: () => ({ messages }),

    ourTurn: () => {
      if (settled) return false;
      const last = data.lastSender;
      if (last === null) return our === "A";
      return last !== our;
    },

    isTerminal: () => false,

    createMove: (text: string) => {
      const envelope: MoveEnvelope = { kind: "msg", text, by: our };
      const bytes = enc.encode(JSON.stringify(envelope));
      const key = toHex(blake2b256(bytes));
      if (!applied.has(key)) {
        applied.add(key);
        const move: ChatMove = { kind: "msg", text };
        data = inner.applyMove(data, move, our);
        messages.push({ sender: nameOf(our), text });
      }
      return bytes;
    },

    applyMove: (bytes: Uint8Array) => {
      const key = toHex(blake2b256(bytes));
      if (applied.has(key)) return;
      applied.add(key);
      const envelope = JSON.parse(dec.decode(bytes)) as MoveEnvelope;
      if (envelope.kind !== "msg") {
        throw new Error(`unknown chat envelope kind: ${envelope.kind}`);
      }
      const by = envelope.by;
      const move: ChatMove = { kind: "msg", text: envelope.text };
      data = inner.applyMove(data, move, by);
      messages.push({ sender: nameOf(by), text: envelope.text });
    },
  };
}
