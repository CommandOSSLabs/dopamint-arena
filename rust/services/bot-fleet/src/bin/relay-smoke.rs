//! Live smoke: connect a bot to the DEPLOYED relay, authenticate (ed25519 challenge), and join
//! the blackjack queue — proving the fleet reuses the deployed backend. Full match-play needs a
//! human opponent (the manual E2E); this proves connect + auth + queue against real infra.
//!
//! Run: `cargo run -p bot-fleet --bin relay-smoke`
//! Override host: `RELAY_WS_URL=wss://relay-dev.millionstps.io/v1/mp cargo run -p bot-fleet --bin relay-smoke`

use std::time::Duration;

use bot_fleet::relay_client::{RelayConfig, RelayConnection};
use bot_fleet::relay_wire::RelayToBot;
use bot_fleet::signer_durable::DurableSigner;
use tunnel_harness::Signer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let ws_url = std::env::var("RELAY_WS_URL")
        .unwrap_or_else(|_| "wss://relay-dev.millionstps.io/v1/mp".to_string());

    // A fixed dev secret → stable bot identity; wallet label is derived from the pubkey.
    let secret: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(7).wrapping_add(3));
    let signer = DurableSigner::from_secret(&secret);
    let wallet = format!("0x{}", hex::encode(signer.public_key()));

    println!("→ connecting bot {wallet} to {ws_url}");
    let config = RelayConfig {
        ws_url: ws_url.clone(),
        wallet,
    };
    let conn = RelayConnection::connect_and_join(&config, &signer, "blackjack").await?;
    println!("✓ connected, authenticated (challenge signed), and sent queue.join blackjack");

    // Read for a few seconds: an Error means auth/queue was rejected; silence or match.found
    // means the handshake was accepted by the live relay.
    println!("… listening 6s for the relay's response");
    let deadline = Duration::from_secs(6);
    loop {
        match tokio::time::timeout(deadline, conn.recv()).await {
            Ok(Ok(Some(RelayToBot::Error { code, message }))) => {
                anyhow::bail!("✗ relay rejected the bot: {code} — {message}");
            }
            Ok(Ok(Some(RelayToBot::MatchFound {
                match_id,
                role,
                opponent_wallet,
                game,
            }))) => {
                println!(
                    "✓ MATCH FOUND on live relay: match={match_id} role={role} game={game} opponent={opponent_wallet}"
                );
                break;
            }
            Ok(Ok(Some(other))) => println!("  · server msg: {other:?}"),
            Ok(Ok(None)) => {
                println!("  · relay closed the socket");
                break;
            }
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                println!(
                    "✓ no rejection within 6s → connect + auth + queue.join ACCEPTED by the deployed relay"
                );
                println!("  (no opponent waiting; full match-play is the manual E2E)");
                break;
            }
        }
    }
    Ok(())
}
