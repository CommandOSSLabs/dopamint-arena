/**
 * Headless proof: full on-chain bot-vs-bot Blackjack tunnel lifecycle on testnet,
 * using the deployed `sui_tunnel` framework + this SDK. Mirrors the ticTacToe
 * `scripts/bot-vs-bot.ts` reference, swapped to BlackjackProtocol and SUI.
 *
 * Run:  SUI_FUNDER_KEY=<suiprivkey…> node --import tsx scripts/blackjackBotVsBot.ts
 * (SUI_FUNDER_KEY is any funded testnet key; it seeds the two fresh bot keypairs.)
 *
 * Flow: two fresh bot keypairs funded from SUI_FUNDER_KEY ->
 *   botA create_and_share -> both deposit STAKE -> selfPlay (every state dual-signed +
 *   verified, basic-strategy bots) -> botA close_cooperative -> coins paid out on-chain.
 */
import { core, protocols, createSuiClient, onchain, proof } from "../src/index.ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";

// Deployed sui_tunnel framework on testnet (see memory: sui-tunnel-testnet-deployment).
const PACKAGE_ID =
  "0x8b6cc035bc3d8c4defc27e80a398db428dde98bfdc669e5012bd80adb38af2d4";
process.env.PACKAGE_ID ??= PACKAGE_ID;

/** Per-party locked stake (MIST). Must be >= the protocol WAGER (100) to play. */
const STAKE = 500n;
/** Gas top-up sent to each bot (MIST) = 0.05 SUI. */
const FUND_PER_BOT = 50_000_000;

const proto = new protocols.BlackjackProtocol();
type State = protocols.BlackjackState;

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

/** Whose turn from the protocol phase: dealer -> B, otherwise A. */
function partyForPhase(s: State): "A" | "B" {
  return s.phase === "dealer" ? "B" : "A";
}

async function main() {
  const funderKey = process.env.SUI_FUNDER_KEY;
  if (!funderKey) throw new Error("set SUI_FUNDER_KEY=<suiprivkey…> (funded testnet key)");
  const client = createSuiClient("testnet");
  const funder = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(funderKey).secretKey);

  const botA = makeBot(); // player-bot
  const botB = makeBot(); // dealer-bot
  console.log("player-bot A:", botA.address, "\ndealer-bot B:", botB.address);

  // Fund both bots for gas (one tx from the funder).
  const fund = new Transaction();
  const [ca, cb] = fund.splitCoins(fund.gas, [FUND_PER_BOT, FUND_PER_BOT]);
  fund.transferObjects([ca], botA.address);
  fund.transferObjects([cb], botB.address);
  const fres = await client.signAndExecuteTransaction({
    signer: funder,
    transaction: fund,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: fres.digest });
  console.log("funded bots:", fres.digest);

  const partyArgs = (b: typeof botA) => ({
    address: b.address,
    publicKey: b.publicKey,
    signatureType: core.SignatureScheme.ED25519,
  });

  // 1) create + share the tunnel on-chain (botA pays gas).
  const { tunnelId, digest: createDigest } = await onchain.createTunnel(
    client,
    botA.keypair,
    {
      partyA: partyArgs(botA),
      partyB: partyArgs(botB),
      timeoutMs: 86_400_000n,
      penaltyAmount: 0n,
    },
    { waitForFinality: true },
  );
  console.log("create:", createDigest, "tunnel:", tunnelId);

  // Read the on-chain created_at — the settlement message is signed with it.
  const obj = await client.getObject({ id: tunnelId, options: { showContent: true } });
  const fields = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  const createdAt = BigInt((fields?.created_at as string) ?? 0);

  // 2) both parties deposit their stake (auto-activates on the 2nd deposit).
  console.log("deposit A:", await onchain.depositAs(client, botA.keypair, tunnelId, STAKE, { waitForFinality: true }));
  console.log("deposit B:", await onchain.depositAs(client, botB.keypair, tunnelId, STAKE, { waitForFinality: true }));

  // 3) off-chain self-play: bots co-sign every state update until the game is terminal.
  const tunnel = core.OffchainTunnel.selfPlay(
    proto,
    tunnelId,
    botA.coreKey,
    botB.coreKey,
    botA.address,
    botB.address,
    { a: STAKE, b: STAKE },
  );
  // Accumulate EVERY co-signed update into a transcript; its Merkle root commits to
  // the full play history and is anchored on-chain at close.
  const transcript = new proof.Transcript(tunnelId);
  tunnel.onUpdate = (u) => transcript.append(u);
  let steps = 0;
  while (!proto.isTerminal(tunnel.state) && steps < 5000) {
    const by = partyForPhase(tunnel.state);
    const move = proto.randomMove(tunnel.state, by, Math.random);
    if (!move) break;
    // Sign each update with the tunnel's on-chain created_at (a validator timestamp,
    // always <= now and >= created_at) so the latest co-signed state passes
    // update_state's timestamp checks regardless of local/validator clock skew.
    const r = tunnel.step(move, by, { mode: "full", timestamp: createdAt });
    if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);
    steps++;
  }
  const fin = tunnel.state;
  console.log(
    `played ${steps} signed moves over ${fin.round} rounds | ` +
      `final off-chain balances A=${fin.balanceA} B=${fin.balanceB}`,
  );

  // 4) checkpoint the FINAL co-signed state on-chain so the tunnel's StateCommitment
  // field shows the played-out state (nonce, state_hash, final balances) — not the
  // empty opening. Requires the update's timestamp >= created_at (set per-step above).
  const latest = tunnel.latest!;
  const utx = new Transaction();
  onchain.buildUpdateState(utx, {
    tunnelId,
    stateHash: latest.update.stateHash,
    nonce: latest.update.nonce,
    partyABalance: latest.update.partyABalance,
    partyBBalance: latest.update.partyBBalance,
    timestamp: latest.update.timestamp,
    sigA: latest.sigA,
    sigB: latest.sigB,
  });
  const ures = await client.signAndExecuteTransaction({
    signer: botA.keypair,
    transaction: utx,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: ures.digest });
  console.log("update_state:", ures.digest, "(on-chain nonce ->", latest.update.nonce + ")");

  // 5) settle with the transcript ROOT (close_cooperative_with_root): one tx distributes
  // final balances AND anchors a Merkle root committing to the FULL history. After
  // update_state the on-chain nonce is `latest.nonce`, so finalNonce = latest.nonce + 1.
  const root = transcript.root();
  console.log("transcript root:", "0x" + Buffer.from(root).toString("hex"), `(${steps} states)`);
  const settlement = tunnel.buildSettlementWithRoot(createdAt, root, latest.update.nonce);
  const ctx = new Transaction();
  onchain.buildCloseWithRootFromSettlement(ctx, tunnelId, settlement);
  const cres = await client.signAndExecuteTransaction({
    signer: botA.keypair,
    transaction: ctx,
    options: { showEffects: true, showEvents: true },
  });
  await client.waitForTransaction({ digest: cres.digest });
  console.log("close_with_root:", cres.digest);
  const rootEvent = cres.events?.find((e) => e.type.endsWith("::TunnelClosedWithRoot"));
  console.log("on-chain TunnelClosedWithRoot event:", rootEvent ? JSON.stringify(rootEvent.parsedJson) : "(not found)");

  // Show coins actually moved on-chain.
  const [ba, bb] = await Promise.all([
    client.getBalance({ owner: botA.address }),
    client.getBalance({ owner: botB.address }),
  ]);
  console.log(`on-chain bot balances now: A=${ba.totalBalance} MIST  B=${bb.totalBalance} MIST`);

  // Show the on-chain StateCommitment field now reflects the played-out final state.
  const finalObj = await client.getObject({ id: tunnelId, options: { showContent: true } });
  const sf = (finalObj.data?.content as { fields?: { state?: { fields?: Record<string, unknown> } } } | undefined)?.fields?.state?.fields;
  console.log("on-chain state field:", JSON.stringify(sf));
  console.log("\nBLACKJACK BOT-VS-BOT ON-CHAIN OK");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
