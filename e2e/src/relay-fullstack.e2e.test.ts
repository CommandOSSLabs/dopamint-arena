// T5 — full-stack relay tier. Proves the relayer's `/v1/mp` WebSocket lane end-to-end LIVE on
// localnet — the path loadbench documents as never-run. Two parties pair via the real relay and
// exchange co-signed TicTacToe moves as opaque frames over the WS (the relay is pure transport —
// it never signs, never settles), then the agreed final state is settled on-chain with a
// cooperative close-with-root submitted by a party. (The relayer's own settle PTB pins the
// testnet chain digest and so cannot close on localnet; client-side settle is the localnet path.)
//
// One devstack boot + one relayer process for the suite. SKIPPED (not failed) when the relayer
// binary is absent, so a no-Rust environment still runs the other tiers green.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { generateKeyPair } from 'sui-tunnel-ts/core/crypto';
import { makeEndpoint } from 'sui-tunnel-ts/core/tunnel';
import { DistributedTunnel } from 'sui-tunnel-ts/core/distributedTunnel';
import type { MoveCodec } from 'sui-tunnel-ts/core/distributedFrame';
import { toHex, fromHex } from 'sui-tunnel-ts/core/bytes';
import { defaultBackend } from 'sui-tunnel-ts/core/crypto-native';
import { TicTacToeProtocol } from 'sui-tunnel-ts/protocol/ticTacToe';
import { execute, parseTunnelId } from 'sui-tunnel-ts/onchain/lifecycle';
import { buildOpenAndFundOneReturnless } from 'sui-tunnel-ts/onchain/createAndFund';
import * as tb from 'sui-tunnel-ts/onchain/txbuilders';

import { bootStack, type TunnelStack } from '../harness/stack.ts';
import { connectRelaySeat } from '../harness/relaySeat.ts';
import { startRelayer, relayerBinaryPath, type Relayer } from '../harness/relayer.ts';
import { mulberry32, root32 } from '../harness/util.ts';

const CLOSED = 2; // tunnel.move status
const binary = relayerBinaryPath();

// A move codec that survives the relay's JSON frame round-trip: TicTacToe moves carry a
// `salt: Uint8Array` (folded into a per-move commitment). Plain JSON would turn it into an
// indexed object; the identity codec is only safe in-process (T2). Encode bigints/bytes as
// tagged objects and restore them on decode, exactly as the loadbench relay path does.
const bigintSafeCodec: MoveCodec<unknown> = {
  encode(m: unknown): unknown {
    return JSON.parse(
      JSON.stringify(m, (_k, v) => {
        if (typeof v === 'bigint') return { __bigint__: v.toString() };
        if (v instanceof Uint8Array) return { __bytes__: toHex(v) };
        return v;
      }),
    );
  },
  decode(j: unknown): unknown {
    return JSON.parse(JSON.stringify(j), (_k, v) => {
      if (v !== null && typeof v === 'object') {
        if ('__bigint__' in v) return BigInt((v as { __bigint__: string }).__bigint__);
        if ('__bytes__' in v) return fromHex((v as { __bytes__: string }).__bytes__);
      }
      return v;
    });
  },
};

let stack: TunnelStack;
let relayer: Relayer;

before(async () => {
  stack = await bootStack();
  relayer = await startRelayer({ rpcUrl: stack.rpcUrl, packageId: stack.packageId, binary: binary! });
  console.log(`[relay] localnet v${stack.protocolVersion} + relayer at ${relayer.wsUrl}`);
});
after(async () => {
  await relayer?.stop();
  await stack?.stop();
});

/** Resolve once the opponent's ACK confirms this seat's proposal across the WS round-trip. */
function proposeAndAwait(dt: DistributedTunnel<unknown, unknown>, move: unknown, ts: bigint): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const prev = dt.onConfirmed;
    dt.onConfirmed = (u) => {
      prev?.(u);
      if (!done) {
        done = true;
        dt.onConfirmed = prev;
        resolve();
      }
    };
    try {
      dt.propose(move, ts);
    } catch (e) {
      dt.onConfirmed = prev;
      reject(e);
    }
  });
}

test(
  'T5 relay full-stack: paired over the live relay WS, co-signed play settles on-chain',
  { skip: binary ? false : 'tunnel-manager binary not built (cargo build -p tunnel-manager)' },
  async () => {
    // 1) On-chain open, registering the engine co-signing keys as the two parties. These same
    //    keys co-sign off-chain, so the agreed settlement verifies at close_cooperative_with_root.
    const ka = generateKeyPair();
    const kb = generateKeyPair();
    const addrA = stack.players.a.toSuiAddress();
    const addrB = stack.players.b.toSuiAddress();
    const partyA = { address: addrA, publicKey: ka.publicKey, signatureType: 0 };
    const partyB = { address: addrB, publicKey: kb.publicKey, signatureType: 0 };

    const openTx = new Transaction();
    buildOpenAndFundOneReturnless(
      openTx,
      { partyA, partyB, aAmount: 1000n, bAmount: 1000n, timeoutMs: 86_400_000n, penaltyAmount: 0n },
      {},
    );
    const openRes = await execute(stack.client, stack.players.a, openTx, { waitForFinality: true });
    const tunnelId = parseTunnelId(openRes.objectChanges);
    assert.ok(tunnelId, 'on-chain tunnel created');
    const openedFields = (await stack.client.getObject({ id: tunnelId, options: { showContent: true } })) as any;
    const createdAt = BigInt(openedFields.data.content.fields.created_at);

    // 2) Pair two seats over the LIVE relay (same game token -> matched to each other). The WS
    //    auth keys are throwaway Ed25519 keypairs, distinct from the engine co-signing keys.
    const game = `e2e-${tunnelId.slice(2, 18)}`;
    const [seat0, seat1] = await Promise.all([
      connectRelaySeat({ url: relayer.wsUrl, game, keypair: new Ed25519Keypair() }),
      connectRelaySeat({ url: relayer.wsUrl, game, keypair: new Ed25519Keypair() }),
    ]);
    assert.notEqual(seat0.role, seat1.role, 'relay assigned the two seats opposite roles');
    assert.equal(seat0.matchId, seat1.matchId, 'both seats share one matchId');
    const tA = seat0.role === 'A' ? seat0.transport : seat1.transport;
    const tB = seat0.role === 'A' ? seat1.transport : seat0.transport;

    // 3) One DistributedTunnel per seat over the relay transports. TicTacToe carries no secrets,
    //    so the identity move codec is sufficient.
    const proto = new TicTacToeProtocol(100n);
    const backend = defaultBackend();
    const balances = { a: 1000n, b: 1000n };
    const dtA = new DistributedTunnel(
      proto,
      { tunnelId, self: makeEndpoint(backend, addrA, ka, true), opponent: makeEndpoint(backend, addrB, kb, false), selfParty: 'A', moveCodec: bigintSafeCodec },
      tA,
      balances,
    );
    const dtB = new DistributedTunnel(
      proto,
      { tunnelId, self: makeEndpoint(backend, addrB, kb, true), opponent: makeEndpoint(backend, addrA, ka, false), selfParty: 'B', moveCodec: bigintSafeCodec },
      tB,
      balances,
    );
    const seatOf: Record<'A' | 'B', DistributedTunnel<unknown, unknown>> = { A: dtA, B: dtB };

    // 4) Play to terminal over the relay. Only the seat whose turn it is proposes; the other seat
    //    reacts to the relayed frame, re-applies, co-signs and ACKs — all over the real WS.
    const rng = mulberry32(7);
    let ts = createdAt;
    let moves = 0;
    for (let guard = 0; guard < 1000 && !proto.isTerminal(dtA.state); guard++) {
      const state = dtA.state;
      const by = state.turn;
      const move = proto.randomMove(state, by, rng);
      if (!move) break;
      ts += 1n;
      await proposeAndAwait(seatOf[by], move, ts);
      moves++;
    }
    assert.ok(moves > 0, 'at least one move co-signed over the relay');
    assert.equal(proto.isTerminal(dtA.state), true, 'game reached terminal over the relay');
    assert.deepEqual(proto.balances(dtA.state), proto.balances(dtB.state), 'both seats agree on the final balances');
    const finalBalances = proto.balances(dtA.state);
    assert.equal(finalBalances.a + finalBalances.b, 2000n, 'balances conserved over the relayed session');

    // 5) Combine the two settlement halves and settle on-chain (client-submitted cooperative close).
    const root = root32();
    const halfA = dtA.buildSettlementHalfWithRoot(createdAt + 1n, root, 0n);
    const halfB = dtB.buildSettlementHalfWithRoot(createdAt + 1n, root, 0n);
    const settlement = dtA.combineSettlementWithRoot(halfA.settlement, halfA.sigSelf, halfB.sigSelf);

    const closeTx = new Transaction();
    tb.buildCloseWithRootFromSettlement(closeTx, tunnelId, settlement);
    const closeRes = await execute(stack.client, stack.players.a, closeTx, { waitForFinality: true });

    const fields = ((await stack.client.getObject({ id: tunnelId, options: { showContent: true } })) as any).data.content
      .fields;
    const status = typeof fields.status === 'string' ? parseInt(fields.status, 10) : fields.status;
    assert.equal(status, CLOSED, 'tunnel CLOSED via the relay-played settlement');

    const ev: any[] =
      ((await stack.client.getTransactionBlock({ digest: closeRes.digest, options: { showEvents: true } })) as any)
        .events ?? [];
    const closed = ev.find((e) => e.type.endsWith('::tunnel::TunnelClosedWithRoot'));
    assert.ok(closed, 'TunnelClosedWithRoot emitted');
    assert.equal(BigInt(closed.parsedJson.party_a_balance), finalBalances.a, 'A on-chain payout matches the relayed balance');
    assert.equal(BigInt(closed.parsedJson.party_b_balance), finalBalances.b, 'B on-chain payout matches the relayed balance');

    seat0.close();
    seat1.close();
  },
);
