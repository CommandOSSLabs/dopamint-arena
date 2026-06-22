import { core } from "sui-tunnel-ts";
import { MpClient } from "@/pvp/mpClient";

const url = "ws://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com/v1/mp";
const game = `blackjack-0-${Date.now()}`;

async function client(name: string, delayMs: number) {
  const kp = core.generateKeyPair();
  const c = new MpClient(url, core.ed25519Address(kp.publicKey), kp);
  console.error(`${name}: connecting...`);
  await c.connect();
  console.error(`${name}: connected`);
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  console.error(`${name}: joining ${game}`);
  const m = await Promise.race([
    c.quickMatch(game),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("match timeout")), 8000))
  ]);
  console.error(`${name}: matched`, JSON.stringify(m));
  c.close?.();
}

(async () => {
  try {
    await Promise.all([client("c1", 0), client("c2", 500)]);
    console.error("OK");
    process.exit(0);
  } catch (e) {
    console.error("FAIL", e);
    process.exit(1);
  }
})();
