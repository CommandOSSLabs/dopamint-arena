import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Same-origin in dev, mirroring the prod CloudFront `/v1/*` behavior.
const BACKEND_ALB =
  "http://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com";

// Vite config for Node/tsx benchmark scripts. Differs from the browser config by NOT
// stubbing node:crypto, so sui-tunnel-ts can use the native crypto backend at runtime.
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
    define: {
      "process.env.PACKAGE_ID": JSON.stringify(pkgId),
      "process.env.SUI_NETWORK": JSON.stringify("testnet"),
      "require.main": "undefined",
    },
    resolve: {
      dedupe: ["@mysten/sui", "@mysten/bcs"],
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        // Stub @mysten/sui/client to point to our v1->v2 backward compatibility shim
        "@mysten/sui/client": fileURLToPath(
          new URL("./src/shims/sui-client.ts", import.meta.url),
        ),
        // config.ts calls dotenv.config() at import time; stub it (env via `define`).
        dotenv: fileURLToPath(new URL("./src/shims/dotenv.ts", import.meta.url)),
        "sui-tunnel-ts": fileURLToPath(new URL("../sui-tunnel-ts/src", import.meta.url)),
        "@ttt/shared": fileURLToPath(
          new URL("./src/games/ticTacToe/packages/shared/src", import.meta.url),
        ),
      },
    },
  };
});
