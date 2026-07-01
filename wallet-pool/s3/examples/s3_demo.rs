//! Minimal end-to-end demo: round-trip an opaque blob through the S3 store.
//!
//! Export AWS credentials and the bucket, then:
//!   cargo run -p wallet-pool-s3 --example s3_demo

use wallet_pool::store::WalletPoolStore;
use wallet_pool_s3::S3WalletPoolStore;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let store = S3WalletPoolStore::from_env().await?;
    let id = "wp_demo";

    println!("writing {id} …");
    store.write(id, b"hello from the s3 store").await?;

    println!("reading {id} …");
    let bytes = store
        .read(id)
        .await?
        .expect("blob should exist right after write");
    println!("  got: {}", String::from_utf8_lossy(&bytes));

    println!("listing bucket …");
    for entry in store.list().await? {
        println!("  - {entry}");
    }

    println!("deleting {id} …");
    store.delete(id).await?;

    println!("done.");
    Ok(())
}
