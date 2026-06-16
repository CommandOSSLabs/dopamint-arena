import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The off-chain engine statically imports node:crypto in crypto-native.ts but
      // falls back to @noble at runtime in the browser. Map node:crypto to a stub so
      // the bundle resolves; the native path is never taken here.
      "node:crypto": fileURLToPath(new URL("./src/shims/node-crypto.ts", import.meta.url)),
      "sui-tunnel-ts": fileURLToPath(new URL("../sui-tunnel-ts/src", import.meta.url)),
    },
  },
});
