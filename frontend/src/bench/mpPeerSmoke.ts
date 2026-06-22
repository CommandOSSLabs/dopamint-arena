import { core } from "sui-tunnel-ts";
import { MpClient } from "@/pvp/mpClient";

const url = "ws://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com/v1/mp";
const game = `blackjack-peer-${Date.now()}`;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  const walletA = core.generateKeyPair();
  const walletB = core.generateKeyPair();
  const clientA = new MpClient(url, core.ed25519Address(walletA.publicKey), walletA);
  const clientB = new MpClient(url, core.ed25519Address(walletB.publicKey), walletB);

  await Promise.all([clientA.connect(), clientB.connect()]);
  const pA = clientA.quickMatch(game);
  await sleep(50);
  const pB = clientB.quickMatch(game);
  const [mA, mB] = await Promise.all([pA, pB]);
  console.error("matched", mA.matchId);

  const chA = clientA.channel(mA.matchId);
  const chB = clientB.channel(mB.matchId);

  const gotA = new Promise<string>(resolve => chA.onPeer(msg => { if (msg.t === "hello") resolve(msg.ephemeralPubkey); }));
  const gotB = new Promise<string>(resolve => chB.onPeer(msg => { if (msg.t === "hello") resolve(msg.ephemeralPubkey); }));

  console.error("sending hellos");
  chA.sendPeer({ t: "hello", ephemeralPubkey: core.toHex(walletA.publicKey) });
  chB.sendPeer({ t: "hello", ephemeralPubkey: core.toHex(walletB.publicKey) });

  const [pubB, pubA] = await Promise.all([
    Promise.race([gotA, new Promise<never>((_, r) => setTimeout(() => r(new Error("A timeout")), 5000))]),
    Promise.race([gotB, new Promise<never>((_, r) => setTimeout(() => r(new Error("B timeout")), 5000))]),
  ]);
  console.error("A got", pubB);
  console.error("B got", pubA);
  console.error("OK");
  process.exit(0);
})().catch(e => {
  console.error("FAIL", e);
  process.exit(1);
});
