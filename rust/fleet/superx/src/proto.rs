//! Control-plane wire protocol between the `fleet-superx` client and daemon.
//!
//! Both transports (unix socket, WebSocket) carry the same JSON messages; the
//! unix transport frames them as newline-delimited JSON via [`encode_line`] /
//! [`decode_line`]. These types are the stable serde contract, so field names
//! and variant tags must stay stable across versions.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// How a run fans its per-swarm work across the spawned `run-swarm` processes.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpawnMode {
    /// Each swarm gets the full per-swarm config; all run concurrently.
    Replicate,
    /// Numeric targets (tunnels, moves) are split across swarms; all concurrent.
    Distribute,
    /// Each swarm gets the full per-swarm config, one swarm at a time.
    Sequential,
}

/// Batching knobs forwarded to each swarm's staged open/settle pipeline. Mirrors
/// `swarm::pipeline::CohortConfig`; `None` cohort means "no concurrency cap".
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct CohortWire {
    pub open_cohort: Option<usize>,
    pub open_spacing: Duration,
    pub settle_cohort: Option<usize>,
    pub settle_spacing: Duration,
}

/// Parameters of a `start` command: everything the daemon needs to build a
/// [`crate::runconfig::RunConfig`] and spawn the swarm set.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct StartRun {
    pub mode: SpawnMode,
    pub swarms: u64,
    pub protocol: String,
    pub duration: Duration,
    pub until_stop: bool,
    pub tunnels: u64,
    pub scenario: String,
    pub anchor: String,
    pub initial_balance: u64,
    pub cohorts: CohortWire,
    /// Extra passthrough args appended verbatim to each `run-swarm` argv.
    pub extra: Vec<String>,
}

/// A client → daemon request.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Start(StartRun),
    Stop { run_id: String },
    List,
    Watch { run_id: String },
}

/// Fleet-level rollup of a run's swarm reports. Mirrors `merge::RunAggregate`;
/// the daemon fills it once every swarm report is collected and merged.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RunAggregateWire {
    pub swarms: u64,
    pub tunnels_opened: u64,
    pub tunnels_settled: u64,
    pub tunnels_failed: u64,
    pub tunnels_aborted: u64,
    pub moves: u64,
    pub wall_ms: u128,
    pub wall_move_tps: f64,
    pub cpu_cores_avg: f64,
    pub rss_peak_bytes: u64,
}

/// One row of a `List` response: a run's identity, lifecycle state, and (once
/// finished) its aggregate.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RunSummary {
    pub run_id: String,
    pub state: String,
    pub mode: SpawnMode,
    pub swarms: u64,
    pub aggregate: Option<RunAggregateWire>,
}

/// A streamed monitoring event for `Watch` (and any run-state broadcast).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum RunEvent {
    State { run_id: String, state: String },
    Aggregate(RunAggregateWire),
    Ended { run_id: String },
}

/// A daemon → client response.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum Response {
    Started { run_id: String },
    Stopped,
    Runs(Vec<RunSummary>),
    Event(RunEvent),
    Error(String),
}

/// Encode a message as a single newline-terminated JSON line (unix framing).
///
/// Serialization is infallible for these types (no maps with non-string keys,
/// no custom `Serialize` that can error), so a serde failure is a programming
/// bug and is surfaced as an inline JSON error object rather than panicking.
pub fn encode_line<T: Serialize>(msg: &T) -> String {
    match serde_json::to_string(msg) {
        Ok(mut s) => {
            s.push('\n');
            s
        }
        Err(e) => format!(
            "{{\"encode_error\":{}}}\n",
            serde_json::json!(e.to_string())
        ),
    }
}

/// Decode one newline-delimited JSON frame. Trailing/leading whitespace (the
/// framing newline) is tolerated.
pub fn decode_line<T: DeserializeOwned>(line: &str) -> Result<T, serde_json::Error> {
    serde_json::from_str(line.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn sample_start() -> StartRun {
        StartRun {
            mode: SpawnMode::Distribute,
            swarms: 3,
            protocol: "blackjack.v2".to_string(),
            duration: Duration::from_secs(30),
            until_stop: false,
            tunnels: 12,
            scenario: "golden".to_string(),
            anchor: "memory".to_string(),
            initial_balance: 1_000,
            cohorts: CohortWire {
                open_cohort: Some(4),
                open_spacing: Duration::from_millis(5),
                settle_cohort: None,
                settle_spacing: Duration::ZERO,
            },
            extra: vec!["--sui-rpc".to_string(), "http://x".to_string()],
        }
    }

    fn roundtrips(msg: &Request) {
        let line = encode_line(msg);
        assert!(line.ends_with('\n'), "frame must be newline-delimited");
        assert!(
            !line[..line.len() - 1].contains('\n'),
            "frame must be single-line"
        );
        let back: Request = decode_line(&line).expect("decode");
        assert_eq!(&back, msg);
    }

    fn roundtrips_resp(msg: &Response) {
        let line = encode_line(msg);
        let back: Response = decode_line(&line).expect("decode");
        assert_eq!(&back, msg);
    }

    #[test]
    fn request_variants_roundtrip() {
        roundtrips(&Request::Start(sample_start()));
        roundtrips(&Request::Stop {
            run_id: "run-7".to_string(),
        });
        roundtrips(&Request::List);
        roundtrips(&Request::Watch {
            run_id: "run-7".to_string(),
        });
    }

    #[test]
    fn response_variants_roundtrip() {
        let aggregate = RunAggregateWire {
            swarms: 3,
            tunnels_opened: 12,
            tunnels_settled: 12,
            tunnels_failed: 0,
            tunnels_aborted: 0,
            moves: 4_800,
            wall_ms: 31_000,
            wall_move_tps: 154.8,
            cpu_cores_avg: 2.5,
            rss_peak_bytes: 1_048_576,
        };
        roundtrips_resp(&Response::Started {
            run_id: "run-7".to_string(),
        });
        roundtrips_resp(&Response::Stopped);
        roundtrips_resp(&Response::Runs(vec![RunSummary {
            run_id: "run-7".to_string(),
            state: "running".to_string(),
            mode: SpawnMode::Distribute,
            swarms: 3,
            aggregate: Some(aggregate.clone()),
        }]));
        roundtrips_resp(&Response::Event(RunEvent::State {
            run_id: "run-7".to_string(),
            state: "running".to_string(),
        }));
        roundtrips_resp(&Response::Event(RunEvent::Aggregate(aggregate)));
        roundtrips_resp(&Response::Event(RunEvent::Ended {
            run_id: "run-7".to_string(),
        }));
        roundtrips_resp(&Response::Error("boom".to_string()));
    }

    #[test]
    fn decode_rejects_malformed_line() {
        assert!(decode_line::<Request>("not json\n").is_err());
    }
}
