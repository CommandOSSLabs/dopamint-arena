// Dev utility: print canonical golden hex vectors shared by the TS tests and
// the Move cross-checks (sui_tunnel/tests/wire_format_tests.move, and
// example_agent_allowance_tests.move for the spend-authorization vector). Run:
//   node --import tsx src/core/golden.gen.ts
import { buildPublicInputs } from "../zk/cardCircuit";
import { toHex } from "./bytes";
import { combineReveals, computeCommitment } from "./commitment";
import { blake2b256, keyPairFromSecret, sign } from "./crypto";
import { seedFromBytes, shuffle } from "./randomness";
import {
  serializeHtlcLock,
  serializeSettlement,
  serializeSettlementWithRoot,
  serializeSpendAuthorization,
  serializeStateUpdate,
} from "./wire";

const TUNNEL_ID = "0xab";
const stateHash = Uint8Array.from({ length: 32 }, (_, i) => i + 1); // 0x01..0x20
const paymentHash = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

const su = serializeStateUpdate({
  tunnelId: TUNNEL_ID,
  stateHash,
  nonce: 42n,
  timestamp: 1234567890n,
  partyABalance: 1000n,
  partyBBalance: 2000n,
});

const settle = serializeSettlement({
  tunnelId: TUNNEL_ID,
  partyABalance: 1000n,
  partyBBalance: 2000n,
  finalNonce: 43n,
  timestamp: 1234567890n,
});

const htlc = serializeHtlcLock({
  tunnelId: TUNNEL_ID,
  paymentHash,
  amount: 500n,
  sender: "0xaa",
  receiver: "0xbb",
  expiryMs: 9999999n,
});

const valueA = Uint8Array.of(7);
const saltA = Uint8Array.from({ length: 16 }, (_, i) => i + 1); // 1..16
const valueB = Uint8Array.of(42);
const saltB = Uint8Array.from({ length: 16 }, (_, i) => i + 17); // 17..32

const commitment = computeCommitment(valueA, saltA);
const seed = combineReveals(valueA, saltA, valueB, saltB);
const helloHash = blake2b256(new TextEncoder().encode("hello"));

// End-to-end: an SDK-produced dual signature over the state_update message must
// verify on-chain via signature::verify(ed25519, pk, msg, sig). ed25519 signing is
// deterministic (RFC 8032), so fixed secrets give reproducible signatures.
const secretA = Uint8Array.from({ length: 32 }, (_, i) => i + 1); // 0x01..0x20
const secretB = Uint8Array.from({ length: 32 }, (_, i) => i + 33); // 0x21..0x40
const kpA = keyPairFromSecret(secretA);
const kpB = keyPairFromSecret(secretB);
const sigA = sign(su, kpA.secretKey);
const sigB = sign(su, kpB.secretKey);

console.log("STATE_UPDATE   ", toHex(su), `(${su.length} B)`);
console.log("SETTLEMENT     ", toHex(settle), `(${settle.length} B)`);
console.log("HTLC_LOCK      ", toHex(htlc), `(${htlc.length} B)`);
console.log("COMMITMENT     ", toHex(commitment));
console.log("SEED           ", toHex(seed));
console.log("BLAKE2B(hello) ", toHex(helloHash));
console.log("PK_A           ", toHex(kpA.publicKey));
console.log("PK_B           ", toHex(kpB.publicKey));
console.log("SIG_A          ", toHex(sigA));
console.log("SIG_B          ", toHex(sigB));

// Dealerless deck: shuffle [0..51] with the commit-reveal joint seed (must match
// randomness.move shuffle exactly so the deck is on-chain-adjudicable).
const deck = Array.from({ length: 52 }, (_, i) => i);
shuffle(seedFromBytes(seed), deck);
console.log("SHUFFLED_DECK  ", toHex(Uint8Array.from(deck)));

// ZK card-in-deck public inputs (must match zk_verifier concat_scalars layout).
const deckRoot = Uint8Array.from({ length: 32 }, (_, i) => i + 1); // 0x01..0x20
const publicInputs = buildPublicInputs({ deckRoot, position: 5, card: 42 });
console.log(
  "ZK_PUBLIC_IN   ",
  toHex(publicInputs),
  `(${publicInputs.length} B)`
);

// Root-anchored settlement (transcript_root = 0x01..0x20).
const settleV2 = serializeSettlementWithRoot({
  tunnelId: TUNNEL_ID,
  partyABalance: 1000n,
  partyBBalance: 2000n,
  finalNonce: 43n,
  timestamp: 1234567890n,
  transcriptRoot: stateHash,
});
console.log("SETTLE_V2      ", toHex(settleV2), `(${settleV2.length} B)`);

// Agent-allowance spend voucher. Asserted by example_agent_allowance_tests.move
// (not wire_format_tests.move) since serialize_spend_authorization lives in the
// example module. allowance_id=0xab, authorized_total=1000.
const spendAuth = serializeSpendAuthorization({
  allowanceId: TUNNEL_ID,
  authorizedTotal: 1000n,
});
console.log("SPEND_AUTH     ", toHex(spendAuth), `(${spendAuth.length} B)`);
