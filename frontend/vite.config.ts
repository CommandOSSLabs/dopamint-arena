import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// The SDK is reached for TYPES ONLY (see tsconfig paths). The runtime alias is
// harmless today (type-only imports are erased) and ready for when the real
// off-chain engine is wired from a worker.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "sui-tunnel-ts": fileURLToPath(
        new URL("../sui-tunnel-ts/src", import.meta.url),
      ),
    },
  },
});
