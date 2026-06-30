// T2 — off-chain fairness (no chain, no devstack).
//
// Drives a real game (TicTacToe) to a co-signed settlement via the off-chain
// engine. Each step is dual-signed AND verified by the engine (it refuses to
// co-sign an illegal state — where most of the safety lives), and the locked
// balances are conserved across the whole session. This is the off-chain layer
// that feeds the on-chain close in the lifecycle test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateKeyPair } from 'sui-tunnel-ts/core/crypto';
import { OffchainTunnel } from 'sui-tunnel-ts/core/tunnel';
import { TicTacToeProtocol } from 'sui-tunnel-ts/protocol/ticTacToe';

import { mulberry32 } from '../harness/util.ts';

const LOCKED_TOTAL = 2000n;

test('TicTacToe self-play: every state is co-signed + verified, balances conserved', () => {
  const proto = new TicTacToeProtocol(100n);
  const ka = generateKeyPair();
  const kb = generateKeyPair();
  const tunnelId = '0x' + 'ab'.repeat(32);
  const tunnel = OffchainTunnel.selfPlay(proto, tunnelId, ka, kb, '0xA', '0xB', { a: 1000n, b: 1000n });

  const rng = mulberry32(42);
  let ts = 1n;
  let moves = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const state = tunnel.state;
    if (proto.isTerminal(state)) break;
    const by = state.turn;
    const move = proto.randomMove(state, by, rng);
    assert.ok(move, 'engine offers a legal move for the seat to move');
    const res = tunnel.step(move, by, { timestamp: ts++ });
    // The engine co-signed the new state with BOTH keys and verified them.
    assert.equal(res.verified, true, 'each state update is dual-signed and verified');
    assert.equal(res.nonce, BigInt(moves + 1), 'nonce increments per co-signed update');
    moves++;
  }

  const finalState = tunnel.state;
  assert.equal(proto.isTerminal(finalState), true, 'game reached a terminal state');

  // Balance conservation across the session.
  const bal = proto.balances(finalState);
  assert.equal(bal.a + bal.b, LOCKED_TOTAL, 'balances conserved (sum == locked total)');

  // A co-signed settlement is produceable from the agreed final state.
  const settled = tunnel.buildSettlement(ts, 0n);
  assert.equal(
    settled.settlement.partyABalance + settled.settlement.partyBBalance,
    LOCKED_TOTAL,
    'settlement balances sum to the locked total',
  );
  assert.equal(settled.settlement.finalNonce, 1n, 'cooperative close nonce = onchainNonce + 1');
});
