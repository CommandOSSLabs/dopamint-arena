//! Single governed JSON-RPC entrypoint for the Sui fullnode: classifies failures so a
//! transient rate-limit (429) is told apart from a genuine rejection, retries transient
//! ones with backoff+jitter (honoring `Retry-After`), and bounds in-flight calls with an
//! AIMD limiter. Shared by the settler and the arena opener — they pound the same node, so
//! the throttle must be process-wide, not per-caller.

/// Why a JSON-RPC call failed, split by whether retrying can help.
#[derive(Debug)]
pub enum RpcError {
    /// Rate-limit / overload / transport — safe to retry; never the caller's fault. Carries
    /// the server's `Retry-After` (seconds) when present so backoff can honor it.
    Transient {
        msg: String,
        retry_after: Option<u64>,
    },
    /// The node executed and rejected it (bad sig, already closed, balance mismatch) or the
    /// request was malformed — retrying the same bytes will not help.
    Rejected(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Transient { msg, .. } => write!(f, "transient: {msg}"),
            RpcError::Rejected(m) => write!(f, "rejected: {m}"),
        }
    }
}
impl std::error::Error for RpcError {}

/// Map an HTTP status (+ optional `Retry-After` secs + body) to the taxonomy. 429/408/5xx
/// are transient; any other non-2xx is a rejection; 2xx is not an error. Pure, so the policy
/// is unit-pinned independent of the network.
pub(crate) fn classify_status(
    status: u16,
    retry_after: Option<u64>,
    body: &str,
) -> Option<RpcError> {
    if (200..300).contains(&status) {
        return None;
    }
    if status == 429 || status == 408 || (500..600).contains(&status) {
        Some(RpcError::Transient {
            msg: format!("http {status}: {body}"),
            retry_after,
        })
    } else {
        Some(RpcError::Rejected(format!("http {status}: {body}")))
    }
}

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Tunable bounds for the governed RPC layer. Defaults are conservative for the public
/// testnet fullnode (undocumented limit) and are meant to be tuned empirically via env.
#[derive(Clone, Copy)]
pub struct RpcLimits {
    pub min: usize,
    pub start: usize,
    pub max: usize,
    pub grow_after: usize,
    pub max_retries: u32,
    pub base_backoff_ms: u64,
    pub max_backoff_ms: u64,
}
impl Default for RpcLimits {
    fn default() -> Self {
        Self {
            min: 2,
            start: 8,
            max: 16,
            grow_after: 20,
            max_retries: 5,
            base_backoff_ms: 200,
            max_backoff_ms: 4_000,
        }
    }
}

/// Additive-increase / multiplicative-decrease concurrency limiter over a shared
/// `Semaphore`. The fullnode's limit is undocumented, so we adapt to it: shrink the
/// effective permit budget on a transient (429), grow it on sustained success. The
/// semaphore is sized to `max`; `max - effective` permits are held back ("forgotten").
pub(crate) struct AimdLimiter {
    sem: Arc<Semaphore>,
    max: usize,
    min: usize,
    effective: AtomicUsize,
    success_streak: AtomicUsize,
    grow_after: usize,
}

impl AimdLimiter {
    pub fn new(min: usize, start: usize, max: usize, grow_after: usize) -> Self {
        let max = max.max(1);
        let start = start.clamp(1, max);
        let sem = Arc::new(Semaphore::new(max));
        // Reserve (max - start) permits so only `start` are initially available.
        let reserve = max - start;
        if reserve > 0 {
            sem.forget_permits(reserve);
        }
        Self {
            sem,
            max,
            min: min.clamp(1, max),
            effective: AtomicUsize::new(start),
            success_streak: AtomicUsize::new(0),
            grow_after: grow_after.max(1),
        }
    }

    #[cfg(test)] // observability accessor; the first non-test reader is the metrics gauge
    pub fn effective(&self) -> usize {
        self.effective.load(Ordering::Relaxed)
    }

    /// Multiplicative decrease: halve the budget (down to `min`) and forget the freed
    /// permits so fewer calls run concurrently after a rate-limit.
    pub fn on_transient(&self) {
        self.success_streak.store(0, Ordering::Relaxed);
        let cur = self.effective.load(Ordering::Relaxed);
        let next = (cur / 2).max(self.min);
        if next < cur {
            self.sem.forget_permits(cur - next);
            self.effective.store(next, Ordering::Relaxed);
        }
    }

    /// Additive increase: after `grow_after` consecutive successes, hand one permit back
    /// (up to `max`), then reset the streak.
    pub fn on_success(&self) {
        let cur = self.effective.load(Ordering::Relaxed);
        if cur >= self.max {
            return;
        }
        if self.success_streak.fetch_add(1, Ordering::Relaxed) + 1 >= self.grow_after {
            self.success_streak.store(0, Ordering::Relaxed);
            self.sem.add_permits(1);
            self.effective.store(cur + 1, Ordering::Relaxed);
        }
    }

    pub async fn acquire(&self) -> OwnedSemaphorePermit {
        self.sem
            .clone()
            .acquire_owned()
            .await
            .expect("rpc semaphore is never closed")
    }
}

/// Full-jitter in `[0, capped]` without pulling in `rand`: the subsec-nanos clock is a
/// cheap entropy source, and backoff jitter does not need cryptographic quality.
fn jitter_ms(capped: u64) -> u64 {
    if capped == 0 {
        return 0;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    nanos % (capped + 1)
}

/// The single throttled+retried JSON-RPC client. Owns the `reqwest::Client` and the AIMD
/// limiter; every fullnode call by the settler/opener goes through `call`.
pub struct GovernedRpc {
    http: reqwest::Client,
    url: String,
    limiter: AimdLimiter,
    limits: RpcLimits,
}

impl GovernedRpc {
    pub fn new(url: String, limits: RpcLimits) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client builds with a static config");
        let limiter = AimdLimiter::new(limits.min, limits.start, limits.max, limits.grow_after);
        Arc::new(Self {
            http,
            url,
            limiter,
            limits,
        })
    }

    /// Backoff for attempt `n` (0-based): exponential `base*2^n` capped at `max_backoff_ms`,
    /// with full jitter; a server `Retry-After` (secs) wins if larger. Pure schedule.
    fn backoff_ms(&self, attempt: u32, retry_after: Option<u64>) -> u64 {
        let shift = attempt.min(20);
        let exp = self
            .limits
            .base_backoff_ms
            .saturating_mul(1u64 << shift)
            .min(self.limits.max_backoff_ms);
        let jittered = jitter_ms(exp);
        match retry_after {
            Some(s) => (s.saturating_mul(1000)).max(jittered),
            None => jittered,
        }
    }

    /// One JSON-RPC call, throttled by AIMD and retried on transient up to `max_retries`.
    /// Rejections return immediately. Result is the JSON-RPC `result` field (or `Null`).
    pub async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, RpcError> {
        let body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
        let mut attempt = 0u32;
        loop {
            let permit = self.limiter.acquire().await;
            match self.try_once(&body).await {
                Ok(v) => {
                    self.limiter.on_success();
                    return Ok(v);
                }
                Err(RpcError::Rejected(m)) => return Err(RpcError::Rejected(m)),
                Err(RpcError::Transient { msg, retry_after }) => {
                    self.limiter.on_transient();
                    drop(permit);
                    if attempt >= self.limits.max_retries {
                        return Err(RpcError::Transient { msg, retry_after });
                    }
                    let wait = self.backoff_ms(attempt, retry_after);
                    tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
                    attempt += 1;
                }
            }
        }
    }

    async fn try_once(&self, body: &serde_json::Value) -> Result<serde_json::Value, RpcError> {
        let resp = self
            .http
            .post(&self.url)
            .json(body)
            .send()
            .await
            .map_err(|e| RpcError::Transient {
                msg: e.to_string(),
                retry_after: None,
            })?;
        let status = resp.status().as_u16();
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok());
        let text = resp.text().await.map_err(|e| RpcError::Transient {
            msg: e.to_string(),
            retry_after: None,
        })?;
        if let Some(err) = classify_status(status, retry_after, &text) {
            return Err(err);
        }
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| RpcError::Rejected(format!("bad json: {e}")))?;
        if let Some(err) = json.get("error") {
            // A JSON-RPC application error arrives with HTTP 200: the node rejected it.
            return Err(RpcError::Rejected(format!("rpc error: {err}")));
        }
        Ok(json
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_429_is_transient_and_carries_retry_after() {
        match classify_status(429, Some(3), "slow down") {
            Some(RpcError::Transient { retry_after, .. }) => assert_eq!(retry_after, Some(3)),
            other => panic!("expected transient, got {other:?}"),
        }
    }

    #[test]
    fn http_5xx_and_408_are_transient() {
        assert!(matches!(
            classify_status(503, None, ""),
            Some(RpcError::Transient { .. })
        ));
        assert!(matches!(
            classify_status(408, None, ""),
            Some(RpcError::Transient { .. })
        ));
    }

    #[test]
    fn http_400_is_rejected_not_retried() {
        assert!(matches!(
            classify_status(400, None, "bad"),
            Some(RpcError::Rejected(_))
        ));
    }

    #[test]
    fn http_2xx_is_not_an_error() {
        assert!(classify_status(200, None, "{}").is_none());
    }

    #[test]
    fn aimd_transient_halves_budget_down_to_min() {
        let l = AimdLimiter::new(2, 16, 16, 5);
        l.on_transient(); // 16 -> 8
        assert_eq!(l.effective(), 8);
        l.on_transient(); // 8 -> 4
        l.on_transient(); // 4 -> 2
        l.on_transient(); // 2 -> 2 (min floor)
        assert_eq!(l.effective(), 2);
    }

    #[test]
    fn aimd_success_streak_grows_budget_by_one_then_caps() {
        let l = AimdLimiter::new(1, 1, 2, 3);
        l.on_success();
        l.on_success();
        assert_eq!(l.effective(), 1, "not yet at grow_after");
        l.on_success(); // 3rd success -> +1
        assert_eq!(l.effective(), 2);
        l.on_success();
        l.on_success();
        l.on_success();
        assert_eq!(l.effective(), 2, "capped at max");
    }

    #[test]
    fn backoff_retry_after_overrides_jittered_exp() {
        let g = GovernedRpc::new("http://x".into(), RpcLimits::default());
        // Retry-After 10s must dominate the (≤4s) jittered exponential backoff.
        assert!(g.backoff_ms(0, Some(10)) >= 10_000);
    }

    #[test]
    fn backoff_is_capped_at_max() {
        let g = GovernedRpc::new("http://x".into(), RpcLimits::default());
        for n in 0..12 {
            assert!(g.backoff_ms(n, None) <= 4_000);
        }
    }
}
