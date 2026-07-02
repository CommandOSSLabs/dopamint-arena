//! SIGTERM / SIGINT -> graceful-stop wiring for the `run-swarm` worker.
//!
//! `stop` = SIGTERM: the daemon drains a swarm by terminating it, and the swarm
//! must finish its current phase (no half-open tunnels) rather than die mid-open.
//! The pipeline polls a shared [`AtomicBool`]; this module flips that flag on the
//! first stop signal from a detached listener so a graceful drain begins.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Spawn a detached listener that sets `stop` on the first SIGINT or SIGTERM,
/// **blocking until the signal handlers are registered**.
///
/// Runs on its own current-thread runtime, independent of the pipeline's worker
/// runtime, so the signal is observed even while every worker thread is busy
/// driving tunnels. Returning only after registration matters for graceful stop:
/// a supervisor that spawns this worker and then sends SIGTERM must not race a
/// window where the handler is not yet installed and the default disposition
/// (terminate) would kill the swarm mid-phase. Idempotent from the pipeline's
/// side: a second signal is a no-op because the flag is already set.
pub fn install_graceful_stop(stop: Arc<AtomicBool>) {
    let (registered_tx, registered_rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("fleet-superx-signal".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("fleet superx signal runtime");
            runtime.block_on(async move {
                // Register the handlers inside the runtime context, then release
                // the caller — only now is an incoming stop signal caught.
                let signals = StopSignals::register();
                let _ = registered_tx.send(());
                signals.recv().await;
                stop.store(true, Ordering::Relaxed);
            });
        })
        .expect("spawn fleet superx signal thread");
    // Block until the listener thread has registered its handlers.
    let _ = registered_rx.recv();
}

/// The stop-signal streams, registered synchronously so a caller can know an
/// incoming signal will be caught rather than defaulting to process termination.
#[cfg(unix)]
struct StopSignals {
    terminate: Option<tokio::signal::unix::Signal>,
    interrupt: Option<tokio::signal::unix::Signal>,
}

#[cfg(unix)]
impl StopSignals {
    /// Register SIGTERM and SIGINT handlers. Registration happens on
    /// construction (tokio installs the underlying `sigaction` immediately), so
    /// once this returns the signals are honoured.
    fn register() -> Self {
        use tokio::signal::unix::{signal, SignalKind};
        Self {
            terminate: signal(SignalKind::terminate()).ok(),
            interrupt: signal(SignalKind::interrupt()).ok(),
        }
    }

    /// Resolve on the first SIGTERM or SIGINT.
    async fn recv(mut self) {
        match (self.terminate.as_mut(), self.interrupt.as_mut()) {
            (Some(term), Some(intr)) => {
                tokio::select! {
                    _ = term.recv() => {}
                    _ = intr.recv() => {}
                }
            }
            (Some(term), None) => {
                term.recv().await;
            }
            (None, Some(intr)) => {
                intr.recv().await;
            }
            // Neither stream registered: fall back to the async Ctrl-C helper.
            (None, None) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
}

/// Non-unix fallback: honour Ctrl-C only. Ctrl-C registers on first `await`, so
/// there is no separate synchronous registration step.
#[cfg(not(unix))]
struct StopSignals;

#[cfg(not(unix))]
impl StopSignals {
    fn register() -> Self {
        Self
    }
    async fn recv(self) {
        let _ = tokio::signal::ctrl_c().await;
    }
}
