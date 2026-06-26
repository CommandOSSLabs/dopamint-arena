//! End-to-end smoke: the built binary runs a tiny matches-bounded fleet and
//! prints the report lines. Uses CARGO_BIN_EXE_rustbench (Cargo sets this for
//! integration tests of a crate with a binary).

use std::process::Command;

#[test]
fn binary_runs_and_prints_report_lines() {
    let exe = env!("CARGO_BIN_EXE_rustbench");
    let out = Command::new(exe)
        .args([
            "--offchain",
            "--channel",
            "local",
            "--game",
            "blackjack",
            "--workers",
            "1",
            "--matches",
            "3",
            "--runner",
            "simple",
            "--deterministic",
        ])
        .output()
        .expect("run rustbench");
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.contains("[local/offchain] fleet: workers=1\n"),
        "got:\n{stdout}"
    );
    // 3 matches * 143 moves = 429 moves, 3 tunnels.
    assert!(
        stdout.contains("swarm: 429 moves over 3 matches"),
        "got:\n{stdout}"
    );
    assert!(stdout.contains("tunnels settled: 3 "), "got:\n{stdout}");
    assert!(stdout.contains("aggregate move-TPS:"), "got:\n{stdout}");
    assert!(stdout.contains("resources: cpu avg="), "got:\n{stdout}");
}

#[test]
fn rejects_unsupported_flag() {
    let exe = env!("CARGO_BIN_EXE_rustbench");
    let out = Command::new(exe).args(["--onchain"]).output().expect("run");
    assert!(!out.status.success());
}
