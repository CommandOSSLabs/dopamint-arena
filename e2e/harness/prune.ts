// Prune helper: copy the vendored `sui_tunnel/` Move package to a scratch dir
// and delete `sources/examples/` there. Keeps the committed package pristine
// for upstream re-sync, and brings the published package under the
// `max_move_package_size` cap (102,400 bytes) so no protocol override is
// needed (the framework's only hard devstack blocker).
import { cpSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Copy `sui_tunnel/` to a fresh temp dir, strip `sources/examples/`, stale
 *  `build/`, and the `[environments]` table, then return the pruned path.
 *  Keeps the committed package pristine (upstream re-sync) and under the
 *  `max_move_package_size` cap, so no protocol override is needed. */
export function prunedSuiTunnel(): string {
  const src = join(REPO_ROOT, 'sui_tunnel');
  const dst = join(mkdtempSync(join(tmpdir(), 'sui-tunnel-pruned-')), 'sui_tunnel');
  cpSync(src, dst, { recursive: true });
  rmSync(join(dst, 'sources', 'examples'), { recursive: true, force: true });
  rmSync(join(dst, 'build'), { recursive: true, force: true });
  stripEnvironments(join(dst, 'Move.toml'));
  return dst;
}

/** Remove the `[environments]` table from a Move.toml. devstack's one-shot
 *  build scans Move.toml with `/\blocal\s*=\s*"..."/` to find local-path deps;
 *  the `[environments] local = "<chainId>"` entry false-matches and crashes
 *  dependency staging. devstack manages publish addressing itself, so the env
 *  table is unnecessary for a localnet publish. */
function stripEnvironments(tomlPath: string): void {
  const lines = readFileSync(tomlPath, 'utf8').split('\n');
  const out: string[] = [];
  let inEnv = false;
  for (const line of lines) {
    if (/^\s*\[environments\]/.test(line)) {
      inEnv = true;
      continue;
    }
    if (inEnv && /^\s*\[/.test(line)) inEnv = false; // next section ends the skip
    if (!inEnv) out.push(line);
  }
  writeFileSync(tomlPath, out.join('\n'));
}
