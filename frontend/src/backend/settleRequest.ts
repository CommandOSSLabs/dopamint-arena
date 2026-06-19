// Pure mapping from the SDK's CoSignedSettlementWithRoot to the backend /settle wire shape
// (ADR-0002 + ADR-0005 §6). The backend is a non-party gas payer: it submits whatever
// co-signed-with-root bytes the client produced and cannot sign for the seats — so the CLIENT
// builds the byte-exact settlement and this only reshapes it for JSON transport.
//
// Wire contract: u64 fields (balances/nonce/timestamp) -> decimal strings; 32-byte values
// (transcriptRoot/sigs) -> lowercase hex, no 0x (the backend's decode_hex trims an optional 0x).
// `transcript` is archived to Walrus verbatim.
//
// Relative .ts SDK imports (not the `sui-tunnel-ts/*` path alias) so this module also resolves
// under tsx in unit tests — tsx does not honor tsconfig path aliases. toHex is the canonical
// lowercase-no-prefix wire encoder the backend expects.
import type { CoSignedSettlementWithRoot } from "../../../sui-tunnel-ts/src/core/tunnel.ts";
import { toHex } from "../../../sui-tunnel-ts/src/core/bytes.ts";
import type { SettleRequestBody, SettleTranscriptEntry } from "./controlPlane";

export function coSignedToSettleRequest(
  coSigned: CoSignedSettlementWithRoot,
  transcript: SettleTranscriptEntry[],
): SettleRequestBody {
  const s = coSigned.settlement;
  return {
    settlement: {
      tunnelId: s.tunnelId,
      partyABalance: s.partyABalance.toString(),
      partyBBalance: s.partyBBalance.toString(),
      finalNonce: s.finalNonce.toString(),
      timestamp: s.timestamp.toString(),
      transcriptRoot: toHex(s.transcriptRoot),
    },
    sigA: toHex(coSigned.sigA),
    sigB: toHex(coSigned.sigB),
    transcript,
  };
}
