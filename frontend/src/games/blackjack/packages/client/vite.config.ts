import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  // Vite loads VITE_* into import.meta.env, but the sui-tunnel-ts SDK's onchain.* builders read
  // `process.env.PACKAGE_ID` at call time, and there is no `process` in the browser bundle.
  // Resolve the deployed package id at build time so the bundle carries it. loadEnv reads .env.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    define: {
      "process.env.PACKAGE_ID": JSON.stringify(env.VITE_TUNNEL_PACKAGE_ID ?? ""),
      // The SDK also reads process.env.SUI_NETWORK; give it a value so the reference doesn't
      // crash in the browser bundle.
      "process.env.SUI_NETWORK": JSON.stringify(env.VITE_SUI_NETWORK_NAME ?? "testnet"),
    },
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        manifest: false,
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg}"],
          // The bundle exceeds Workbox's 2 MiB default precache cap (the sui-tunnel-ts SDK is
          // large); raise it so the main chunk is still precached for offline use.
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        },
      }),
    ],
    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
        // Neutralize the SDK's top-level dotenv.config() in the browser bundle.
        dotenv: resolve(__dirname, "./src/shims/dotenv.ts"),
      },
    },
    server: {
      // Port 3000 matches the redirect URI registered in the Google OAuth client
      // (http://localhost:3000/auth). The original Next app also ran on :3000.
      port: 3000,
      strictPort: true,
      proxy: {
        "/api": { target: "http://localhost:3001", changeOrigin: true },
      },
    },
  };
});
