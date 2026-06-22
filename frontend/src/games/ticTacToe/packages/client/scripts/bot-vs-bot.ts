/**
 * Headless proof / dev tool: full on-chain bot-vs-bot tunnel lifecycle on testnet.
 * Run from the repo: `SUI_FUNDER_KEY=<suiprivkey…> bun run packages/client/scripts/bot-vs-bot.ts`
 * (SUI_FUNDER_KEY is any funded testnet key; it seeds the two fresh bot keypairs.)
 *
 * Generates two fresh bot keypairs, funds them from SUI_FUNDER_KEY, then:
 *   botX create_and_share -> both deposit 1 MIST -> selfPlay (every state dual-signed +
 *   verified) -> botX close_cooperative (settlement 1/1). Mirrors what the in-browser app does.
 */
import { core, protocols, createSuiClient, onchain } from "sui-tunnel-ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import {
  optimalMoves,
  CELL_EMPTY,
  CELL_PLAYER,
  CELL_SERVER,
} from "@ttt/shared";

const PACKAGE_ID =
  "0x8fd369d75838721d56b47b302e5eb85ff9c77cdb1182e81a08bdee5463027a46";
process.env.PACKAGE_ID ??= PACKAGE_ID;

const proto = new protocols.TicTacToeProtocol(0n);
type State = protocols.TicTacToeState;

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function makeBot() {
  const k = core.generateKeyPair();
  const keypair = Ed25519Keypair.fromSecretKey(k.secretKey);
  if (toHex(keypair.getPublicKey().toRawBytes()) !== toHex(k.publicKey))
    throw new Error("off/on-chain pubkey mismatch");
  return {
    coreKey: k,
    keypair,
    address: keypair.getPublicKey().toSuiAddress(),
    publicKey: k.publicKey,
  };
}

function minimaxCell(state: State, party: "A" | "B"): number {
  const mark = party === "A" ? 1 : 2;
  const board = state.board.map((v) =>
    v === 0 ? CELL_EMPTY : v === mark ? CELL_SERVER : CELL_PLAYER,
  );
  return optimalMoves(board, CELL_SERVER)[0];
}
function randomishCell(state: State, party: "A" | "B"): number {
  const me = party === "A" ? 1 : 2;
  const opp = me === 1 ? 2 : 1;
  const empties = state.board
    .map((v, i) => (v === 0 ? i : -1))
    .filter((i) => i >= 0);
  const LINES = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  const finish = (who: number) => {
    for (const [a, b, c] of LINES) {
      const empt = [a, b, c].find((i) => state.board[i] === 0);
      const mine = [a, b, c].filter((i) => state.board[i] === who).length;
      if (mine === 2 && empt !== undefined) return empt;
    }
    return -1;
  };
  const w = finish(me);
  if (w >= 0) return w;
  const b = finish(opp);
  if (b >= 0) return b;
  return empties[Math.floor(Math.random() * empties.length)];
}

async function main() {
  const funderKey = process.env.SUI_FUNDER_KEY;
  if (!funderKey)
    throw new Error("set SUI_FUNDER_KEY=<suiprivkey…> (a funded testnet key)");
  const client = createSuiClient("testnet");
  const funder = Ed25519Keypair.fromSecretKey(
    decodeSuiPrivateKey(funderKey).secretKey,
  );

  const botX = makeBot();
  const botO = makeBot();
  console.log("botX:", botX.address, "\nbotO:", botO.address);

  const fund = new Transaction();
  const [cx, co] = fund.splitCoins(fund.gas, [50_000_000, 50_000_000]);
  fund.transferObjects([cx], botX.address);
  fund.transferObjects([co], botO.address);
  const fres = await client.signAndExecuteTransaction({
    signer: funder,
    transaction: fund,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: fres.digest });
  console.log("funded:", fres.digest);

  const partyArgs = (b: typeof botX) => ({
    address: b.address,
    publicKey: b.publicKey,
    signatureType: core.SignatureScheme.ED25519,
  });
  const { tunnelId, digest: createDigest } = await onchain.createTunnel(
    client,
    botX.keypair,
    {
      partyA: partyArgs(botX),
      partyB: partyArgs(botO),
      timeoutMs: 86_400_000n,
      penaltyAmount: 0n,
    },
    { waitForFinality: true },
  );
  console.log("create:", createDigest, "tunnel:", tunnelId);

  const obj = await client.getObject({
    id: tunnelId,
    options: { showContent: true },
  });
  const fields = (
    obj.data?.content as { fields?: Record<string, unknown> } | undefined
  )?.fields;
  const createdAt = BigInt((fields?.created_at as string) ?? 0);

  console.log(
    "deposit X:",
    await onchain.depositAs(client, botX.keypair, tunnelId, 1n, {
      waitForFinality: true,
    }),
  );
  console.log(
    "deposit O:",
    await onchain.depositAs(client, botO.keypair, tunnelId, 1n, {
      waitForFinality: true,
    }),
  );

  const tunnel = core.OffchainTunnel.selfPlay(
    proto,
    tunnelId,
    botX.coreKey,
    botO.coreKey,
    botX.address,
    botO.address,
    { a: 1n, b: 1n },
  );
  let n = 0;
  while (!proto.isTerminal(tunnel.state) && n < 9) {
    const by = tunnel.state.turn as "A" | "B";
    const cell =
      by === "A"
        ? minimaxCell(tunnel.state, by)
        : randomishCell(tunnel.state, by);
    const r = tunnel.step({ cell }, by, { mode: "full" });
    if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);
    console.log(`  move ${n} by ${by} -> ${cell} | nonce ${r.nonce} | ✓`);
    n++;
  }
  const w = tunnel.state.winner;
  console.log("winner:", w === 1 ? "botX" : w === 2 ? "botO" : "draw");

  const settlement = tunnel.buildSettlement(createdAt, 0n);
  console.log(
    "close:",
    await onchain.closeCooperative(client, botX.keypair, tunnelId, settlement, {
      waitForFinality: true,
    }),
  );
  console.log("\nBOT-VS-BOT ON-CHAIN OK");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
