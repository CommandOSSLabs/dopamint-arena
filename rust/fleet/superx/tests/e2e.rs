//! Full-stack daemon e2e over the real binary.
//!
//! Spawns the actual `fleet-superx daemon` process (`CARGO_BIN_EXE_fleet-superx`)
//! with a live heartbeat sink on an ephemeral loopback port and a temp Unix
//! control socket, then drives the real `start`/`watch`/`ls` client subcommands
//! against it: a distribute run of 8 tunnels across 2 swarms (memory anchor,
//! golden), watched to completion, with `ls` reporting the run `finished` and all
//! 8 tunnels settled. The daemon is killed and its socket removed on exit so the
//! test leaks no processes.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::net::UnixStream;
use tokio::process::Command;

/// Path to the freshly built `fleet-superx` binary. Defined because the binary
/// lives in this same crate as the test.
fn exe() -> &'static str {
    env!("CARGO_BIN_EXE_fleet-superx")
}

/// A unique per-test control socket under the OS temp dir so concurrent test
/// processes never share a listener.
fn temp_socket() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut path = std::env::temp_dir();
    path.push(format!("fleet-superx-e2e-{}-{}.sock", std::process::id(), nanos));
    path
}

/// Poll-connect to `socket` until the daemon has bound it (or time out). The
/// daemon binds asynchronously after spawn, so the first `start` must wait for
/// the listener to come up.
async fn wait_for_socket(socket: &Path) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if UnixStream::connect(socket).await.is_ok() {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("daemon never bound {}", socket.display());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Run one client subcommand to completion and return its trimmed stdout,
/// asserting a clean exit within `timeout`.
async fn run_client(socket: &Path, args: &[&str], timeout: Duration) -> String {
    let mut cmd = Command::new(exe());
    cmd.arg(args[0])
        .arg("--connect")
        .arg(socket)
        .args(&args[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let child = cmd.spawn().expect("spawn client subcommand");
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .unwrap_or_else(|_| panic!("client `{}` timed out", args[0]))
        .expect("await client output");
    assert!(
        output.status.success(),
        "client `{}` exited with {:?}",
        args[0],
        output.status.code()
    );
    String::from_utf8(output.stdout)
        .expect("client stdout is utf8")
        .trim()
        .to_string()
}

#[tokio::test]
async fn daemon_start_watch_ls_full_path() {
    let socket = temp_socket();
    let _ = std::fs::remove_file(&socket);

    // Spawn the real daemon: temp control socket + ephemeral sink port. Killed on
    // drop so a panicking assertion never leaks the process.
    let mut daemon = Command::new(exe())
        .arg("daemon")
        .arg("--socket")
        .arg(&socket)
        .arg("--sink-addr")
        .arg("127.0.0.1:0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn daemon");

    wait_for_socket(&socket).await;

    // start: distribute 8 tunnels across 2 swarms over the memory anchor.
    let started = run_client(
        &socket,
        &[
            "start",
            "--mode",
            "distribute",
            "--swarms",
            "2",
            "--tunnels",
            "8",
            "--protocol",
            "payments.v1",
            "--anchor",
            "memory",
            "--scenario",
            "golden",
            "--for",
            "30s",
        ],
        Duration::from_secs(10),
    )
    .await;
    let run_id = started
        .strip_prefix("started ")
        .unwrap_or_else(|| panic!("unexpected start output: {started:?}"))
        .trim()
        .to_string();
    assert!(!run_id.is_empty(), "start reports a run id");

    // watch: streams live monitoring and exits 0 on the terminal `Ended`.
    let watched = run_client(
        &socket,
        &["watch", &run_id],
        Duration::from_secs(90),
    )
    .await;
    assert!(
        watched.contains(&format!("[{run_id}] ended")),
        "watch stream reaches Ended: {watched:?}"
    );

    // ls: the run is now finished with every tunnel settled.
    let listed = run_client(&socket, &["ls"], Duration::from_secs(10)).await;
    let run_line = listed
        .lines()
        .find(|line| line.contains(&run_id))
        .unwrap_or_else(|| panic!("run {run_id} missing from ls output: {listed:?}"));
    assert!(
        run_line.contains("finished"),
        "run reports finished: {run_line:?}"
    );
    assert!(
        run_line.contains("settled=8"),
        "all 8 tunnels settled: {run_line:?}"
    );

    // Clean up: kill the daemon and remove its socket so nothing leaks.
    let _ = daemon.kill().await;
    let _ = std::fs::remove_file(&socket);
}
