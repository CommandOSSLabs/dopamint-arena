import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: false,
      workbox: { globPatterns: ["**/*.{js,css,html,ico,png,svg}"] },
    }),
  ],
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
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
});
