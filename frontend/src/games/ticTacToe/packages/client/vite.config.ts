import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  // Vite loads VITE_* into import.meta.env, but the sui-tunnel-ts SDK's config.ts reads
  // `process.env.PACKAGE_ID` at call time (buildTarget). Resolve it at build time so the
  // browser bundle has the deployed package id. loadEnv reads .env (not process.env).
  const env = loadEnv(mode, process.cwd(), "");
  return {
    define: {
      "process.env.PACKAGE_ID": JSON.stringify(env.VITE_TTT_PACKAGE_ID ?? ""),
      // The SDK also calls dotenv.config() and reads process.env.SUI_NETWORK; give it a
      // value and an object so the reference doesn't crash in the browser bundle.
      "process.env.SUI_NETWORK": JSON.stringify(
        env.VITE_SUI_NETWORK_NAME ?? "testnet",
      ),
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
        // Neutralize the SDK's top-level dotenv.config() in the browser bundle.
        dotenv: resolve(__dirname, "./src/shims/dotenv.ts"),
      },
    },
    server: {
      port: 3100,
      strictPort: true,
    },
  };
});
