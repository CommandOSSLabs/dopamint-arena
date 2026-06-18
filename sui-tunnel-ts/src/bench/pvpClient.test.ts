import { test } from "node:test";
import assert from "node:assert";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { PvpClient } from "./pvpClient";

const WALLET_A = "0x" + "00".repeat(32);
const WALLET_B = "0x" + "11".repeat(32);
const SECRET_KEY = new Uint8Array(32);

function createClient(
  url: string,
  extra: Partial<ConstructorParameters<typeof PvpClient>[0]> = {}
): PvpClient {
  return new PvpClient({
    url,
    wallet: WALLET_A,
    secretKey: SECRET_KEY,
    ...extra,
  });
}

async function startServer(): Promise<{
  server: WebSocketServer;
  port: number;
  close: () => Promise<void>;
}> {
  const server = new WebSocketServer({ port: 0 });
  const port = await new Promise<number>((resolve) => {
    server.on("listening", () =>
      resolve((server.address() as AddressInfo).port)
    );
  });
  return {
    server,
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
      }),
  };
}

async function acceptSocket(server: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => {
    server.once("connection", (ws) => resolve(ws));
  });
}

test("pvpClient exposes transport interface", () => {
  const client = createClient("ws://localhost:8080/v1/mp");
  // close() before the handshake rejects `ready`; ignore it for this structural check.
  client.ready.catch(() => {});
  const t = client.getTransport();
  assert.strictEqual(typeof t.send, "function");
  assert.strictEqual(typeof t.onFrame, "function");
  client.close();
});

test("pvpClient close before open rejects ready", async () => {
  const client = createClient("ws://localhost:8080/v1/mp");
  client.close();
  await assert.rejects(client.ready, /pvp_client_closed/);
});

test("pvpClient queues messages until authenticated", async () => {
  const { server, port, close } = await startServer();
  const client = createClient(`ws://localhost:${port}/v1/mp`);

  let serverSocket: WebSocket | undefined;
  const messages: unknown[] = [];

  try {
    serverSocket = await acceptSocket(server);

    serverSocket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    // Send queue.join before authentication completes.
    client.joinQueue("tictactoe");

    // Server issues the challenge; client should respond with connect, then flush queue.join.
    serverSocket.send(JSON.stringify({ type: "challenge", nonce: "abc123" }));

    await client.ready;

    await new Promise<void>((resolve) => {
      const check = () => {
        if (messages.length >= 2) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    const connect = messages[0] as Record<string, unknown>;
    assert.strictEqual(connect.type, "connect");
    assert.strictEqual(connect.nonce, "abc123");

    const join = messages[1] as Record<string, unknown>;
    assert.strictEqual(join.type, "queue.join");
    assert.strictEqual(join.game, "tictactoe");
  } finally {
    client.close();
    serverSocket?.close();
    await close();
  }
});

test("pvpClient wire format", async () => {
  const { server, port, close } = await startServer();

  let serverSocket: WebSocket | undefined;
  const messages: unknown[] = [];
  let matchFoundResolve: () => void;
  const matchFoundPromise = new Promise<void>((resolve) => {
    matchFoundResolve = resolve;
  });

  const client = createClient(`ws://localhost:${port}/v1/mp`, {
    onMatchFound: () => matchFoundResolve(),
  });

  try {
    serverSocket = await acceptSocket(server);

    serverSocket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    serverSocket.send(JSON.stringify({ type: "challenge", nonce: "abc123" }));

    await client.ready;

    await new Promise<void>((resolve) => {
      const check = () => {
        if (messages.length > 0) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    const connect = messages[0] as Record<string, unknown>;
    assert.strictEqual(connect.type, "connect");
    assert.strictEqual(connect.wallet, WALLET_A);
    assert.strictEqual(typeof connect.pubkey, "string");
    assert.strictEqual(typeof connect.sig, "string");
    assert.strictEqual(connect.nonce, "abc123");

    serverSocket.send(
      JSON.stringify({
        type: "match.found",
        matchId: "match-1",
        role: "A",
        opponentWallet: WALLET_B,
      })
    );

    await matchFoundPromise;

    const frame = new TextEncoder().encode(JSON.stringify({ kind: "move" }));
    client.getTransport().send(frame);

    await new Promise<void>((resolve) => {
      const check = () => {
        if (messages.length > 1) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    const relay = messages[1] as Record<string, unknown>;
    assert.strictEqual(relay.type, "relay");
    assert.strictEqual(relay.matchId, "match-1");
    const payload = JSON.parse(String(relay.payload));
    assert.strictEqual(payload.t, "frame");
    assert.strictEqual(payload.data, '{"kind":"move"}');
  } finally {
    client.close();
    serverSocket?.close();
    await close();
  }
});

test("pvpClient relay delivers decoded frame", async () => {
  const { server, port, close } = await startServer();
  const client = createClient(`ws://localhost:${port}/v1/mp`);

  let serverSocket: WebSocket | undefined;
  let frameReceived: Uint8Array | undefined;

  try {
    serverSocket = await acceptSocket(server);

    serverSocket.send(JSON.stringify({ type: "challenge", nonce: "abc123" }));
    await client.ready;

    serverSocket.send(
      JSON.stringify({
        type: "match.found",
        matchId: "match-1",
        role: "A",
        opponentWallet: WALLET_B,
      })
    );

    client.getTransport().onFrame((bytes) => {
      frameReceived = bytes;
    });

    const envelope = JSON.stringify({ t: "frame", data: '{"kind":"move"}' });
    serverSocket.send(
      JSON.stringify({ type: "relay", matchId: "match-1", payload: envelope })
    );

    await new Promise<void>((resolve) => {
      const check = () => {
        if (frameReceived !== undefined) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    assert.strictEqual(
      new TextDecoder().decode(frameReceived),
      '{"kind":"move"}'
    );
  } finally {
    client.close();
    serverSocket?.close();
    await close();
  }
});

test("pvpClient relay with wrong matchId calls onError", async () => {
  const { server, port, close } = await startServer();
  const errors: string[] = [];
  const client = createClient(`ws://localhost:${port}/v1/mp`, {
    onError: (code) => errors.push(code),
  });

  let serverSocket: WebSocket | undefined;

  try {
    serverSocket = await acceptSocket(server);

    serverSocket.send(JSON.stringify({ type: "challenge", nonce: "abc123" }));
    await client.ready;

    serverSocket.send(
      JSON.stringify({
        type: "match.found",
        matchId: "match-1",
        role: "A",
        opponentWallet: WALLET_B,
      })
    );

    const envelope = JSON.stringify({ t: "frame", data: "{}" });
    serverSocket.send(
      JSON.stringify({ type: "relay", matchId: "match-2", payload: envelope })
    );

    await new Promise<void>((resolve) => {
      const check = () => {
        if (errors.length > 0) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    assert.deepStrictEqual(errors, ["relay_wrong_match"]);
  } finally {
    client.close();
    serverSocket?.close();
    await close();
  }
});

test("pvpClient relay before match calls onError", async () => {
  const { server, port, close } = await startServer();
  const errors: string[] = [];
  const client = createClient(`ws://localhost:${port}/v1/mp`, {
    onError: (code) => errors.push(code),
  });

  let serverSocket: WebSocket | undefined;

  try {
    serverSocket = await acceptSocket(server);

    serverSocket.send(JSON.stringify({ type: "challenge", nonce: "abc123" }));
    await client.ready;

    const frame = new TextEncoder().encode(JSON.stringify({ kind: "move" }));
    client.getTransport().send(frame);

    await new Promise<void>((resolve) => {
      const check = () => {
        if (errors.length > 0) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    assert.deepStrictEqual(errors, ["relay_before_match"]);
  } finally {
    client.close();
    serverSocket?.close();
    await close();
  }
});

test("pvpClient ignores challenge after close", async () => {
  const { server, port, close } = await startServer();
  const client = createClient(`ws://localhost:${port}/v1/mp`);

  let serverSocket: WebSocket | undefined;
  const messages: unknown[] = [];

  try {
    serverSocket = await acceptSocket(server);

    serverSocket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    // close() rejects the pending `ready` promise; absorb it.
    client.ready.catch(() => {});
    client.close();

    // Deliver a delayed challenge; the client must not respond with connect.
    await new Promise((resolve) => setTimeout(resolve, 50));
    serverSocket.send(JSON.stringify({ type: "challenge", nonce: "abc123" }));

    // Give any misbehaving handler time to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.strictEqual(messages.length, 0);
  } finally {
    client.close();
    serverSocket?.close();
    await close();
  }
});
