//! The Signer seam: co-signing. Local ed25519 here (synchronous); a remote-KMS
//! signer is the documented future async variant, built outside the sans-IO core.
pub mod local;

pub trait Signer: Send + Sync + 'static {
    fn public_key(&self) -> [u8; 32];
    fn sign(&self, msg: &[u8]) -> [u8; 64];
}
