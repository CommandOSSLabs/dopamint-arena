import { core } from "sui-tunnel-ts";
import { MpClient } from "../pvp/mpClient.js";

const url = process.env.MP_URL || "ws://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com/v1/mp";

async function client(name: string, game: string, delayMs: number) {
  const kp = core.generateKeyPair();
  const c = new MpClient(url, core.ed25519Address(kp.publicKey), kp);
  console.log(`${name}: connecting...`);
  await c.connect();
  console.log(`${name}: connected`);
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  console.log(`${name}: joining ${game}`);
  const m = await Promise.race([
    c.quickMatch(game),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("match timeout")), 8000))
  ]);
  console.log(`${name}: matched`, JSON.stringify(m));
  c.close?.();
}

(async () => {
  try {
    await Promise.all([client("c1", "blackjack", 0), client("c2", "blackjack", 500)]);
    console.log("OK");
  } catch (e) {
    console.error("FAIL", e);
  }
  process.exit(0);
})();
