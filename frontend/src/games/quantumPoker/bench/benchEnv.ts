// Preload — MUST be the first import in a bench: the sui-tunnel-ts onchain config reads
// PACKAGE_ID + SUI_NETWORK from process.env at module-eval time (vite injects them via `define`;
// under tsx/node we mirror them here from the backend's .env so the tx builders resolve targets).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(
  new URL("../../../../../backend/tunnel-manager/.env", import.meta.url),
);
const env = readFileSync(envPath, "utf8");
const get = (k: string): string | undefined =>
  env
    .split("\n")
    .find((l) => l.startsWith(`${k}=`))
    ?.slice(k.length + 1)
    .trim();

process.env.PACKAGE_ID ??= get("TUNNEL_PACKAGE_ID");
process.env.SUI_NETWORK ??= "testnet";
