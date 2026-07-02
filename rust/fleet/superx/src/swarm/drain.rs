//! SIGTERM / SIGINT -> graceful-stop wiring for the `run-swarm` worker.
//!
//! `stop` = SIGTERM: the daemon drains a swarm by terminating it, and the swarm
//! must finish its current phase (no half-open tunnels) rather than die mid-open.
//! The pipeline polls a shared [`AtomicBool`]; this module flips that flag on the
//! first stop signal from a detached listener so a graceful drain begins.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Spawn a detached listener that sets `stop` on the first SIGINT or SIGTERM.
///
/// Runs on its own current-thread runtime, independent of the pipeline's worker
/// runtime, so the signal is observed even while every worker thread is busy
/// driving tunnels. Idempotent from the pipeline's side: a second signal is a
/// no-op because the flag is already set.
pub fn install_graceful_stop(stop: Arc<AtomicBool>) {
    std::thread::Builder::new()
        .name("fleet-superx-signal".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("fleet superx signal runtime");
            runtime.block_on(wait_for_stop_signal());
            stop.store(true, Ordering::Relaxed);
        })
        .expect("spawn fleet superx signal thread");
}

/// Resolve on the first SIGINT (Ctrl-C) or SIGTERM.
#[cfg(unix)]
async fn wait_for_stop_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = match signal(SignalKind::terminate()) {
        Ok(stream) => stream,
        // Without a SIGTERM stream we can still honour Ctrl-C.
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
            return;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}

/// Non-unix fallback: honour Ctrl-C only.
#[cfg(not(unix))]
async fn wait_for_stop_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
