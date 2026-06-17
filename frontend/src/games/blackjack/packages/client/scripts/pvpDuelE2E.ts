import { core, bytesToHex } from "sui-tunnel-ts";
import { RelayClient } from "../src/lib/bjRelay";
import { BlackjackDuelProtocol, STAKE, type DuelState, type DuelMove } from "../src/lib/bjDuelProtocol";

const URL = process.env.MP_URL ?? "ws://127.0.0.1:8080";
const GAME = "blackjack";
const TUNNEL = "0x" + "11".repeat(32); // valid 32-byte hex placeholder (engine signs over it; never reads the chain)

function mkSeat(name: string) {
  const wallet = core.generateKeyPair();           // stand-in wallet (address only here)
  const eph = core.generateKeyPair();
  return { name, wallet, walletAddr: core.ed25519Address(wallet.publicKey), eph: core.keyPairFromSecret(eph.secretKey) };
}

async function run() {
  const a = mkSeat("A");
  const b = mkSeat("B");
  const ra = new RelayClient(URL, a.walletAddr, a.eph);
  const rb = new RelayClient(URL, b.walletAddr, b.eph);
  await Promise.all([ra.ready, rb.ready]);

  const matched = new Promise<{ ma: any; mb: any }>((resolve) => {
    let ma: any, mb: any;
    ra.on("match.found", (m) => { ma = m; if (mb) resolve({ ma, mb }); });
    rb.on("match.found", (m) => { mb = m; if (ma) resolve({ ma, mb }); });
  });
  ra.queueJoin(GAME);
  await new Promise((r) => setTimeout(r, 150));
  rb.queueJoin(GAME);
  const { ma } = await matched;
  const matchId = ma.matchId;

  const backend = core.defaultBackend();
  const mk = (self: typeof a, opp: typeof b, role: "A" | "B", relay: RelayClient) =>
    new core.DistributedTunnel<DuelState, DuelMove>(
      new BlackjackDuelProtocol(),
      {
        tunnelId: TUNNEL,
        self: core.makeEndpoint(backend, self.walletAddr, { publicKey: self.eph.publicKey, scheme: 0, secretKey: self.eph.secretKey }, true),
        opponent: core.makeEndpoint(backend, opp.walletAddr, { publicKey: opp.eph.publicKey, scheme: 0 }, false),
        selfParty: role,
      },
      relay.transport(matchId),
      { a: STAKE, b: STAKE },
    );
  const ta = mk(a, b, "A", ra);
  const tb = mk(b, a, "B", rb);

  // Both bots: whenever it's my turn, propose basic strategy until terminal.
  const proto = new BlackjackDuelProtocol();
  const drive = (t: core.DistributedTunnel<DuelState, DuelMove>, seat: "A" | "B") => {
    const step = () => {
      const s = t.state;
      if (proto.isTerminal(s)) return;
      const turn = s.phase === "a_turn" ? "A" : "B";
      if (turn !== seat) return;
      const mv = proto.randomMove(s, seat, Math.random);
      if (mv) t.propose(mv, BigInt(1)); // fixed ts; not chain-checked in this headless test
    };
    t.onConfirmed = () => step();
    return step;
  };
  drive(ta, "A")(); // A kicks off (it's a_turn)
  drive(tb, "B");

  // Wait for both to reach terminal.
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (proto.isTerminal(ta.state) && proto.isTerminal(tb.state)) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > 15000) { clearInterval(iv); reject(new Error("duel did not terminate")); }
    }, 50);
  });

  const ba = ta.protocol.balances(ta.state);
  const bbal = tb.protocol.balances(tb.state);
  const ok1 = ba.a === bbal.a && ba.b === bbal.b && ba.a + ba.b === STAKE * 2n;
  console.log(ok1 ? "PASS  both seats agree on final balances" : "FAIL  balances differ", `A=${ba.a} B=${ba.b}`);

  // Exchange + combine settlement halves over the relay (app channel).
  const ha = ta.buildSettlementHalf(BigInt(1));
  const hb = tb.buildSettlementHalf(BigInt(1));
  const gotB = new Promise<Uint8Array>((res) => ra.onApp(matchId, (m) => { if (m.t === "settle") res(Uint8Array.from(Buffer.from(String(m.sig), "hex"))); }));
  const gotA = new Promise<Uint8Array>((res) => rb.onApp(matchId, (m) => { if (m.t === "settle") res(Uint8Array.from(Buffer.from(String(m.sig), "hex"))); }));
  rb.sendApp(matchId, { t: "settle", sig: bytesToHex(hb.sigSelf) });
  ra.sendApp(matchId, { t: "settle", sig: bytesToHex(ha.sigSelf) });
  const coSignedA = ta.combineSettlement(ha.settlement, ha.sigSelf, await gotB);
  void tb.combineSettlement(hb.settlement, hb.sigSelf, await gotA);
  const ok2 = !!coSignedA.sigA && !!coSignedA.sigB;
  console.log(ok2 ? "PASS  settlement co-signed + verified" : "FAIL  settlement combine");

  ra.close(); rb.close();
  const allOk = ok1 && ok2;
  console.log(allOk ? "\nHEADLESS PVP DUEL OK" : "\nFAILED");
  process.exit(allOk ? 0 : 1);
}
run().catch((e) => { console.error("E2E ERROR:", e); process.exit(2); });
