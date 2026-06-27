/**
 * Headless proof: full on-chain bot-vs-bot Blackjack tunnel lifecycle on testnet,
 * using the deployed `sui_tunnel` framework + this SDK. Mirrors the ticTacToe
 * `scripts/bot-vs-bot.ts` reference, swapped to BlackjackProtocol and SUI.
 *
 * Run:  SUI_FUNDER_KEY=<suiprivkey…> node --import tsx scripts/blackjackBotVsBot.ts
 * (SUI_FUNDER_KEY is any funded testnet key; it seeds the two fresh bot keypairs.)
 *
 * Flow: player-bot A funded from SUI_FUNDER_KEY (dealer-bot B holds no SUI) ->
 *   botA create_and_fund (ONE PTB: open + fund both stakes + activate) -> selfPlay (every
 *   state dual-signed + verified, basic-strategy bots) -> botA update_state(final) ->
 *   botA close_cooperative_with_root -> coins paid out on-chain.
 */
import {
  core,
  createSuiClient,
  onchain,
  proof,
  protocols,
} from "../src/index.ts";
// create_and_fund lives in its own module (a Dopamint extension); the SDK's own example imports
// it the same way rather than via the onchain barrel, keeping that upstream file conflict-free.
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { buildOpenAndFundMany } from "../src/onchain/createAndFund.ts";

// Deployed sui_tunnel framework on testnet (see memory: sui-tunnel-testnet-deployment).
// This build carries the `create_and_fund` extension used below.
const PACKAGE_ID =
  "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b";
process.env.PACKAGE_ID ??= PACKAGE_ID;

/** Per-party locked stake (MIST). Must be >= the protocol WAGER (100) to play. */
const STAKE = 500n;
/** Gas top-up sent to the player bot (MIST) = 0.1 SUI. It signs every on-chain tx; the
 *  dealer bot signs nothing (create_and_fund covers both stakes), so it needs no SUI. */
const FUND_PLAYER_BOT = 100_000_000;

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

/** Which party owes the next move; the self-play loop applies exactly one per step. */
function nextActor(s: State): "A" | "B" | null {
  if (proto.isTerminal(s)) return null;
  switch (s.phase) {
    case "round_over":
      return protocols.getPlayerParty(s.round + 1n);
    case "draw_commit":
      return !s.pendingCommitA ? "A" : !s.pendingCommitB ? "B" : null;
    case "draw_reveal":
      return !s.pendingRevealA ? "A" : !s.pendingRevealB ? "B" : null;
    case "player":
      return protocols.getPlayerParty(s.round);
    default:
      return null;
  }
}

async function main() {
  const funderKey = process.env.SUI_FUNDER_KEY;
  if (!funderKey)
    throw new Error("set SUI_FUNDER_KEY=<suiprivkey…> (funded testnet key)");
  const client = createSuiClient("testnet");
  const funder = Ed25519Keypair.fromSecretKey(
    decodeSuiPrivateKey(funderKey).secretKey,
  );

  const botA = makeBot(); // player-bot
  const botB = makeBot(); // dealer-bot
  console.log("player-bot A:", botA.address, "\ndealer-bot B:", botB.address);

  // Fund ONLY the player bot for gas (one tx from the funder). It signs every on-chain tx and
  // funds both stakes via create_and_fund; the dealer bot signs nothing, so it gets no SUI.
  const fund = new Transaction();
  const [ca] = fund.splitCoins(fund.gas, [FUND_PLAYER_BOT]);
  fund.transferObjects([ca], botA.address);
  const fres = await client.signAndExecuteTransaction({
    signer: funder,
    transaction: fund,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: fres.digest });
  console.log("funded player-bot A:", fres.digest);

  const partyArgs = (b: typeof botA) => ({
    address: b.address,
    publicKey: b.publicKey,
    signatureType: core.SignatureScheme.ED25519,
  });

  // 1) open + fund (both stakes) + activate in ONE PTB via create_and_fund. botA splits both
  // stakes off its gas coin and signs once; no separate deposits, and the tunnel is active the
  // moment this lands (TunnelCreated + TunnelActivated fire in the same checkpoint).
  const openTx = new Transaction();
  buildOpenAndFundMany(openTx, [
    {
      partyA: partyArgs(botA),
      partyB: partyArgs(botB),
      aAmount: STAKE,
      bAmount: STAKE,
      timeoutMs: 86_400_000n,
      penaltyAmount: 0n,
    },
  ]);
  const openRes = await client.signAndExecuteTransaction({
    signer: botA.keypair,
    transaction: openTx,
    options: { showObjectChanges: true, showEffects: true },
  });
  if (openRes.effects?.status?.status !== "success")
    throw new Error(
      `create_and_fund failed: ${openRes.effects?.status?.error ?? "unknown"}`,
    );
  await client.waitForTransaction({ digest: openRes.digest });
  const tunnelId = onchain.parseTunnelId(openRes.objectChanges);
  if (!tunnelId) throw new Error("could not find created Tunnel id");
  console.log("create_and_fund:", openRes.digest, "tunnel:", tunnelId);

  // Read the on-chain created_at — the settlement message is signed with it.
  const obj = await client.getObject({
    id: tunnelId,
    options: { showContent: true },
  });
  const fields = (
    obj.data?.content as { fields?: Record<string, unknown> } | undefined
  )?.fields;
  const createdAt = BigInt((fields?.created_at as string) ?? 0);

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
    const by = nextActor(tunnel.state);
    if (!by) break;
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
  console.log(
    "update_state:",
    ures.digest,
    "(on-chain nonce ->",
    latest.update.nonce + ")",
  );

  // 5) settle with the transcript ROOT (close_cooperative_with_root): one tx distributes
  // final balances AND anchors a Merkle root committing to the FULL history. After
  // update_state the on-chain nonce is `latest.nonce`, so finalNonce = latest.nonce + 1.
  const root = transcript.root();
  console.log(
    "transcript root:",
    "0x" + Buffer.from(root).toString("hex"),
    `(${steps} states)`,
  );
  const settlement = tunnel.buildSettlementWithRoot(
    createdAt,
    root,
    latest.update.nonce,
  );
  const ctx = new Transaction();
  onchain.buildCloseWithRootFromSettlement(ctx, tunnelId, settlement);
  const cres = await client.signAndExecuteTransaction({
    signer: botA.keypair,
    transaction: ctx,
    options: { showEffects: true, showEvents: true },
  });
  await client.waitForTransaction({ digest: cres.digest });
  console.log("close_with_root:", cres.digest);
  const rootEvent = cres.events?.find((e) =>
    e.type.endsWith("::TunnelClosedWithRoot"),
  );
  console.log(
    "on-chain TunnelClosedWithRoot event:",
    rootEvent ? JSON.stringify(rootEvent.parsedJson) : "(not found)",
  );

  // Show coins actually moved on-chain.
  const [ba, bb] = await Promise.all([
    client.getBalance({ owner: botA.address }),
    client.getBalance({ owner: botB.address }),
  ]);
  console.log(
    `on-chain bot balances now: A=${ba.totalBalance} MIST  B=${bb.totalBalance} MIST`,
  );

  // Show the on-chain StateCommitment field now reflects the played-out final state.
  const finalObj = await client.getObject({
    id: tunnelId,
    options: { showContent: true },
  });
  const sf = (
    finalObj.data?.content as
      | { fields?: { state?: { fields?: Record<string, unknown> } } }
      | undefined
  )?.fields?.state?.fields;
  console.log("on-chain state field:", JSON.stringify(sf));
  console.log("\nBLACKJACK BOT-VS-BOT ON-CHAIN OK");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
