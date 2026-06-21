/**
 * Continuous on-chain Blackjack TPS bot — a long-running server daemon.
 *
 * Plays real on-chain Blackjack games back-to-back at full speed to push throughput.
 * The throughput story is the state-channel one: each tunnel anchors MANY off-chain,
 * dual-signed state transitions on-chain with only TWO on-chain transactions
 * (`create_and_fund` to open + `close_cooperative_with_root` to settle). The Merkle
 * root signed into the close commits to every off-chain update, so all of that
 * off-chain activity counts as anchored throughput. `ROUNDS_PER_TUNNEL` is the lever:
 * more hands per tunnel => more anchored state transitions per on-chain tx.
 *
 * Parallelism: opening/closing tunnels are shared-object consensus txs; a single signer
 * serializes them on its one gas coin. So we fund a POOL of independent player accounts
 * and run one worker per account — their txs don't contend (see onchain/gas.ts).
 *
 * Run (server):
 *   SUI_FUNDER_KEY=<suiprivkey…> \
 *   ROUNDS_PER_TUNNEL=50 SIGNERS=4 CONCURRENCY=4 \
 *   node --import tsx scripts/blackjackTpsBot.ts
 *
 * Every knob is an env var (see CONFIG below). Stop with Ctrl-C; it drains in-flight
 * games and prints a final report.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { core, protocols, createSuiClient, onchain, proof } from "../src/index.ts";
// create_and_fund is a Dopamint extension; import it directly (not via the onchain
// barrel) so an upstream SDK re-sync stays a clean no-conflict merge.
import { buildOpenAndFundMany } from "../src/onchain/createAndFund.ts";
import {
  getPlayerParty,
  getDealerParty,
  WAGER,
  ROUND_CAP,
  type BlackjackState,
} from "../src/protocol/blackjack.ts";
import type { Party } from "../src/protocol/Protocol.ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";

// Deployed sui_tunnel framework on testnet (carries the create_and_fund extension).
const PACKAGE_ID =
  "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b";
process.env.PACKAGE_ID ??= PACKAGE_ID;

// ============================================================================
// CONFIG — every lever is an env var with a sane default.
// ============================================================================
const intEnv = (k: string, d: number) =>
  process.env[k] !== undefined ? Math.trunc(Number(process.env[k])) : d;
const bigEnv = (k: string, d: bigint) =>
  process.env[k] !== undefined ? BigInt(process.env[k]!) : d;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const NETWORK = (process.env.NETWORK ?? "testnet") as "testnet" | "devnet" | "localnet" | "mainnet";
/** Hands played off-chain per tunnel before settling. THE throughput lever. */
const ROUNDS_PER_TUNNEL = clamp(intEnv("ROUNDS_PER_TUNNEL", 50), 1, Number(ROUND_CAP));
/** Funded player accounts (round-robin) — the on-chain parallelism lever. */
const SIGNERS = Math.max(1, intEnv("SIGNERS", 4));
/** Games in flight at once. Default 1:1 with signers so no two contend on a gas coin. */
const CONCURRENCY = Math.max(1, intEnv("CONCURRENCY", SIGNERS));
/** Tunnels opened per create_and_fund PTB (amortizes the open tx). */
const GAMES_PER_OPEN = Math.max(1, intEnv("GAMES_PER_OPEN", 1));
/**
 * Per-party locked stake (MIST). Auto-sized so an all-loss streak still survives every
 * round (a side needs >= WAGER to keep playing; worst case it loses WAGER each round).
 */
const STAKE = bigEnv("STAKE", WAGER * BigInt(ROUNDS_PER_TUNNEL + 1));
/** Gas funded to each player account at startup / on refill (MIST). 0.2 SUI. */
const GAS_PER_SIGNER = bigEnv("GAS_PER_SIGNER", 200_000_000n);
/** Refill a player below this (MIST). 0.02 SUI. */
const MIN_SIGNER_GAS = bigEnv("MIN_SIGNER_GAS", 20_000_000n);
/** Stop after this many ms (0 = run until Ctrl-C). */
const DURATION_MS = intEnv("DURATION_MS", 0);
/** Top the funder up from the testnet faucet when it runs low. */
const USE_FAUCET = (process.env.USE_FAUCET ?? "true") !== "false";

const proto = new protocols.BlackjackProtocol();
const TIMEOUT_MS = 86_400_000n;

// ============================================================================
// PURE PLAY LOGIC (exported for tests)
// ============================================================================

/**
 * Whose turn it is, derived from the protocol's own turn rules. Critical: Blackjack
 * alternates which PARTY is the player every two rounds, so the turn can't be inferred
 * from the phase alone (the naive "dealer phase => B, else A" stalls after round 2).
 */
export function partyToMove(s: Pick<BlackjackState, "phase" | "round">): Party {
  if (s.phase === "dealer") return getDealerParty(s.round);
  if (s.phase === "round_over") return getPlayerParty(s.round + 1n); // next round's player deals
  return getPlayerParty(s.round); // "player" phase
}

/**
 * Drive a self-play tunnel for exactly `maxRounds` Blackjack hands (or until the game
 * goes terminal), co-signing every state transition. Returns how many rounds completed
 * and how many co-signed updates were produced (== transcript length when wired up).
 */
export function playBoundedRounds(
  tunnel: {
    state: BlackjackState;
    step: (m: { action: "hit" | "stand" }, by: Party, o: { mode: "full"; timestamp: bigint }) => { verified: boolean; nonce: bigint };
  },
  protocol: protocols.BlackjackProtocol,
  maxRounds: number,
  timestamp: bigint,
): { rounds: number; updates: number } {
  let updates = 0;
  // ROUND_CAP-derived hard ceiling on steps so a logic bug can't spin forever.
  const stepCeiling = maxRounds * 12 + 16;
  while (!protocol.isTerminal(tunnel.state)) {
    const s = tunnel.state;
    // Stop once the requested number of hands have been dealt AND the last one resolved.
    if (Number(s.round) >= maxRounds && s.phase === "round_over") break;
    const by = partyToMove(s);
    const move = protocol.randomMove(s, by, Math.random);
    if (!move) break;
    const r = tunnel.step(move, by, { mode: "full", timestamp });
    if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);
    if (++updates > stepCeiling) throw new Error("play exceeded step ceiling (bug)");
  }
  return { rounds: Number(tunnel.state.round), updates };
}

/** All tunnel ids created by a create_and_fund (batch-safe; parseTunnelId returns only one). */
export function parseAllTunnelIds(objectChanges: unknown): string[] {
  if (!Array.isArray(objectChanges)) return [];
  const ids: string[] = [];
  for (const c of objectChanges as Array<Record<string, unknown>>) {
    if (
      c.type === "created" &&
      typeof c.objectType === "string" &&
      c.objectType.includes("::tunnel::Tunnel<") &&
      typeof c.objectId === "string"
    ) {
      ids.push(c.objectId);
    }
  }
  return ids;
}

// ============================================================================
// DAEMON
// ============================================================================

interface Bot {
  coreKey: ReturnType<typeof core.generateKeyPair>;
  keypair: Ed25519Keypair;
  address: string;
  publicKey: Uint8Array;
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function makeBot(): Bot {
  const k = core.generateKeyPair();
  const keypair = Ed25519Keypair.fromSecretKey(k.secretKey);
  if (toHex(keypair.getPublicKey().toRawBytes()) !== toHex(k.publicKey))
    throw new Error("off/on-chain pubkey mismatch");
  return { coreKey: k, keypair, address: keypair.getPublicKey().toSuiAddress(), publicKey: k.publicKey };
}

const partyArgs = (b: Bot) => ({
  address: b.address,
  publicKey: b.publicKey,
  signatureType: core.SignatureScheme.ED25519,
});

class Metrics {
  onchainTx = 0;
  tunnelsOpened = 0;
  tunnelsSettled = 0;
  rounds = 0;
  updates = 0;
  failures = 0;
  readonly start = Date.now();
  peakTps = 0;
  peakTxps = 0;
  private last = { onchainTx: 0, updates: 0, rounds: 0, t: Date.now() };

  tick(): void {
    const now = Date.now();
    const dt = (now - this.last.t) / 1000;
    if (dt <= 0) return;
    const tps = (this.updates - this.last.updates) / dt; // anchored state-transitions / sec
    const txps = (this.onchainTx - this.last.onchainTx) / dt;
    const rps = (this.rounds - this.last.rounds) / dt;
    this.peakTps = Math.max(this.peakTps, tps);
    this.peakTxps = Math.max(this.peakTxps, txps);
    const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
    console.log(
      `[tps] eff ${n(tps)} upd/s (peak ${n(this.peakTps)}) | ${n(rps)} rounds/s | ` +
        `${txps.toFixed(1)} onchain-tx/s (peak ${this.peakTxps.toFixed(1)}) | ` +
        `settled ${n(this.tunnelsSettled)} | fails ${this.failures}`,
    );
    this.last = { onchainTx: this.onchainTx, updates: this.updates, rounds: this.rounds, t: now };
  }

  report(): string {
    const secs = (Date.now() - this.start) / 1000;
    const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
    return [
      "",
      "Blackjack on-chain TPS bot — final report",
      `  elapsed         : ${secs.toFixed(1)}s`,
      `  tunnels settled : ${n(this.tunnelsSettled)} (opened ${n(this.tunnelsOpened)})`,
      `  rounds played   : ${n(this.rounds)}  (${n(this.rounds / secs)}/s avg)`,
      `  anchored updates: ${n(this.updates)}  (eff TPS avg ${n(this.updates / secs)}, peak ${n(this.peakTps)})`,
      `  on-chain txs    : ${n(this.onchainTx)}  (${(this.onchainTx / secs).toFixed(1)}/s avg, peak ${this.peakTxps.toFixed(1)})`,
      `  failures        : ${this.failures}`,
    ].join("\n");
  }
}

async function main() {
  const funderKey = process.env.SUI_FUNDER_KEY;
  if (!funderKey) throw new Error("set SUI_FUNDER_KEY=<suiprivkey…> (a funded testnet key)");
  const client = createSuiClient(NETWORK);
  const funder = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(funderKey).secretKey);
  const funderAddr = funder.getPublicKey().toSuiAddress();

  console.log(
    [
      "Blackjack on-chain TPS bot",
      `  network          : ${NETWORK}`,
      `  package          : ${process.env.PACKAGE_ID}`,
      `  funder           : ${funderAddr}`,
      `  ROUNDS_PER_TUNNEL: ${ROUNDS_PER_TUNNEL}  (more = more anchored updates per settle)`,
      `  SIGNERS          : ${SIGNERS}  CONCURRENCY: ${CONCURRENCY}  GAMES_PER_OPEN: ${GAMES_PER_OPEN}`,
      `  STAKE            : ${STAKE} MIST/side   GAS_PER_SIGNER: ${GAS_PER_SIGNER} MIST`,
      `  duration         : ${DURATION_MS ? DURATION_MS + "ms" : "until Ctrl-C"}`,
    ].join("\n"),
  );

  const dealer = makeBot(); // house / party B — signs off-chain only, never touches chain
  const players = Array.from({ length: SIGNERS }, makeBot); // party A pool

  // Fund the player pool from the funder in ONE PTB.
  await topUpFunder(client, funderAddr, GAS_PER_SIGNER * BigInt(SIGNERS) + 50_000_000n);
  await fundPlayers(client, funder, players, GAS_PER_SIGNER);
  console.log(`funded ${SIGNERS} player accounts with ${GAS_PER_SIGNER} MIST each`);

  const m = new Metrics();
  let shutdown = false;
  const stop = () => {
    if (!shutdown) console.log("\nshutting down — draining in-flight games…");
    shutdown = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const meter = setInterval(() => m.tick(), 1000);
  const keeper = setInterval(() => {
    void gasKeeper(client, funder, funderAddr, players).catch((e) => console.warn("gasKeeper:", e?.message ?? e));
  }, 3000);

  const expired = () => shutdown || (DURATION_MS > 0 && Date.now() - m.start >= DURATION_MS);

  async function worker(idx: number): Promise<void> {
    const player = players[idx % players.length];
    while (!expired()) {
      try {
        const games = await openGames(client, player, dealer, GAMES_PER_OPEN, m);
        for (const g of games) {
          if (expired()) break;
          await playAndSettle(client, player, dealer, g, m);
        }
      } catch (e) {
        m.failures++;
        console.warn(`worker ${idx}:`, (e as Error)?.message ?? e);
        await sleep(250); // brief backoff so a persistent error doesn't hot-loop
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

  clearInterval(meter);
  clearInterval(keeper);
  console.log(m.report());
}

interface OpenGame {
  tunnelId: string;
  createdAt: bigint;
}

/** Open `count` tunnels in one create_and_fund PTB; returns each tunnel id + its created_at. */
async function openGames(
  client: ReturnType<typeof createSuiClient>,
  player: Bot,
  dealer: Bot,
  count: number,
  m: Metrics,
): Promise<OpenGame[]> {
  const tx = new Transaction();
  buildOpenAndFundMany(
    tx,
    Array.from({ length: count }, () => ({
      partyA: partyArgs(player),
      partyB: partyArgs(dealer),
      aAmount: STAKE,
      bAmount: STAKE,
      timeoutMs: TIMEOUT_MS,
      penaltyAmount: 0n,
    })),
  );
  const res = await client.signAndExecuteTransaction({
    signer: player.keypair,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });
  if (res.effects?.status?.status !== "success")
    throw new Error(`create_and_fund failed: ${res.effects?.status?.error ?? "unknown"}`);
  await client.waitForTransaction({ digest: res.digest });
  m.onchainTx++;
  const ids = parseAllTunnelIds(res.objectChanges);
  if (ids.length === 0) throw new Error("no Tunnel id in create_and_fund effects");
  m.tunnelsOpened += ids.length;
  // All tunnels in one PTB share the same checkpoint timestamp, so read created_at once.
  const obj = await client.getObject({ id: ids[0], options: { showContent: true } });
  const fields = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  const createdAt = BigInt((fields?.created_at as string) ?? 0);
  return ids.map((tunnelId) => ({ tunnelId, createdAt }));
}

/** Play ROUNDS_PER_TUNNEL hands off-chain, then settle on-chain with the transcript root. */
async function playAndSettle(
  client: ReturnType<typeof createSuiClient>,
  player: Bot,
  dealer: Bot,
  g: OpenGame,
  m: Metrics,
): Promise<void> {
  const tunnel = core.OffchainTunnel.selfPlay(
    proto,
    g.tunnelId,
    player.coreKey,
    dealer.coreKey,
    player.address,
    dealer.address,
    { a: STAKE, b: STAKE },
  );
  const transcript = new proof.Transcript(g.tunnelId);
  tunnel.onUpdate = (u) => transcript.append(u);

  // Sign each update with the tunnel's created_at (a validator timestamp) so timestamps
  // are monotonic and the settlement passes on-chain regardless of local clock skew.
  const { rounds, updates } = playBoundedRounds(tunnel, proto, ROUNDS_PER_TUNNEL, g.createdAt);

  // Settle directly with the transcript root. onchainNonce = 0 because we never submit
  // update_state on-chain (close_cooperative_with_root derives final_nonce = 0 + 1), so the
  // whole game is just two on-chain txs: the open above and this close.
  const root = transcript.root();
  const settlement = tunnel.buildSettlementWithRoot(g.createdAt, root, 0n);
  const tx = new Transaction();
  onchain.buildCloseWithRootFromSettlement(tx, g.tunnelId, settlement);
  const res = await client.signAndExecuteTransaction({
    signer: player.keypair,
    transaction: tx,
    options: { showEffects: true },
  });
  if (res.effects?.status?.status !== "success")
    throw new Error(`close failed (${g.tunnelId}): ${res.effects?.status?.error ?? "unknown"}`);
  await client.waitForTransaction({ digest: res.digest });

  m.onchainTx++;
  m.tunnelsSettled++;
  m.rounds += rounds;
  m.updates += updates;
}

// ---- gas plumbing -----------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fundPlayers(
  client: ReturnType<typeof createSuiClient>,
  funder: Ed25519Keypair,
  players: Bot[],
  amount: bigint,
): Promise<void> {
  const tx = new Transaction();
  onchain.buildFundAccounts(
    tx,
    players.map((p) => ({ address: p.address, amount })),
  );
  const res = await client.signAndExecuteTransaction({
    signer: funder,
    transaction: tx,
    options: { showEffects: true },
  });
  if (res.effects?.status?.status !== "success")
    throw new Error(`funding players failed: ${res.effects?.status?.error ?? "unknown"}`);
  await client.waitForTransaction({ digest: res.digest });
}

/** Ensure the funder has at least `need` MIST, requesting from the faucet if low. */
async function topUpFunder(
  client: ReturnType<typeof createSuiClient>,
  funderAddr: string,
  need: bigint,
): Promise<void> {
  const bal = BigInt((await client.getBalance({ owner: funderAddr })).totalBalance);
  if (bal >= need) return;
  if (!USE_FAUCET || NETWORK === "mainnet") {
    throw new Error(
      `funder ${funderAddr} has ${bal} MIST < ${need} needed and faucet is off — fund it manually`,
    );
  }
  console.log(`funder low (${bal} MIST); requesting faucet…`);
  try {
    await requestSuiFromFaucetV2({ host: getFaucetHost(NETWORK), recipient: funderAddr });
    // Faucet is async; poll briefly for the balance to climb.
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const b = BigInt((await client.getBalance({ owner: funderAddr })).totalBalance);
      if (b >= need) return;
    }
  } catch (e) {
    console.warn("faucet request failed:", (e as Error)?.message ?? e);
  }
}

/** Background top-up: refill any player below MIN_SIGNER_GAS from the funder (one PTB). */
async function gasKeeper(
  client: ReturnType<typeof createSuiClient>,
  funder: Ed25519Keypair,
  funderAddr: string,
  players: Bot[],
): Promise<void> {
  const balances = await Promise.all(
    players.map(async (p) => BigInt((await client.getBalance({ owner: p.address })).totalBalance)),
  );
  const low = players.filter((_, i) => balances[i] < MIN_SIGNER_GAS);
  if (low.length === 0) return;
  await topUpFunder(client, funderAddr, GAS_PER_SIGNER * BigInt(low.length) + 20_000_000n);
  await fundPlayers(client, funder, low, GAS_PER_SIGNER);
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });
}
