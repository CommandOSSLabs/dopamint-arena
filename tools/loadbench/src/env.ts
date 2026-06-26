import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Resolved relative to this file so it always points to tools/loadbench/.env.local
// regardless of the process cwd.
const ENV_PATH = new URL("../.env.local", import.meta.url);

/** Parse a `.env`-style text blob into a key→value map.
 *  Blank lines and lines starting with `#` are ignored. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

/** Serialize a key→value map to `.env`-style KEY=VALUE lines. */
export function serializeEnv(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

/** Read `.env.local` next to `package.json`, returning `{}` if the file does not exist. */
export function readEnvLocal(): Record<string, string> {
  return existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, "utf8")) : {};
}

/** Merge `vars` into `.env.local`, preserving any existing keys not in `vars`. */
export function writeEnvLocal(vars: Record<string, string>): void {
  writeFileSync(ENV_PATH, serializeEnv({ ...readEnvLocal(), ...vars }));
}
