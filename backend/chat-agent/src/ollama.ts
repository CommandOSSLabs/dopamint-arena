export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  content: string;
}

interface TopicResponse {
  topic: string;
}

export class OllamaBackendClient {
  readonly backendUrl: string;
  readonly model: string;

  constructor(backendUrl: string, model: string) {
    this.backendUrl = backendUrl.replace(/\/+$/, "");
    this.model = model;
  }

  async chat(messages: OllamaMessage[]): Promise<string> {
    const url = `${this.backendUrl}/v1/chat`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model: this.model, stream: false }),
    });
    if (!resp.ok) {
      throw new Error(
        `ollama proxy returned ${resp.status}: ${await resp.text()}`,
      );
    }
    const data = (await resp.json()) as ChatResponse;
    return data.content;
  }

  async topic(): Promise<string> {
    const url = `${this.backendUrl}/v1/chat/topic`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(
        `topic proxy returned ${resp.status}: ${await resp.text()}`,
      );
    }
    const data = (await resp.json()) as TopicResponse;
    return data.topic;
  }

  async publishTranscript(
    messages: { sender: string; text: string }[],
  ): Promise<void> {
    const url = `${this.backendUrl}/v1/chat/live/publish`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!resp.ok) {
      throw new Error(`publish returned ${resp.status}: ${await resp.text()}`);
    }
  }
}
