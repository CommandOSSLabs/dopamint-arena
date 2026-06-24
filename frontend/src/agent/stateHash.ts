import type { Protocol } from "sui-tunnel-ts/protocol/Protocol";

export type StateHash = string;

const HEX = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >>> 4] + HEX[b & 0x0f];
  }
  return out;
}

/** Default digest for kits that treat the protocol's canonical wire encoding as the state snapshot. */
export function defaultStateHash<S, M>(
  protocol: Protocol<S, M>,
  state: S,
): StateHash {
  return bytesToHex(protocol.encodeState(state));
}
