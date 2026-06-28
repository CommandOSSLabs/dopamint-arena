//! The bot-fleet runner: launches N bots that connect to the relay, sit in the blackjack queue,
//! and play whichever opponent they're matched with — looping forever (re-queue after each match).
//!
//! Off-chain for now (`NoopAnchor`): a full match completes against an opponent that also doesn't
//! gate on chain (e.g. another runner bot — useful to prove the live transport end to end). Against
//! the real browser, which gates play on on-chain tunnel activation, a match reaches "matched +
//! key exchange" and then waits for the on-chain open — that step lands with `SuiAnchor`.
//!
//! Run:
//!   cargo run -p bot-fleet --bin bot-fleet
//!   BOT_COUNT=2 RELAY_WS_URL=wss://relay-dev.millionstps.io/v1/mp cargo run -p bot-fleet --bin bot-fleet
//!
//! Two-bot live transport test (no chain, no browser): `BOT_COUNT=2` → the relay pairs the two
//! bots (until the `is_bot` guard is deployed) and they play a full co-signed match over the live
//! relay. In production the `is_bot` guard makes a bot only ever match a human.

use std::time::Duration;

use bot_fleet::anchor::NoopAnchor;
use bot_fleet::play_match::run_live_blackjack;
use bot_fleet::relay_client::RelayConfig;
use bot_fleet::signer_durable::DurableSigner;
use tunnel_harness::Signer;

const DEFAULT_WS_URL: &str = "wss://relay-dev.millionstps.io/v1/mp";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let ws_url = std::env::var("RELAY_WS_URL").unwrap_or_else(|_| DEFAULT_WS_URL.to_string());
    let count: u32 = parse_env("BOT_COUNT", 1);
    let stake: u64 = parse_env("BOT_STAKE", 100);

    println!("bot-fleet: launching {count} bot(s) → {ws_url} (off-chain NoopAnchor)");
    let mut handles = Vec::new();
    for idx in 0..count {
        let ws_url = ws_url.clone();
        handles.push(tokio::spawn(run_bot(idx, ws_url, stake)));
    }
    for h in handles {
        let _ = h.await;
    }
    Ok(())
}

/// One bot: a stable identity, looping connect → queue → play → re-queue.
async fn run_bot(idx: u32, ws_url: String, stake: u64) {
    // Stable identity key per bot (deterministic by index for now; a real fleet loads per-bot keys
    // from a durable store / KMS). The per-MATCH co-signing key is fresh each iteration.
    let identity = DurableSigner::from_secret(&identity_secret(idx));
    let config = RelayConfig {
        ws_url,
        wallet: format!("0x{}", hex::encode(identity.public_key())),
    };
    println!("[bot {idx}] identity {}", config.wallet);

    loop {
        let match_key = DurableSigner::from_secret(&random_secret());
        let seed = u64::from_le_bytes(random_secret()[..8].try_into().unwrap());
        match run_live_blackjack(&config, &identity, match_key, &NoopAnchor, stake, seed).await {
            Ok(out) => println!(
                "[bot {idx}] match {} done: {} moves, balances {:?}, settle {:?}",
                out.tunnel_id, out.moves, out.final_balances, out.settle_digest
            ),
            Err(e) => println!("[bot {idx}] match ended: {e:#}"),
        }
        // Brief backoff before re-queueing so a tight failure loop can't hammer the relay.
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn parse_env<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Deterministic, distinct-per-bot identity secret. Placeholder for a durable/KMS-backed key.
fn identity_secret(idx: u32) -> [u8; 32] {
    let mut s = [0u8; 32];
    s[..4].copy_from_slice(&idx.to_le_bytes());
    s[4] = 0xb0; // mark as a fleet bot key (cosmetic)
    s
}

fn random_secret() -> [u8; 32] {
    let mut s = [0u8; 32];
    getrandom::getrandom(&mut s).expect("os rng");
    s
}
