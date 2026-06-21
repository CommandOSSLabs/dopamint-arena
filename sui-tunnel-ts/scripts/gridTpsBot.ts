/**
 * Continuous on-chain TPS bot for the grid games — Tic-Tac-Toe and Caro/Gomoku — over the
 * tunnel framework. Same shape as scripts/blackjackTpsBot.ts: open a tunnel with
 * create_and_fund, play MANY matches off-chain (every state dual-signed + appended to a
 * transcript), then close cooperatively with the transcript root. Two on-chain txs anchor a
 * whole run of off-chain state transitions — that's the throughput multiplier.
 *
 * `MATCHES_PER_TUNNEL` is the amplification lever (a single ttt match is <=9 moves, so you
 * need many matches per tunnel to anchor a lot of activity per settle; caro matches are longer).
 *
 * "Many random modes": each match is played with one of several move-selection modes, chosen
 * at random per match for variety (see MODES). uniform/center/adjacent tend to make longer
 * games (higher TPS); smart resolves faster.
 *
 * Run:
 *   SUI_FUNDER_KEY=<suiprivkey…> GAME=caro NETWORK=localnet PACKAGE_ID=<pkg> \
 *   MATCHES_PER_TUNNEL=20 SIGNERS=8 CONCURRENCY=8 \
 *   node --import tsx scripts/gridTpsBot.ts
 *   # GAME=ttt for 3x3 tic-tac-toe (use a larger MATCHES_PER_TUNNEL, matches are tiny)
 */
import { realpathSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { core, createSuiClient, onchain, proof } from "../src/index.ts";
import { buildOpenAndFundMany } from "../src/onchain/createAndFund.ts";
import {
  CaroProtocol,
  caroNextMover,
  caroCandidateCells,
  CARO_PRESETS,
  CARO_MARK_A,
  CARO_MARK_B,
  CARO_EMPTY,
  type CaroState,
} from "../src/protocol/caro.ts";
import type { Party } from "../src/protocol/Protocol.ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";

// Deployed sui_tunnel framework on testnet (override with PACKAGE_ID for localnet).
const TESTNET_PACKAGE_ID =
  "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b";
process.env.PACKAGE_ID ??= TESTNET_PACKAGE_ID;

// ============================================================================
// CONFIG
// ============================================================================
const intEnv = (k: string, d: number) =>
  process.env[k] !== undefined ? Math.trunc(Number(process.env[k])) : d;
const bigEnv = (k: string, d: bigint) =>
  process.env[k] !== undefined ? BigInt(process.env[k]!) : d;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const NETWORK = (process.env.NETWORK ?? "testnet") as "testnet" | "devnet" | "localnet" | "mainnet";
const GAME = (process.env.GAME ?? "caro") as keyof typeof CARO_PRESETS;
if (!CARO_PRESETS[GAME]) throw new Error(`GAME must be one of: ${Object.keys(CARO_PRESETS).join(", ")}`);
const BOARD_SIZE = Math.max(1, intEnv("BOARD_SIZE", CARO_PRESETS[GAME].boardSize));
const WIN_LEN = clamp(intEnv("WIN_LEN", CARO_PRESETS[GAME].winLength), 1, BOARD_SIZE);
/** Matches per tunnel before settle — the throughput lever. Default depends on game size. */
const MATCHES_PER_TUNNEL = Math.max(1, intEnv("MATCHES_PER_TUNNEL", GAME === "ttt" ? 200 : 20));
/** Per-match stake shifted loser->winner. */
const WAGER = bigEnv("WAGER", 100n);

const ALL_MODES = ["uniform", "center", "adjacent", "smart"] as const;
type Mode = (typeof ALL_MODES)[number];
const MODES = ((process.env.MODES ?? ALL_MODES.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter((s) => (ALL_MODES as readonly string[]).includes(s)) as Mode[]);
if (MODES.length === 0) throw new Error(`MODES must include some of: ${ALL_MODES.join(", ")}`);

const SIGNERS = Math.max(1, intEnv("SIGNERS", 4));
const CONCURRENCY = Math.max(1, intEnv("CONCURRENCY", SIGNERS));
const GAMES_PER_OPEN = Math.max(1, intEnv("GAMES_PER_OPEN", 1));
/** Locked stake per side: big enough that an all-loss streak survives every match. */
const STAKE = bigEnv("STAKE", WAGER * BigInt(MATCHES_PER_TUNNEL + 1));
const GAS_PER_SIGNER = bigEnv("GAS_PER_SIGNER", 200_000_000n);
const MIN_SIGNER_GAS = bigEnv("MIN_SIGNER_GAS", 20_000_000n);
const DURATION_MS = intEnv("DURATION_MS", 0);
const USE_FAUCET = (process.env.USE_FAUCET ?? "true") !== "false";
/** Log each settled game as a recognizable player result (X-vs-O score) — observable play. */
const SHOW_GAMES = (process.env.SHOW_GAMES ?? "false") === "true" || process.env.SHOW_GAMES === "1";
/** If set, append one JSON report line (config + final metrics) per run to this file (JSONL). */
const REPORT_FILE = process.env.REPORT_FILE;
const TIMEOUT_MS = 86_400_000n;

const proto = new CaroProtocol({
  boardSize: BOARD_SIZE,
  winLength: WIN_LEN,
  matchCap: MATCHES_PER_TUNNEL,
  stake: WAGER,
});

// ============================================================================
// MOVE MODES (exported for tests) — each returns a legal cell for `by`.
// ============================================================================

const randInt = (rng: () => number, n: number) => {
  const i = Math.floor(rng() * n);
  return i < n ? i : n - 1;
};

/** Has any of the 8 neighbours of `cell` got a non-empty mark on `board`? */
function hasNeighborMark(board: number[], cell: number, n: number): boolean {
  const r = Math.floor(cell / n);
  const c = cell % n;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < n && cc >= 0 && cc < n && board[rr * n + cc] !== CARO_EMPTY) return true;
    }
  }
  return false;
}

/** Would placing `mark` at `cell` complete `k` in a row? (cell assumed empty) */
function completesLine(board: number[], cell: number, mark: number, n: number, k: number): boolean {
  const r = Math.floor(cell / n);
  const c = cell % n;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const) {
    let count = 1;
    for (const sign of [1, -1]) {
      for (let s = 1; s < k; s++) {
        const rr = r + dr * s * sign;
        const cc = c + dc * s * sign;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n || board[rr * n + cc] !== mark) break;
        count++;
      }
    }
    if (count >= k) return true;
  }
  return false;
}

/** Pick a cell for `by` under `mode`. Pure given the rng. */
export function pickCell(
  mode: Mode,
  state: CaroState,
  by: Party,
  n: number,
  k: number,
  rng: () => number,
): number {
  const cands = caroCandidateCells(state, n);
  const center = Math.floor(n / 2) * n + Math.floor(n / 2);
  // First move of a match (fresh board): nothing to be adjacent to / win against -> centre.
  const firstMove = state.phase === "over" || state.moves === 0;
  if (mode === "uniform") return cands[randInt(rng, cands.length)];
  if (firstMove) return center;

  const adj = cands.filter((c) => hasNeighborMark(state.board, c, n));
  const pool = adj.length ? adj : cands;

  if (mode === "center") {
    // Pick the pool cell closest to the centre (ties broken randomly via a small sample).
    let best = pool[0];
    let bestD = Infinity;
    const cr = Math.floor(n / 2);
    const cc = Math.floor(n / 2);
    for (const c of pool) {
      const d = Math.abs(Math.floor(c / n) - cr) + Math.abs((c % n) - cc) + rng() * 0.5;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
  if (mode === "adjacent") return pool[randInt(rng, pool.length)];

  // smart: take a winning move, else block the opponent, else play adjacent.
  const myMark = by === "A" ? CARO_MARK_A : CARO_MARK_B;
  const oppMark = by === "A" ? CARO_MARK_B : CARO_MARK_A;
  for (const c of pool) if (completesLine(state.board, c, myMark, n, k)) return c;
  for (const c of pool) if (completesLine(state.board, c, oppMark, n, k)) return c;
  return pool[randInt(rng, pool.length)];
}

/**
 * Drive a self-play tunnel for exactly `maxMatches` matches (or until terminal), choosing a
 * fresh random mode per match. Returns matches played and co-signed updates produced.
 */
export interface PlayResult {
  matches: number;
  updates: number;
  aWins: number;
  bWins: number;
  draws: number;
}

export function playBoundedMatches(
  tunnel: {
    state: CaroState;
    step: (m: { cell: number }, by: Party, o: { mode: "full"; timestamp: bigint }) => { verified: boolean; nonce: bigint };
  },
  protocol: CaroProtocol,
  modes: Mode[],
  timestamp: bigint,
  rng: () => number,
): PlayResult {
  const n = protocol.boardSize;
  const k = protocol.winLength;
  const stepCeiling = protocol.matchCap * (n * n + 1) + 16;
  let updates = 0;
  let curMatch = -1;
  let mode: Mode = modes[0];
  let aWins = 0;
  let bWins = 0;
  let draws = 0;
  let tallied = 0;
  while (!protocol.isTerminal(tunnel.state)) {
    const s = tunnel.state;
    if (s.matchesPlayed !== curMatch) {
      curMatch = s.matchesPlayed;
      mode = modes[randInt(rng, modes.length)];
    }
    const by = caroNextMover(s);
    const cell = pickCell(mode, s, by, n, k, rng);
    const r = tunnel.step({ cell }, by, { mode: "full", timestamp });
    if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);
    if (++updates > stepCeiling) throw new Error("play exceeded step ceiling (bug)");
    // Tally each match outcome as it completes (lastWinner is set on the "over" state).
    if (tunnel.state.matchesPlayed > tallied) {
      tallied = tunnel.state.matchesPlayed;
      const w = tunnel.state.lastWinner;
      if (w === 1) aWins++;
      else if (w === 2) bWins++;
      else if (w === 3) draws++;
    }
  }
  return { matches: tunnel.state.matchesPlayed, updates, aWins, bWins, draws };
}

/** All tunnel ids created by a create_and_fund (batch-safe). */
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
// DAEMON (mirrors blackjackTpsBot.ts)
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
  matches = 0;
  updates = 0;
  failures = 0;
  aWins = 0;
  bWins = 0;
  draws = 0;
  readonly start = Date.now();
  peakTps = 0;
  private last = { onchainTx: 0, updates: 0, matches: 0, t: Date.now() };

  tick(): void {
    const now = Date.now();
    const dt = (now - this.last.t) / 1000;
    if (dt <= 0) return;
    const tps = (this.updates - this.last.updates) / dt;
    const txps = (this.onchainTx - this.last.onchainTx) / dt;
    const mps = (this.matches - this.last.matches) / dt;
    this.peakTps = Math.max(this.peakTps, tps);
    const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
    console.log(
      `[tps] eff ${n(tps)} upd/s (peak ${n(this.peakTps)}) | ${n(mps)} matches/s | ` +
        `${txps.toFixed(1)} onchain-tx/s | settled ${n(this.tunnelsSettled)} | fails ${this.failures}`,
    );
    this.last = { onchainTx: this.onchainTx, updates: this.updates, matches: this.matches, t: now };
  }

  /** Machine-readable run report: the config knobs + final metrics. Numbers, not strings. */
  summary(): Record<string, unknown> {
    const secs = (Date.now() - this.start) / 1000;
    const round = (x: number) => Math.round(x * 100) / 100;
    return {
      game: GAME,
      network: NETWORK,
      packageId: process.env.PACKAGE_ID,
      config: {
        boardSize: BOARD_SIZE,
        winLength: WIN_LEN,
        matchesPerTunnel: MATCHES_PER_TUNNEL,
        modes: MODES,
        signers: SIGNERS,
        concurrency: CONCURRENCY,
        gamesPerOpen: GAMES_PER_OPEN,
        stake: STAKE.toString(),
        durationMs: DURATION_MS,
      },
      elapsedSec: round(secs),
      tunnelsSettled: this.tunnelsSettled,
      tunnelsOpened: this.tunnelsOpened,
      matches: this.matches,
      matchesPerSec: round(this.matches / secs),
      outcomes: { aWins: this.aWins, bWins: this.bWins, draws: this.draws },
      anchoredUpdates: this.updates,
      effTpsAvg: round(this.updates / secs),
      effTpsPeak: round(this.peakTps),
      onchainTx: this.onchainTx,
      onchainTxPerSec: round(this.onchainTx / secs),
      failures: this.failures,
    };
  }

  report(): string {
    const secs = (Date.now() - this.start) / 1000;
    const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
    return [
      "",
      `${GAME} on-chain TPS bot — final report`,
      `  elapsed         : ${secs.toFixed(1)}s`,
      `  tunnels settled : ${n(this.tunnelsSettled)} (opened ${n(this.tunnelsOpened)})`,
      `  matches played  : ${n(this.matches)}  (${n(this.matches / secs)}/s avg)`,
      `  match outcomes  : X(A) ${n(this.aWins)} | O(B) ${n(this.bWins)} | draws ${n(this.draws)}`,
      `  anchored updates: ${n(this.updates)}  (eff TPS avg ${n(this.updates / secs)}, peak ${n(this.peakTps)})`,
      `  on-chain txs    : ${n(this.onchainTx)}  (${(this.onchainTx / secs).toFixed(1)}/s avg)`,
      `  failures        : ${this.failures}`,
    ].join("\n");
  }
}

async function main() {
  const funderKey = process.env.SUI_FUNDER_KEY;
  if (!funderKey) throw new Error("set SUI_FUNDER_KEY=<suiprivkey…> (a funded key)");
  const client = createSuiClient(NETWORK);
  const funder = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(funderKey).secretKey);
  const funderAddr = funder.getPublicKey().toSuiAddress();

  console.log(
    [
      `${GAME} on-chain TPS bot (${BOARD_SIZE}x${BOARD_SIZE}, ${WIN_LEN}-in-a-row)`,
      `  network          : ${NETWORK}`,
      `  package          : ${process.env.PACKAGE_ID}`,
      `  funder           : ${funderAddr}`,
      `  MATCHES_PER_TUNNEL: ${MATCHES_PER_TUNNEL}  (more = more anchored updates per settle)`,
      `  MODES            : ${MODES.join(", ")}`,
      `  SIGNERS          : ${SIGNERS}  CONCURRENCY: ${CONCURRENCY}  GAMES_PER_OPEN: ${GAMES_PER_OPEN}`,
      `  STAKE            : ${STAKE} MIST/side   duration: ${DURATION_MS ? DURATION_MS + "ms" : "until Ctrl-C"}`,
    ].join("\n"),
  );

  const dealer = makeBot(); // party B — signs off-chain only
  const players = Array.from({ length: SIGNERS }, makeBot);

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

  // Per-worker deterministic-ish rng seeded by worker index (varies play without Math.random reliance).
  function makeRng(seed: number): () => number {
    let s = (seed * 2654435761) >>> 0;
    return () => ((s = (s * 1103515245 + 12345) >>> 0) / 0x100000000);
  }

  async function worker(idx: number): Promise<void> {
    const player = players[idx % players.length];
    const rng = makeRng(idx + 1);
    while (!expired()) {
      try {
        const games = await openGames(client, player, dealer, GAMES_PER_OPEN, m);
        for (const g of games) {
          if (expired()) break;
          await playAndSettle(client, player, dealer, g, m, rng);
        }
      } catch (e) {
        m.failures++;
        console.warn(`worker ${idx}:`, (e as Error)?.message ?? e);
        await sleep(250);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  clearInterval(meter);
  clearInterval(keeper);
  console.log(m.report());

  if (REPORT_FILE) {
    const entry = { timestamp: new Date().toISOString(), ...m.summary() };
    appendFileSync(REPORT_FILE, JSON.stringify(entry) + "\n");
    console.log(`\nreport appended to ${REPORT_FILE}`);
  }
}

interface OpenGame {
  tunnelId: string;
  createdAt: bigint;
}

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
  const obj = await client.getObject({ id: ids[0], options: { showContent: true } });
  const fields = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  const createdAt = BigInt((fields?.created_at as string) ?? 0);
  return ids.map((tunnelId) => ({ tunnelId, createdAt }));
}

async function playAndSettle(
  client: ReturnType<typeof createSuiClient>,
  player: Bot,
  dealer: Bot,
  g: OpenGame,
  m: Metrics,
  rng: () => number,
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

  const r = playBoundedMatches(tunnel, proto, MODES, g.createdAt, rng);

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
  m.matches += r.matches;
  m.updates += r.updates;
  m.aWins += r.aWins;
  m.bWins += r.bWins;
  m.draws += r.draws;
  if (SHOW_GAMES) {
    const short = `${player.address.slice(0, 8)}…${player.address.slice(-4)}`;
    console.log(
      `🎮 ${GAME} game settled — player ${short}: X(A) ${r.aWins} - ${r.bWins} O(B)` +
        ` (${r.draws} draws) over ${r.matches} matches, ${r.updates} signed moves`,
    );
  }
}

// ---- gas plumbing (identical to blackjackTpsBot.ts) -------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fundPlayers(
  client: ReturnType<typeof createSuiClient>,
  funder: Ed25519Keypair,
  players: Bot[],
  amount: bigint,
): Promise<void> {
  const tx = new Transaction();
  onchain.buildFundAccounts(tx, players.map((p) => ({ address: p.address, amount })));
  const res = await client.signAndExecuteTransaction({
    signer: funder,
    transaction: tx,
    options: { showEffects: true },
  });
  if (res.effects?.status?.status !== "success")
    throw new Error(`funding players failed: ${res.effects?.status?.error ?? "unknown"}`);
  await client.waitForTransaction({ digest: res.digest });
}

async function topUpFunder(
  client: ReturnType<typeof createSuiClient>,
  funderAddr: string,
  need: bigint,
): Promise<void> {
  const bal = BigInt((await client.getBalance({ owner: funderAddr })).totalBalance);
  if (bal >= need) return;
  if (!USE_FAUCET || NETWORK === "mainnet")
    throw new Error(`funder ${funderAddr} has ${bal} MIST < ${need} needed and faucet is off`);
  console.log(`funder low (${bal} MIST); requesting faucet…`);
  try {
    await requestSuiFromFaucetV2({ host: getFaucetHost(NETWORK), recipient: funderAddr });
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const b = BigInt((await client.getBalance({ owner: funderAddr })).totalBalance);
      if (b >= need) return;
    }
  } catch (e) {
    console.warn("faucet request failed:", (e as Error)?.message ?? e);
  }
}

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
