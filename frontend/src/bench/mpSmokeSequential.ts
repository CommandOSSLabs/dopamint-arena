import { core } from "sui-tunnel-ts";
import { MpClient } from "@/pvp/mpClient";

const url = "ws://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com/v1/mp";
const game = `blackjack-0-${Date.now()}`;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  const walletA = core.generateKeyPair();
  const walletB = core.generateKeyPair();
  const clientA = new MpClient(url, core.ed25519Address(walletA.publicKey), walletA);
  const clientB = new MpClient(url, core.ed25519Address(walletB.publicKey), walletB);

  console.error("connecting...");
  await Promise.all([clientA.connect(), clientB.connect()]);
  console.error("connected");

  console.error("A joining...", game);
  const mA = await Promise.race([
    clientA.quickMatch(game),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("A match timeout")), 8000))
  ]);
  console.error("A matched", JSON.stringify(mA));

  await sleep(50);

  console.error("B joining...", game);
  const mB = await Promise.race([
    clientB.quickMatch(game),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("B match timeout")), 8000))
  ]);
  console.error("B matched", JSON.stringify(mB));

  console.error("OK");
  process.exit(0);
})().catch(e => {
  console.error("FAIL", e);
  process.exit(1);
});
