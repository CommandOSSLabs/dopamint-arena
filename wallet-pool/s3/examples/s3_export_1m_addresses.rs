//! Export all member addresses from a wallet pool to a plain-text file.
//!
//! One address per line. The master wallet is omitted; only entries with
//! [`WalletRole::Member`] are written.
//!
//! Required environment variables:
//!   - `WALLET_POOL_ID` — pool id to export (e.g. `wp_…`).
//!   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — S3 credentials.
//!   - `WALLET_POOL_S3_BUCKET` — S3 bucket name.
//!
//! Optional environment variables:
//!   - `OUTPUT_PATH` — destination file (default `wallet-pool-1m-addresses.txt`).

use std::path::PathBuf;
use tokio::fs::File;
use tokio::io::{AsyncWriteExt, BufWriter};
use wallet_pool::store::WalletPoolStore;
use wallet_pool_core::blob::{parse_blob, WalletRole};
use wallet_pool_s3::S3WalletPoolStore;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pool_id = std::env::var("WALLET_POOL_ID").expect("set WALLET_POOL_ID");
    let output_path: PathBuf = std::env::var("OUTPUT_PATH")
        .unwrap_or_else(|_| "wallet-pool-1m-addresses.txt".into())
        .into();

    let store = S3WalletPoolStore::from_env().await?;

    println!("Reading pool {pool_id} from S3 …");
    let bytes = store
        .read(&pool_id)
        .await?
        .ok_or_else(|| format!("pool not found: {pool_id}"))?;

    println!("Parsing blob ({} bytes) …", bytes.len());
    let blob = parse_blob(&bytes)?;

    let file = File::create(&output_path).await?;
    let mut writer = BufWriter::new(file);
    let mut count = 0u64;

    println!("Writing member addresses to {} …", output_path.display());
    for entry in &blob.index {
        if entry.role == WalletRole::Member {
            writer.write_all(entry.address.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            count += 1;
        }
    }

    writer.flush().await?;
    println!(
        "Done. Wrote {count} member addresses to {}.",
        output_path.display()
    );

    Ok(())
}
