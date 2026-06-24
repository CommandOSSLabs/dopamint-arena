// Builds the binary /settle body (octet-stream) from the SDK's CoSignedSettlementWithRoot +
// raw transcript (ADR-0002 + ADR-0005 §6; binary format per the settle-binary-transcript plan).
// The backend is a non-party gas payer: it submits whatever co-signed-with-root bytes the client
// produced and cannot sign for the seats — so the CLIENT builds the byte-exact settlement and this
// only encodes it for transport. The same bytes are archived to Walrus verbatim.
//
// Relative .ts SDK imports (not the `sui-tunnel-ts/*` path alias) so this module also resolves
// under tsx in unit tests — tsx does not honor tsconfig path aliases. The wire byte layout +
// TS↔Rust parity live in encodeSettleBody (sui-tunnel-ts/src/proof/settleBinary.ts).
import type { CoSignedSettlementWithRoot } from "../../../sui-tunnel-ts/src/core/tunnel.ts";
import type { TranscriptEntry } from "../../../sui-tunnel-ts/src/proof/transcript.ts";
import { encodeSettleBody } from "../../../sui-tunnel-ts/src/proof/settleBinary.ts";

/** Build the binary /settle body (octet-stream) from the co-signed settlement + raw transcript. */
export function coSignedToSettleBody(
  coSigned: CoSignedSettlementWithRoot,
  entries: TranscriptEntry[],
): Uint8Array {
  const s = coSigned.settlement;
  return encodeSettleBody({
    tunnelId: s.tunnelId,
    partyABalance: s.partyABalance,
    partyBBalance: s.partyBBalance,
    finalNonce: s.finalNonce,
    timestamp: s.timestamp,
    transcriptRoot: s.transcriptRoot,
    sigA: coSigned.sigA,
    sigB: coSigned.sigB,
    entries: entries.map((e) => ({ message: e.message, sigA: e.sigA, sigB: e.sigB })),
  });
}
