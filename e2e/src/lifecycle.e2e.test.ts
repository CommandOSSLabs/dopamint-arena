// On-chain lifecycle + close-safety against a real localnet (one devstack boot
// shared across the suite). Covers:
//   T4  — open+fund (SUI) → play off-chain → cooperative close-with-root →
//         CLOSED + event payouts that match the off-chain settlement.
//   T3a — dispute-override: a dispute raised at a STALE nonce is overridden by
//         a higher co-signed state (latest-co-signed-wins).
//   T3b — forfeit: a seat that abandons forfeits its stake via the on-chain
//         penalty on force-close after the real timeout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Transaction } from '@mysten/sui/transactions';
import { generateKeyPair, type KeyPair } from 'sui-tunnel-ts/core/crypto';
import { OffchainTunnel } from 'sui-tunnel-ts/core/tunnel';
import { TicTacToeProtocol } from 'sui-tunnel-ts/protocol/ticTacToe';
import { execute, parseTunnelId } from 'sui-tunnel-ts/onchain/lifecycle';
import { buildOpenAndFundOneReturnless } from 'sui-tunnel-ts/onchain/createAndFund';
import * as tb from 'sui-tunnel-ts/onchain/txbuilders';

import { bootStack, type TunnelStack } from '../harness/stack.ts';
import { mulberry32, root32, sleep } from '../harness/util.ts';

// Status constants (tunnel.move): CREATED=0 ACTIVE=1 CLOSED=2 DISPUTED=3.
const ACTIVE = 1;
const CLOSED = 2;
const DISPUTED = 3;
const STAKE = 1000n; // one seat's deposit; also the forfeit penalty in T3b

let stack: TunnelStack;

before(async () => {
  stack = await bootStack();
  console.log(`[lifecycle] localnet up: protocol v${stack.protocolVersion}, boot ${stack.bootMs}ms`);
});
after(async () => {
  await stack?.stop();
});

interface OpenedTunnel {
  tunnelId: string;
  ka: KeyPair;
  kb: KeyPair;
  createdAt: bigint;
}

/** Open + fund a tunnel from one funder's gas (SUI). The party identities pair
 *  a funded Sui address (the on-chain sender/payer) with a throwaway engine
 *  co-signing key (the off-chain signer) — `PartyArgs` carries both. */
async function openTunnel(opts: {
  aAmount: bigint;
  bAmount: bigint;
  timeoutMs: bigint;
  penaltyAmount: bigint;
}): Promise<OpenedTunnel> {
  const ka = generateKeyPair();
  const kb = generateKeyPair();
  const partyA = { address: stack.players.a.toSuiAddress(), publicKey: ka.publicKey, signatureType: 0 };
  const partyB = { address: stack.players.b.toSuiAddress(), publicKey: kb.publicKey, signatureType: 0 };

  const tx = new Transaction();
  buildOpenAndFundOneReturnless(
    tx,
    { partyA, partyB, aAmount: opts.aAmount, bAmount: opts.bAmount, timeoutMs: opts.timeoutMs, penaltyAmount: opts.penaltyAmount },
    {},
  );
  const res = await execute(stack.client, stack.players.a, tx, { waitForFinality: true });
  const tunnelId = parseTunnelId(res.objectChanges);
  assert.ok(tunnelId, 'created Tunnel id present in object changes');

  const fields = await tunnelFields(tunnelId);
  assert.equal(num(fields.status), ACTIVE, 'tunnel is ACTIVE after create_and_fund');
  return { tunnelId, ka, kb, createdAt: BigInt(fields.created_at) };
}

async function tunnelFields(id: string): Promise<any> {
  const o: any = await stack.client.getObject({ id, options: { showContent: true } });
  return o.data.content.fields;
}

function num(v: unknown): number {
  return typeof v === 'string' ? parseInt(v, 10) : (v as number);
}

async function eventsOf(digest: string): Promise<any[]> {
  const tx: any = await stack.client.getTransactionBlock({ digest, options: { showEvents: true } });
  return tx.events ?? [];
}

/** Drive a TicTacToe self-play to terminal, returning the engine tunnel. */
function playToEnd(opts: OpenedTunnel, seed: number): { tunnel: any; finalBalances: { a: bigint; b: bigint } } {
  const proto = new TicTacToeProtocol(100n);
  const tunnel = OffchainTunnel.selfPlay(
    proto,
    opts.tunnelId,
    opts.ka,
    opts.kb,
    stack.players.a.toSuiAddress(),
    stack.players.b.toSuiAddress(),
    { a: 1000n, b: 1000n },
  );
  const rng = mulberry32(seed);
  let ts = opts.createdAt; // chain-anchored timestamps (>= created_at, <= now)
  for (let guard = 0; guard < 1000; guard++) {
    const state = tunnel.state;
    if (proto.isTerminal(state)) break;
    const move = proto.randomMove(state, state.turn, rng);
    if (!move) break;
    tunnel.step(move, state.turn, { timestamp: ts++ });
  }
  return { tunnel, finalBalances: proto.balances(tunnel.state) };
}

test('T4 lifecycle: open+fund → play → cooperative close-with-root → CLOSED + payouts', async () => {
  const opened = await openTunnel({ aAmount: 1000n, bAmount: 1000n, timeoutMs: 86_400_000n, penaltyAmount: 0n });
  const { tunnel, finalBalances } = playToEnd(opened, 7);

  // Cooperative close anchored to a 32-byte transcript root (opaque on-chain).
  const settled = tunnel.buildSettlementWithRoot(opened.createdAt + 1n, root32(), 0n);
  const tx = new Transaction();
  tb.buildCloseWithRootFromSettlement(tx, opened.tunnelId, settled);
  const res = await execute(stack.client, stack.players.a, tx, { waitForFinality: true });

  const fields = await tunnelFields(opened.tunnelId);
  assert.equal(num(fields.status), CLOSED, 'tunnel CLOSED after cooperative close');
  assert.equal(String(fields.balance), '0', 'locked balance fully paid out');

  const closed = (await eventsOf(res.digest)).find((e) => e.type.endsWith('::tunnel::TunnelClosedWithRoot'));
  assert.ok(closed, 'TunnelClosedWithRoot emitted');
  const a = BigInt(closed.parsedJson.party_a_balance);
  const b = BigInt(closed.parsedJson.party_b_balance);
  assert.equal(a + b, 2000n, 'payouts sum to the funded total');
  assert.equal(a, finalBalances.a, 'A payout equals the off-chain settled balance');
  assert.equal(b, finalBalances.b, 'B payout equals the off-chain settled balance');
});

test('T3a dispute-override: a stale-nonce dispute is overridden by a higher co-signed state', async () => {
  const opened = await openTunnel({ aAmount: 1000n, bAmount: 1000n, timeoutMs: 86_400_000n, penaltyAmount: 0n });

  // Capture two co-signed updates at nonce 1 and 2 off-chain.
  const proto = new TicTacToeProtocol(100n);
  const tunnel = OffchainTunnel.selfPlay(
    proto,
    opened.tunnelId,
    opened.ka,
    opened.kb,
    stack.players.a.toSuiAddress(),
    stack.players.b.toSuiAddress(),
    { a: 1000n, b: 1000n },
  );
  const rng = mulberry32(3);
  const s1 = tunnel.state;
  const u1 = tunnel.step(proto.randomMove(s1, s1.turn, rng)!, s1.turn, { timestamp: opened.createdAt }).signed!;
  const s2 = tunnel.state;
  const u2 = tunnel.step(proto.randomMove(s2, s2.turn, rng)!, s2.turn, { timestamp: opened.createdAt + 1n }).signed!;
  assert.equal(u1.update.nonce, 1n, 'first co-signed update is nonce 1');
  assert.equal(u2.update.nonce, 2n, 'second co-signed update is nonce 2');

  // Party A raises a dispute at the STALE older state (nonce 1).
  let tx = new Transaction();
  tb.buildRaiseDisputeFromUpdate(tx, opened.tunnelId, u1, 'A');
  await execute(stack.client, stack.players.a, tx, { waitForFinality: true });
  let fields = await tunnelFields(opened.tunnelId);
  assert.equal(num(fields.status), DISPUTED, 'tunnel DISPUTED after raise');
  assert.equal(fields.dispute_raiser, stack.players.a.toSuiAddress(), 'dispute raiser is A');
  assert.equal(BigInt(fields.state.fields.nonce), 1n, 'disputed at the stale nonce');

  // Party B overrides with the NEWER co-signed state (nonce 2).
  tx = new Transaction();
  tb.buildResolveDispute(tx, opened.tunnelId, u2);
  await execute(stack.client, stack.players.b, tx, { waitForFinality: true });
  fields = await tunnelFields(opened.tunnelId);
  assert.equal(num(fields.status), ACTIVE, 'tunnel back to ACTIVE after resolve');
  assert.equal(fields.dispute_raiser, null, 'dispute raiser cleared');
  assert.equal(BigInt(fields.state.fields.nonce), 2n, 'the higher co-signed nonce wins');
});

test('T3b forfeit: an abandoning seat forfeits its stake on force-close after timeout', async () => {
  const timeoutMs = 2500n;
  const opened = await openTunnel({ aAmount: 1000n, bAmount: 1000n, timeoutMs, penaltyAmount: STAKE });

  // Honest party A raises a dispute on the current (funded) state; B abandons.
  let tx = new Transaction();
  tb.buildRaiseDisputeCurrentState(tx, { tunnelId: opened.tunnelId });
  await execute(stack.client, stack.players.a, tx, { waitForFinality: true });
  let fields = await tunnelFields(opened.tunnelId);
  assert.equal(num(fields.status), DISPUTED, 'DISPUTED after raise-current-state');
  assert.equal(fields.dispute_raiser, stack.players.a.toSuiAddress(), 'A is the dispute raiser');

  // Wait past the real on-chain timeout (chain Clock), then force-close.
  await sleep(Number(timeoutMs) + 2000);
  tx = new Transaction();
  tb.buildForceClose(tx, { tunnelId: opened.tunnelId });
  const res = await execute(stack.client, stack.players.a, tx, { waitForFinality: true });

  fields = await tunnelFields(opened.tunnelId);
  assert.equal(num(fields.status), CLOSED, 'CLOSED after force-close');

  const closed = (await eventsOf(res.digest)).find((e) => e.type.endsWith('::tunnel::TunnelClosed'));
  assert.ok(closed, 'TunnelClosed emitted');
  const a = BigInt(closed.parsedJson.party_a_balance);
  const b = BigInt(closed.parsedJson.party_b_balance);
  // Current-state dispute → disputed balances are the deposits (1000/1000);
  // the penalty moves min(STAKE, opponent) from the abandoner (B) to the raiser (A).
  assert.equal(a, 1000n + (STAKE < 1000n ? STAKE : 1000n), 'raiser gains min(stake, opponent balance)');
  assert.equal(b, 1000n - (STAKE < 1000n ? STAKE : 1000n), 'abandoner forfeits that amount');
  assert.equal(a + b, 2000n, 'conserved');
});
