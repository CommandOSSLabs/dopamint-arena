import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureMatch, measureAblation } from "./ablation";
import {
  renderAblation,
  renderAblationMarkdown,
  ablationBasename,
} from "./ablationReport";
import { envName } from "./benchEnv";
import { isPlayable, PLAYABLE } from "./games";

export interface AblationArgs {
  game: string;
  trials: number;
}

export function parseAblationArgs(argv: string[]): AblationArgs {
  let game = "blackjack";
  let trials = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--game") game = argv[++i] ?? game;
    else if (argv[i] === "--trials") trials = Number(argv[++i] ?? trials);
  }
  if (!isPlayable(game)) {
    throw new Error(`game "${game}" is not playable (one of: ${PLAYABLE.join(", ")})`);
  }
  if (!Number.isFinite(trials) || trials < 1) {
    throw new Error(`--trials must be a positive integer`);
  }
  return { game, trials };
}

function stamp(): string {
  // YYYYMMDD-HHMMSS in local time, no separators that break filenames.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export async function runAblation(argv: string[]): Promise<string> {
  const { game, trials } = parseAblationArgs(argv);
  const cap = await captureMatch(game);
  const result = measureAblation(cap, trials);

  process.stdout.write(renderAblation(result));

  const at = stamp();
  const dir = join(import.meta.dir, "..", "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ablationBasename(envName(), at));
  writeFileSync(file, renderAblationMarkdown(result, at));
  process.stdout.write(`[local/offchain] ablation report: ${file}\n`);
  return file;
}
