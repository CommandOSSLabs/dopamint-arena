//! Retry-by-split for batched settlement (ADR-0029). A batch of closes goes out as one PTB;
//! if it aborts on-chain (a poison settlement — e.g. one tunnel already closed reverts the
//! whole tx), we binary-split and retry to isolate the offender, so one bad settlement does
//! not fail its batch-mates. Split depth is capped so a pathological batch can't amplify RPC
//! load without bound. A *transient* failure (rate-limit) is NOT split — splitting can't help a
//! busy node, so it propagates to the whole sub-batch for the worker to re-queue.

use std::future::Future;

use crate::sui::{CloseArgs, CloseError};

/// Submit `closes` as one PTB via `submit`, isolating poison settlements by binary split.
/// Returns one result per input close, in input order. `submit` takes a sub-batch by value and
/// returns the shared tx digest (every member of a successful PTB gets it) or a `CloseError`.
pub async fn split_submit<F, Fut>(
    closes: Vec<CloseArgs>,
    max_depth: u32,
    submit: F,
) -> Vec<Result<String, CloseError>>
where
    F: Fn(Vec<CloseArgs>) -> Fut,
    Fut: Future<Output = Result<String, CloseError>>,
{
    let n = closes.len();
    let mut out: Vec<Option<Result<String, CloseError>>> = (0..n).map(|_| None).collect();
    // Work items are index sets into `closes` (preserving input order for the result map).
    let mut stack: Vec<(Vec<usize>, u32)> = vec![((0..n).collect(), 0)];
    while let Some((idxs, depth)) = stack.pop() {
        if idxs.is_empty() {
            continue;
        }
        let sub: Vec<CloseArgs> = idxs.iter().map(|&i| closes[i].clone()).collect();
        match submit(sub).await {
            Ok(digest) => {
                for &i in &idxs {
                    out[i] = Some(Ok(digest.clone()));
                }
            }
            // A rate-limit won't be helped by splitting — fail the whole sub-batch transiently so
            // the worker re-queues it intact (the governed RPC already exhausted its own retries).
            Err(CloseError::Transient { msg, retry_after }) => {
                for &i in &idxs {
                    out[i] = Some(Err(CloseError::Transient {
                        msg: msg.clone(),
                        retry_after,
                    }));
                }
            }
            // An on-chain abort poisons the whole PTB. Split to isolate it; once down to a single
            // close (or at the depth cap) attribute the rejection to whatever remains.
            Err(CloseError::Rejected(msg)) => {
                if idxs.len() == 1 || depth >= max_depth {
                    for &i in &idxs {
                        out[i] = Some(Err(CloseError::Rejected(msg.clone())));
                    }
                } else {
                    let mid = idxs.len() / 2;
                    let (left, right) = idxs.split_at(mid);
                    stack.push((left.to_vec(), depth + 1));
                    stack.push((right.to_vec(), depth + 1));
                }
            }
        }
    }
    out.into_iter()
        .map(|o| o.expect("every index is resolved before return"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn close(tunnel: &str) -> CloseArgs {
        CloseArgs {
            tunnel_id: tunnel.to_string(),
            party_a_balance: 1,
            party_b_balance: 1,
            sig_a: vec![1; 64],
            sig_b: vec![2; 64],
            timestamp: 1,
            transcript_root: vec![0; 32],
        }
    }

    #[tokio::test]
    async fn split_isolates_poison_and_settles_the_rest() {
        let closes = vec![close("a"), close("b"), close("poison"), close("d")];
        let out = split_submit(closes, 8, |sub| async move {
            if sub.iter().any(|c| c.tunnel_id == "poison") {
                Err(CloseError::Rejected("ETunnelClosed".into()))
            } else {
                Ok("digest".to_string())
            }
        })
        .await;
        assert_eq!(out.len(), 4);
        assert!(out[0].is_ok() && out[1].is_ok() && out[3].is_ok());
        assert!(
            matches!(out[2], Err(CloseError::Rejected(_))),
            "only the poison settlement fails"
        );
    }

    #[tokio::test]
    async fn all_good_batch_submits_once_no_split() {
        let calls = AtomicUsize::new(0);
        let closes = vec![close("a"), close("b"), close("c")];
        let out = split_submit(closes, 8, |_sub| {
            calls.fetch_add(1, Ordering::Relaxed);
            async { Ok("d".to_string()) }
        })
        .await;
        assert!(out.iter().all(|r| r.is_ok()));
        assert_eq!(
            calls.load(Ordering::Relaxed),
            1,
            "no split when nothing aborts"
        );
    }

    #[tokio::test]
    async fn transient_does_not_split() {
        let calls = AtomicUsize::new(0);
        let closes = vec![close("a"), close("b"), close("c"), close("d")];
        let out = split_submit(closes, 8, |_sub| {
            calls.fetch_add(1, Ordering::Relaxed);
            async {
                Err(CloseError::Transient {
                    msg: "429".into(),
                    retry_after: Some(2),
                })
            }
        })
        .await;
        assert!(out
            .iter()
            .all(|r| matches!(r, Err(CloseError::Transient { .. }))));
        assert_eq!(calls.load(Ordering::Relaxed), 1, "rate-limit is not split");
    }

    #[tokio::test]
    async fn split_depth_is_capped() {
        let calls = AtomicUsize::new(0);
        // Every sub-batch aborts; with depth cap 1 the 4-item batch splits at most one level
        // (1 root + 2 children = 3 submit calls), never down to singles.
        let closes = vec![close("a"), close("b"), close("c"), close("d")];
        let out = split_submit(closes, 1, |_sub| {
            calls.fetch_add(1, Ordering::Relaxed);
            async { Err(CloseError::Rejected("boom".into())) }
        })
        .await;
        assert!(out.iter().all(|r| r.is_err()));
        assert_eq!(
            calls.load(Ordering::Relaxed),
            3,
            "1 root + 2 children, capped"
        );
    }
}
