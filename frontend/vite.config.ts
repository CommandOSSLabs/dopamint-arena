import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Same-origin in dev, mirroring the prod CloudFront `/v1/*` behavior: route /v1 (HTTP +
// the /v1/mp WebSocket) to the ALB so the browser issues same-origin requests. With this,
// VITE_BACKEND_URL stays empty everywhere (prod is same-origin via CloudFront), which also
// sidesteps the https-page→http-ALB mixed-content block on the deployed frontend.
const BACKEND_ALB =
  "http://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const pkgId =
    env.VITE_TUNNEL_PACKAGE_ID ||
    "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b";
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/v1": { target: BACKEND_ALB, changeOrigin: true, ws: true },
      },
    },
    // The SDK's onchain config.ts reads these at import time (Node-isms). Inject build-time
    // literals so the tx builders resolve the package id in the browser bundle.
    define: {
      "process.env.PACKAGE_ID": JSON.stringify(pkgId),
      "process.env.SUI_NETWORK": JSON.stringify("testnet"),
    },
    resolve: {
      // The vendored SDK pins an older @mysten/sui in its own node_modules. Force the bundled
      // SDK source to use THIS app's single @mysten/sui (2.18) so its tx builders produce the
      // same Transaction class dapp-kit signs, letting us reuse them instead of duplicating.
      dedupe: ["@mysten/sui", "@mysten/bcs"],
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        // The off-chain engine statically imports node:crypto in crypto-native.ts but
        // falls back to @noble at runtime in the browser. Map node:crypto to a stub so
        // the bundle resolves; the native path is never taken here.
        "node:crypto": fileURLToPath(
          new URL("./src/shims/node-crypto.ts", import.meta.url),
        ),
        // config.ts calls dotenv.config() at import time; stub it (env via `define`).
        dotenv: fileURLToPath(new URL("./src/shims/dotenv.ts", import.meta.url)),
        "sui-tunnel-ts": fileURLToPath(
          new URL("../sui-tunnel-ts/src", import.meta.url),
        ),
      },
    },
  };
});
