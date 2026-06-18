// frontend/src/shims/node-crypto.ts
/**
 * Browser stub for `node:crypto`. The sui-tunnel-ts engine statically imports
 * core/crypto-native.ts (`import * as nc from "node:crypto"`), but at runtime it
 * probes that backend in a try/catch and falls back to pure-JS @noble in the
 * browser. We only need the static import to RESOLVE during the Vite build; the
 * native code path never runs here. Every export throws so any accidental use is
 * loud rather than silently wrong. Keeps the SDK itself untouched (upstream re-sync).
 */
function unavailable(): never {
  throw new Error("node:crypto is not available in the browser (sui-tunnel-ts falls back to @noble)");
}
export const createPrivateKey = unavailable;
export const createPublicKey = unavailable;
export const sign = unavailable;
export const verify = unavailable;
export default {} as Record<string, unknown>;
