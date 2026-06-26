//! The Signer seam: co-signing. Local ed25519 here; remote KMS is a follow-on impl.
pub mod local;

pub trait Signer: Send + Sync + 'static {
    fn public_key(&self) -> [u8; 32];

    fn sign(&self, msg: &[u8]) -> impl std::future::Future<Output = [u8; 64]> + Send;
}
