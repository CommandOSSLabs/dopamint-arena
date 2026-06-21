/**
 * Spectator: WATCH the grid games play out so a human recognizes a real player at work —
 * board, whose turn, the move just made, the running scoreboard, and which random mode the
 * player is using. This is the SAME engine + move modes the TPS bot uses (CaroProtocol +
 * pickCell); it's just paced and rendered for human eyes instead of run flat-out.
 *
 *   # watch tic-tac-toe, ~0.4s/move, forever (Ctrl-C to stop)
 *   GAME=ttt  DELAY_MS=400 LOOP=1 node --import tsx scripts/gridDemo.ts
 *   # watch caro on a readable 9x9 board
 *   GAME=caro BOARD_SIZE=9 WIN_LEN=5 DELAY_MS=120 LOOP=1 node --import tsx scripts/gridDemo.ts
 *   # instant (no pacing) — quick correctness view of a couple of games
 *   GAME=ttt MATCHES=2 node --import tsx scripts/gridDemo.ts
 */
import { CaroProtocol, caroNextMover, CARO_PRESETS, type CaroState } from "../src/protocol/caro.ts";
import { pickCell } from "./gridTpsBot.ts";

type GameKey = keyof typeof CARO_PRESETS;
type Mode = "uniform" | "center" | "adjacent" | "smart";
const ALL_MODES: Mode[] = ["uniform", "center", "adjacent", "smart"];

const GAME = (process.env.GAME ?? "ttt") as GameKey;
const preset = CARO_PRESETS[GAME] ?? CARO_PRESETS.ttt;
const N = Number(process.env.BOARD_SIZE ?? preset.boardSize);
const K = Number(process.env.WIN_LEN ?? preset.winLength);
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);
const LOOP = process.env.LOOP === "1" || process.env.LOOP === "true";
const MATCHES = Number(process.env.MATCHES ?? (GAME === "ttt" ? 2 : 1));
/** MODE=random (default) picks a fresh mode per match — exactly what the bot does. */
const MODE_ENV = (process.env.MODE ?? "random") as Mode | "random";
const PACED = DELAY_MS > 0;

const SYM = ["·", "X", "O"];
const SYM_LAST = ["·", "x", "o"]; // lowercase marks the cell just played

let seed = Number(process.env.SEED ?? 7) >>> 0;
const rng = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pickMode = (): Mode => (MODE_ENV === "random" ? ALL_MODES[Math.floor(rng() * ALL_MODES.length)] : MODE_ENV);

function render(board: number[], n: number, lastCell: number): string {
  const rows: string[] = [];
  for (let r = 0; r < n; r++) {
    const cells = [];
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      cells.push((i === lastCell ? SYM_LAST : SYM)[board[i]]);
    }
    rows.push("   " + cells.join(" "));
  }
  return rows.join("\n");
}

const score = { aWins: 0, bWins: 0, draws: 0 };

function liveScreen(s: CaroState, mode: Mode, lastBy: "A" | "B" | null, lastCell: number, moveNo: number): void {
  const next = caroNextMover(s);
  const title = GAME === "ttt" ? "TIC-TAC-TOE" : "CARO / GOMOKU";
  const lines = [
    `${title}  —  Player A (X)  vs  Player B (O)   [${N}x${N}, ${K}-in-a-row]`,
    `scoreboard:  X ${score.aWins}   O ${score.bWins}   draws ${score.draws}`,
    `match #${s.matchesPlayed + (s.phase === "over" ? 0 : 1)}  ·  mode=${mode}  ·  move ${moveNo}`,
    lastBy ? `last: Player ${lastBy} (${lastBy === "A" ? "x" : "o"}) → (${Math.floor(lastCell / N)},${lastCell % N})` : "starting…",
    `next: Player ${next} (${next === "A" ? "X" : "O"}) to move`,
    "",
    render(s.board, N, lastCell),
    "",
    "(Ctrl-C to stop)",
  ];
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H" + lines.join("\n") + "\n");
}

async function run(): Promise<void> {
  const matchCap = LOOP ? 1_000_000 : MATCHES;
  const proto = new CaroProtocol({ boardSize: N, winLength: K, matchCap, stake: 100n });
  // Big balances so a long watching session never runs out of stake mid-stream.
  const bal = 100n * 10_000n;

  if (!PACED) console.log(`${GAME.toUpperCase()} demo — ${N}x${N}, ${K}-in-a-row, ${MATCHES} match(es)\n`);

  let s = proto.initialState({ tunnelId: "0x1", initialBalances: { a: bal, b: bal } });
  let mode = pickMode();
  let modeMatch = -1;
  let moveNo = 0;
  let lastBy: "A" | "B" | null = null;
  let lastCell = -1;
  const stepByStep = !PACED && N <= 5;

  for (;;) {
    if (proto.isTerminal(s)) {
      if (!LOOP) break;
      s = proto.initialState({ tunnelId: "0x1", initialBalances: { a: bal, b: bal } });
    }
    if (s.matchesPlayed !== modeMatch) {
      modeMatch = s.matchesPlayed;
      mode = pickMode();
      moveNo = 0;
      if (!PACED) console.log(`── Match ${s.matchesPlayed + 1} (${caroNextMover(s)} starts, mode=${mode}) ──`);
    }

    const by = caroNextMover(s);
    const beforeMatches = s.matchesPlayed;
    const cell = pickCell(mode, s, by, N, K, rng);
    s = proto.applyMove(s, { cell }, by);
    moveNo++;
    lastBy = by;
    lastCell = cell;

    if (s.matchesPlayed > beforeMatches) {
      const w = s.lastWinner;
      if (w === 1) score.aWins++;
      else if (w === 2) score.bWins++;
      else score.draws++;
    }

    if (PACED) {
      liveScreen(s, mode, lastBy, lastCell, moveNo);
      await sleep(DELAY_MS);
    } else if (stepByStep) {
      console.log(`move ${moveNo}: ${by === "A" ? "X" : "O"} -> (${Math.floor(cell / N)},${cell % N})`);
      console.log(render(s.board, N, lastCell));
    }

    if (s.matchesPlayed > beforeMatches && !PACED) {
      const w = s.lastWinner;
      const outcome = w === 3 ? "draw" : w === 1 ? "X (A) wins" : "O (B) wins";
      if (!stepByStep) {
        console.log(`final board (${moveNo} moves):`);
        console.log(render(s.board, N, lastCell));
      }
      console.log(`Result: ${outcome}  |  balances A=${s.balanceA} B=${s.balanceB}\n`);
    }
  }
  if (!PACED) console.log(`Done. ${s.matchesPlayed} matches. Score X ${score.aWins} O ${score.bWins} draws ${score.draws}.`);
}

run().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
