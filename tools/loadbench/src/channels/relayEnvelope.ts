import { wrapInnerFrameJson } from "../../../../sui-tunnel-ts/src/core/distributedFrame";

/** Engine frame bytes -> the relay `payload` string `{t:"frame",kind,data}`. */
export function framePayload(frameBytes: Uint8Array): string {
  return wrapInnerFrameJson(new TextDecoder().decode(frameBytes));
}

/** Relay `payload` -> engine frame bytes, or null if it is a non-frame peer message.
 *  The relay forwards opaque payloads verbatim, so malformed or non-frame messages
 *  are expected and must not throw. */
export function payloadFrame(payload: string): Uint8Array | null {
  let env: unknown;
  try {
    env = JSON.parse(payload);
  } catch {
    return null;
  }
  if (env === null || typeof env !== "object") return null;
  const e = env as { t?: unknown; data?: unknown };
  if (e.t !== "frame" || typeof e.data !== "string") return null;
  return new TextEncoder().encode(e.data);
}
