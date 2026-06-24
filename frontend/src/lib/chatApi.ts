export interface ChatApiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LiveMessage {
  sender: string;
  text: string;
}

export class ChatApiClient {
  private baseUrl: string;
  private fetch: typeof globalThis.fetch;

  constructor(
    baseUrl: string,
    fetchImpl: typeof globalThis.fetch = (url, init) => globalThis.fetch(url, init),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
  }

  async chat(messages: ChatApiMessage[]): Promise<string> {
    const res = await this.fetch(`${this.baseUrl}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!res.ok) throw new Error(`chat failed: ${res.status}`);
    const json = (await res.json()) as { content: string };
    return json.content;
  }

  async topic(): Promise<string> {
    const res = await this.fetch(`${this.baseUrl}/v1/chat/topic`);
    if (!res.ok) throw new Error(`topic failed: ${res.status}`);
    const json = (await res.json()) as { topic: string };
    return json.topic;
  }

  subscribeLive(onMessage: (msg: LiveMessage) => void): () => void {
    const url = `${this.baseUrl}/v1/chat/live`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as LiveMessage;
        onMessage(parsed);
      } catch {
        // ignore parse errors
      }
    };
    es.onerror = (e) => {
      console.error("chat live sse error", e);
    };
    return () => es.close();
  }
}
