//! Cross-language co-signing golden: the Rust bot Seat must accept the EXACT relay frame
//! a real TypeScript `DistributedTunnel` (the browser) produces for its first move.
//!
//! This is the genuine TS→Rust parity gate the suite was missing: the frame's `stateHash`
//! is the browser's `blake2b256(encodeState(...))`, its `sigProposer` is a real ed25519
//! signature over the browser's `serializeStateUpdate(...)`, and its envelope is the browser's
//! `encodeFrame(...)`. A single `handle_frame` therefore pins, across the language boundary:
//! frame-codec decode, `encode_state` byte-parity (via the state_hash check), the signed-message
//! layout, and ed25519 verify — the whole path a stale per-game port would silently break.
//!
//! Regenerate the vectors below (deterministic, fixed keys) with, from `sui-tunnel-ts/`:
//! ```
//! // frame_probe.ts — seat A secret [1..32], seat B [33..64], tunnel 0x..01, stake 500, ts 0
//! import { BombItProtocol } from "./src/protocol/bombIt";
//! import { DistributedTunnel } from "./src/core/distributedTunnel";
//! import { makeEndpoint } from "./src/core/tunnel";
//! import { keyPairFromSecret, nobleBackend } from "./src/core/crypto";
//! const a = keyPairFromSecret(Uint8Array.from({length:32},(_,i)=>i+1));
//! const b = keyPairFromSecret(Uint8Array.from({length:32},(_,i)=>i+33));
//! const self = makeEndpoint(nobleBackend,"0xA",a,true), opp = makeEndpoint(nobleBackend,"0xB",b,false);
//! let sent; const dt = new DistributedTunnel(new BombItProtocol(),
//!   {tunnelId:"0x"+"0".repeat(63)+"1", self, opponent: opp, selfParty:"A"},
//!   {send:(f)=>sent=f, onFrame:()=>{}}, {a:500n,b:500n});
//! dt.propose({a:"stay"}, 0n); console.log(new TextDecoder().decode(sent));
//! ```
use tunnel_bomb_it::BombIt;
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{Balances, LocalSigner, PartyRuntime, Seat, TunnelContext};

/// The browser's seat A signs with the ed25519 secret `[1..32]`; the bot verifies against the
/// public key derived from it — so `opponent_pk` is provably the same key TS used, not a magic
/// constant. Seat B (the bot) uses `[33..64]`; its key is arbitrary for accepting A's move.
#[test]
fn rust_seat_accepts_ts_signed_first_move() {
    // Verbatim `encodeFrame(...)` output from the TS `DistributedTunnel` (see module doc).
    const TS_FRAME: &str = r#"{"kind":"move","nonce":"1","by":"A","move":{"a":"stay"},"timestamp":"0","stateHash":"b09d9919e21ba71cf1942e6d854f49dafe993a0fd5c57b863aa95a5b16ec2326","partyABalance":"500","partyBBalance":"500","sigProposer":"02dd437ac59546072d60c1e43da7f0f215d68b10a87ea36878b86c8b11d743b3e9ba4384248923a174d9a403cc3deea52f6f35fd69af4fcfa83ba5e51957e701"}"#;

    let a_secret: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let b_secret: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let opponent_pk = keypair_from_secret(&a_secret).public_key();

    let mut bot: PartyRuntime<BombIt, LocalSigner> = PartyRuntime::new(
        BombIt,
        LocalSigner::from_secret(&b_secret),
        opponent_pk,
        TunnelContext {
            tunnel_id: "0x0000000000000000000000000000000000000000000000000000000000000001"
                .into(),
            initial: Balances { a: 500, b: 500 },
            seat: Seat::B,
        },
    );

    let acks = bot
        .handle_frame(TS_FRAME.as_bytes())
        .expect("bot must accept the browser's TS-signed first move (codec+state_hash+sig)");
    assert_eq!(acks.len(), 1, "bot must co-sign exactly one ACK");
    assert_eq!(bot.nonce(), 1, "bot must advance to nonce 1 on the accepted move");
}
