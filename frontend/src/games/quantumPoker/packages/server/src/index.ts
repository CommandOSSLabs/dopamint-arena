import { createRouter } from "./router";
import { health } from "./routes/health";
import { createSessionHandler } from "./routes/session";
import { createOpenHandler } from "./routes/open";
import { createMoveHandler } from "./routes/move";
import { createSettleHandler } from "./routes/settle";
import { loadServerConfig } from "./serverConfig";
import { BotWalletPool } from "./services/botWalletPool";
import { InMemorySessionStore } from "./services/sessionStore";

declare const Bun: {
  serve(options: {
    port: number;
    fetch: (req: Request) => Promise<Response> | Response;
  }): { port: number };
};

const config = loadServerConfig();
const botWalletPool = BotWalletPool.fromConfig(config);
const sessionStore = new InMemorySessionStore();

const router = createRouter(config.clientOrigin, [
  { method: "GET", path: "/api/health", handler: health },
  {
    method: "POST",
    path: "/api/quantum-poker/session",
    handler: createSessionHandler({
      botWalletPool,
      sessionStore,
      defaultStake: config.defaultStake,
    }),
  },
  {
    method: "POST",
    path: "/api/quantum-poker/open",
    handler: createOpenHandler({
      botWalletPool,
      sessionStore,
      config,
    }),
  },
  {
    method: "POST",
    path: "/api/quantum-poker/move",
    handler: createMoveHandler({ botWalletPool, sessionStore }),
  },
  {
    method: "POST",
    path: "/api/quantum-poker/settle",
    handler: createSettleHandler({
      botWalletPool,
      sessionStore,
      config,
    }),
  },
]);

const server = Bun.serve({
  port: config.port,
  fetch: router,
});

console.log(`Quantum Poker bot server listening on http://localhost:${server.port}`);
