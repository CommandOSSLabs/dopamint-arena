// COMPILE-GATE PROBE. If this does not build on the repo toolchain, the framework path is
// not viable here — fall back to the hand-rolled reader (…-2b-indexer-api.md Tasks 2–4).
use sui_indexer_alt_framework::cluster::IndexerCluster;

fn main() {
    // Reference a framework type so the dep is fully linked, not just resolved.
    let _ = std::any::type_name::<IndexerCluster>();
    println!("framework compiles");
}
