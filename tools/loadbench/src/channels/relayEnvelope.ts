import { wrapInnerFrameJson } from "../../../../sui-tunnel-ts/src/core/distributedFrame";

/** Engine frame bytes -> the relay `payload` string `{t:"frame",kind,data}`. */
export function framePayload(frameBytes: Uint8Array): string {
  return wrapInnerFrameJson(new TextDecoder().decode(frameBytes));
}

/** Relay `payload` -> engine frame bytes, or null if it is a non-frame peer message. */
export function payloadFrame(payload: string): Uint8Array | null {
  const env = JSON.parse(payload) as { t?: string; data?: string };
  if (env.t !== "frame" || typeof env.data !== "string") return null;
  return new TextEncoder().encode(env.data);
}
