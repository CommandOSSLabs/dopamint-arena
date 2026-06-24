export interface ChatTransport {
  send(bytes: Uint8Array): void;
  onFrame(cb: (bytes: Uint8Array) => void): void;
}

export interface ChatFrameHandlers {
  onMessage(sender: string, text: string): void;
}

export function interceptChatFrames(
  transport: ChatTransport,
  handlers: ChatFrameHandlers,
): ChatTransport {
  let consumer: ((bytes: Uint8Array) => void) | null = null;

  transport.onFrame((bytes) => {
    try {
      const json = JSON.parse(new TextDecoder().decode(bytes));
      if (json?.type === "chat/text" && typeof json.sender === "string" && typeof json.text === "string") {
        handlers.onMessage(json.sender, json.text);
      }
    } catch {
      // not JSON; ignore
    }
    consumer?.(bytes);
  });

  return {
    send: (bytes) => transport.send(bytes),
    onFrame: (cb) => {
      consumer = cb;
    },
  };
}
