import { describe, expect, it } from "bun:test";
import { core, protocols } from "sui-tunnel-ts";
import { encodeStateHash, buildStateUpdateMsg, buildSettlementMsg } from "./state";

const TID = "0x" + "ab".padStart(64, "0");
const proto = new protocols.TicTacToeProtocol(0n);

describe("tunnel state helpers", () => {
  it("a state-update message round-trips through ed25519", () => {
    const kp = core.keyPairFromSecret(new Uint8Array(32).fill(1));
    const ctx = { tunnelId: TID, initialBalances: { a: 1n, b: 1n } };
    const s1 = proto.applyMove(proto.initialState(ctx), { cell: 0 }, "A");
    const msg = buildStateUpdateMsg(TID, encodeStateHash(proto, s1), 1n);
    const sig = core.sign(msg, kp.secretKey);
    expect(core.verify(sig, msg, kp.publicKey)).toBe(true);
    const bad = buildStateUpdateMsg(TID, encodeStateHash(proto, proto.applyMove(proto.initialState(ctx), { cell: 1 }, "A")), 1n);
    expect(core.verify(sig, bad, kp.publicKey)).toBe(false);
  });

  it("settlement message (1/1) verifies for both parties", () => {
    const kpA = core.keyPairFromSecret(new Uint8Array(32).fill(1));
    const kpB = core.keyPairFromSecret(new Uint8Array(32).fill(2));
    const msg = buildSettlementMsg(TID, 1n, 1n, 9n, 0n);
    expect(core.verify(core.sign(msg, kpA.secretKey), msg, kpA.publicKey)).toBe(true);
    expect(core.verify(core.sign(msg, kpB.secretKey), msg, kpB.publicKey)).toBe(true);
  });

  it("selfPlay plays a full game and the settlement sums to the locked total", () => {
    const kpA = core.keyPairFromSecret(new Uint8Array(32).fill(3));
    const kpB = core.keyPairFromSecret(new Uint8Array(32).fill(4));
    const t = core.OffchainTunnel.selfPlay(proto, TID, kpA, kpB, "0xa", "0xb", { a: 1n, b: 1n });
    for (const [cell, by] of [[0,"A"],[3,"B"],[1,"A"],[4,"B"],[2,"A"]] as [number,"A"|"B"][]) t.step({ cell }, by, { mode: "full" });
    const settle = t.buildSettlement(0n);
    expect(settle.settlement.partyABalance + settle.settlement.partyBBalance).toBe(2n);
  });
});
