import type { SessionTransport } from "./seams";

class LoopbackEnd implements SessionTransport {
  private frameCb: ((f: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  peer!: LoopbackEnd;
  send(frame: Uint8Array): void {
    // Deliver a copy so the receiver can't mutate the sender's buffer.
    // Use queueMicrotask so delivery is asynchronous — matching real transport
    // semantics and preventing re-entrant onConfirmed calls that would make the
    // transcript append order diverge between seats.
    const copy = Uint8Array.from(frame);
    queueMicrotask(() => this.peer.frameCb?.(copy));
  }
  onFrame(cb: (f: Uint8Array) => void): void {
    this.frameCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  onError(_cb: (err: unknown) => void): void {
    /* loopback never errors */
  }
  close(): void {
    this.closeCb?.();
    this.peer.closeCb?.();
  }
}

/** Two in-process transports wired to each other — for tests and self-play. */
export function linkedLoopback(): { a: SessionTransport; b: SessionTransport } {
  const a = new LoopbackEnd();
  const b = new LoopbackEnd();
  a.peer = b;
  b.peer = a;
  return { a, b };
}
