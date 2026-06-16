import { serverConfig } from "./serverConfig";
import { createRouter } from "./router";
import { health } from "./routes/health";
import { sponsor } from "./routes/sponsor";
import { execute } from "./routes/execute";
import { blackjackSign } from "./routes/blackjackSign";

const router = createRouter(serverConfig.CLIENT_ORIGIN, [
  { method: "GET", path: "/api/health", handler: health },
  { method: "POST", path: "/api/sponsor", handler: sponsor },
  { method: "POST", path: "/api/execute", handler: execute },
  { method: "POST", path: "/api/black_jack/dealer/sign", handler: blackjackSign },
]);

const server = Bun.serve({
  port: serverConfig.PORT,
  fetch: router,
});

console.log(`Server listening on http://localhost:${server.port}`);
