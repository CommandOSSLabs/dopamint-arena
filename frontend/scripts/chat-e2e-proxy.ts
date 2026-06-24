/**
 * Minimal local backend for the chat e2e test.
 * Only implements /v1/chat, forwarding to Ollama and applying the same
 * system-prompt + max_tokens -> options.num_predict transform the real
 * explorer API uses.
 */
import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

function setCors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/v1/chat") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  let payload: {
    messages?: unknown;
    system?: string;
    max_tokens?: number;
  };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad json");
    return;
  }

  const messages = [
    { role: "system", content: payload.system || "You are a helpful assistant." },
    ...(Array.isArray(payload.messages) ? payload.messages : []),
  ];

  const upstreamBody: Record<string, unknown> = {
    model: "llama3.1:8b",
    messages,
    stream: true,
  };
  if (typeof payload.max_tokens === "number") {
    upstreamBody.options = { num_predict: payload.max_tokens };
  }

  try {
    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(upstreamBody),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "upstream error");
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(text);
      return;
    }

    res.writeHead(200, { "content-type": "application/x-ndjson" });
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      // Flush so the UI sees tokens as they arrive.
      await new Promise<void>((resolve) => res.write("", () => resolve()));
    }
    res.end();
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(String((e as Error).message ?? e));
  }
});

server.listen(PORT, () => {
  console.log(`[chat-e2e-proxy] listening on http://localhost:${PORT}`);
});
