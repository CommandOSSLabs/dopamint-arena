# Settle Self-Authenticating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/settle` best-practice per [ADR-0007](../../decisions/0007-settle-authorized-by-settlement-not-token.md): authorize a cooperative close by the co-signed settlement itself (not a session bearer token), move it to the tunnel resource, drop the PvP `registerSession` round-trip, and have the gas sponsor dry-run the close before paying for it.

**Architecture:** The co-signed `SettlementWithRoot` is an unforgeable capability enforced on-chain at `close_cooperative_with_root`; a bearer token adds nothing. Phase A moves `/settle` to `POST /v1/tunnels/:id/settle`, removes the session/token gate, and simplifies the client (certain, unit-tested now). Phase B adds verify-before-gas: `submit_close` dry-runs the built PTB (`sui_dryRunTransactionBlock`) — the real Move re-verifies both sigs against the on-chain pubkeys — and rejects (422) before sponsoring gas (the status-parse is unit-tested; the live call is e2e-deferred, like the rest of the settler).

**Tech Stack:** Rust axum backend (`cargo test -p tunnel-manager`), TypeScript frontend (`node --import tsx --test`, `pnpm typecheck`/`build`), vendored `sui-tunnel-ts` SDK.

---

## Context & ground rules

- **Design spec:** [`2026-06-18-settle-self-authenticating-design.md`](../specs/2026-06-18-settle-self-authenticating-design.md). **ADR:** [0007](../../decisions/0007-settle-authorized-by-settlement-not-token.md).
- **Sole `/settle` caller** is the PvP tic-tac-toe lane (`frontend/src/games/ticTacToe/usePvpTicTacToe.ts`) + the `controlPlane.test.ts` unit test. Blackjack was descoped from `/settle`. A clean break (no back-compat route) is safe.
- **Path-case trap:** the PvP hook is tracked at **`frontend/src/games/ticTacToe/usePvpTicTacToe.ts`** (capital T's). macOS is case-insensitive so edits resolve, but **git pathspecs must use `ticTacToe`** — `git add .../tictactoe/...` silently stages nothing. Verify with `git ls-files`.
- **What is NOT unit-testable without a live node:** the `/settle` happy path (`submit_close` → `Ok`) needs a node (the codebase has no settler trait/mock and we are not adding one — Rule 2/11). Backend unit tests cover the **node-free guards** (409 already-closed, 422 tunnel/path mismatch) + the pure `dryrun_effects_ok` parser. The happy path stays build-verified + e2e-deferred (as the rest of the settler already is).
- **RTK proxy** summarizes `cargo test` output. To see a failure in detail, redirect: `cargo test -p tunnel-manager <filter> > /tmp/ct.log 2>&1; sed -n '1,80p' /tmp/ct.log`.
- **Git hygiene:** the working tree has unrelated WIP. Each task `git add`s ONLY its own files. Conventional Commits, no AI attribution, subject ≤ 50 chars.

## File Structure

Phase A (contract + client):
- Modify `backend/tunnel-manager/src/main.rs` — route `/v1/sessions/:id/settle` → `/v1/tunnels/:tunnel_id/settle`.
- Modify `backend/tunnel-manager/src/routes.rs` — de-authed `settle` handler + node-free guard tests.
- Modify `frontend/src/backend/controlPlane.ts` — `settle(tunnelId, body)` (drop session/token).
- Modify `frontend/src/backend/controlPlane.test.ts` — new path, no `authorization` header.
- Modify `frontend/src/games/ticTacToe/usePvpTicTacToe.ts` — drop `registerSession`/`sessionRef`; `settle(tunnelId, …)`.

Phase B (verify-before-gas):
- Modify `backend/tunnel-manager/src/sui.rs` — `dryrun_effects_ok` (pure, tested) + `dry_run` wired into `submit_close`.

---

## Phase A — Contract + client

### Task 1: De-auth `/settle`, move to the tunnel resource

**Files:**
- Modify: `backend/tunnel-manager/src/main.rs:95`
- Modify: `backend/tunnel-manager/src/routes.rs` (the `settle` handler + tests)

- [ ] **Step 1: Write the failing tests**

In `backend/tunnel-manager/src/routes.rs`, add to the `#[cfg(test)] mod tests` block (the module already imports `use super::*;` and `use super::test_support::test_state;`). Add these two tests and the shared sample const:

```rust
    // The exact camelCase settle JSON the SDK emits (tunnelId "0x1"), reused by the guard tests.
    const SAMPLE_SETTLE_JSON: &str = r#"{
        "settlement": {
            "tunnelId": "0x1", "partyABalance": "1500", "partyBBalance": "500",
            "finalNonce": "1", "timestamp": "1750000000000", "transcriptRoot": "0xabc"
        },
        "sigA": "0xaa", "sigB": "0xbb", "transcript": []
    }"#;

    // ADR-0007: the signed settlement commits to its tunnelId, so a path/body mismatch is a
    // client bug or a misroute — reject before any RPC, never sponsor gas for it.
    #[tokio::test]
    async fn settle_rejects_path_tunnel_mismatch() {
        let state = test_state();
        let req: SettleRequest = serde_json::from_str(SAMPLE_SETTLE_JSON).unwrap();
        let resp = settle(
            axum::extract::State(state),
            axum::extract::Path("0xDIFFERENT".to_string()),
            axum::Json(req),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    }

    // 409 when the event-derived registry already shows this tunnel closed — a free reject that
    // never reaches the settler (idempotency; ADR-0007 keeps this guard).
    #[tokio::test]
    async fn settle_conflicts_when_already_closed() {
        let state = test_state();
        state
            .control
            .set_tunnel_status("0x1", crate::state::TunnelStatus::Closed)
            .await;
        let req: SettleRequest = serde_json::from_str(SAMPLE_SETTLE_JSON).unwrap();
        let resp = settle(
            axum::extract::State(state),
            axum::extract::Path("0x1".to_string()),
            axum::Json(req),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::CONFLICT);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend/tunnel-manager && cargo test -p tunnel-manager settle_ > /tmp/ct.log 2>&1; sed -n '1,60p' /tmp/ct.log`
Expected: compile error — `settle` still takes a `HeaderMap` + `Path(session_id)` and the calls pass only `State/Path/Json`. (This is the failing state; the handler signature changes in Step 3.)

- [ ] **Step 3: Rewrite the `settle` handler (drop session + bearer; add tunnel resource)**

In `backend/tunnel-manager/src/routes.rs`, replace the entire `settle` function (the doc comment `/// Validate the settlement and submit ...` through its closing brace) with:

```rust
/// Submit `close_cooperative_with_root` for a tunnel. Authorization is the co-signed settlement
/// itself — the chain re-verifies both seat signatures — so there is NO session/bearer gate
/// (ADR-0007). The settler dry-runs the close before sponsoring gas, so a bad settlement is
/// rejected (422) at no cost.
pub(crate) async fn settle(
    State(state): State<SharedState>,
    Path(tunnel_id): Path<String>,
    Json(req): Json<SettleRequest>,
) -> Response {
    tracing::info!(
        %tunnel_id,
        final_nonce = %req.settlement.final_nonce,
        balance_a = %req.settlement.party_a_balance,
        balance_b = %req.settlement.party_b_balance,
        transcript_len = req.transcript.len(),
        "settle requested"
    );

    // The signed settlement commits to its own tunnelId; a path/body mismatch is a client bug
    // or a misroute, never a thing to sponsor gas for.
    if req.settlement.tunnel_id != tunnel_id {
        return ApiError::resp(
            StatusCode::UNPROCESSABLE_ENTITY,
            "tunnel_mismatch",
            "settlement tunnelId does not match the path",
        )
        .into_response();
    }

    // 409 if the event-derived registry already shows this tunnel closed (free reject, no RPC).
    if state.control.get_tunnel_status(&tunnel_id).await == Some(crate::state::TunnelStatus::Closed)
    {
        return ApiError::resp(
            StatusCode::CONFLICT,
            "already_settled",
            "tunnel already closed on-chain",
        )
        .into_response();
    }

    let a = match parse_u64(&req.settlement.party_a_balance, "partyABalance") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let b = match parse_u64(&req.settlement.party_b_balance, "partyBBalance") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let ts = match parse_u64(&req.settlement.timestamp, "timestamp") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let transcript_root = match decode_hex(&req.settlement.transcript_root, "transcriptRoot") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let sig_a = match decode_hex(&req.sig_a, "sigA") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let sig_b = match decode_hex(&req.sig_b, "sigB") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };

    let close = crate::sui::CloseArgs {
        tunnel_id: tunnel_id.clone(),
        party_a_balance: a,
        party_b_balance: b,
        sig_a,
        sig_b,
        timestamp: ts,
        transcript_root,
    };
    match state.settler.submit_close(close).await {
        Ok(digest) => {
            let blob = serde_json::to_vec(&req.transcript).unwrap_or_default();
            let (blob_id, proof_url) = match state.walrus.upload_transcript(blob).await {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!(%digest, error = %e, "walrus archival failed");
                    (String::new(), String::new())
                }
            };
            state
                .control
                .push_recent_event(settled_event(
                    &tunnel_id,
                    a,
                    b,
                    &req.settlement.transcript_root,
                    &digest,
                    ts,
                    &proof_url,
                ))
                .await;
            Json(serde_json::json!({ "txDigest": digest, "walrusBlobId": blob_id, "proofUrl": proof_url }))
                .into_response()
        }
        Err(e) => ApiError::resp(
            StatusCode::UNPROCESSABLE_ENTITY,
            "settle_failed",
            &e.to_string(),
        )
        .into_response(),
    }
}
```

This removes the `get_session` lookup, the tunnel-membership check, and the `bearer_matches` gate; adds the `tunnel_mismatch` check; keeps the `409`, parsing, submit, archive, and feed-row push. `bearer_matches` and `HeaderMap` remain in the file (still used by `heartbeat`).

- [ ] **Step 4: Update the route**

In `backend/tunnel-manager/src/main.rs`, replace line 95:

```rust
        .route("/v1/sessions/:id/settle", post(routes::settle))
```

with:

```rust
        .route("/v1/tunnels/:tunnel_id/settle", post(routes::settle))
```

- [ ] **Step 5: Run the tests + the whole crate**

Run: `cd backend/tunnel-manager && cargo test -p tunnel-manager > /tmp/ct.log 2>&1; tail -25 /tmp/ct.log`
Expected: all tests pass, including `settle_rejects_path_tunnel_mismatch` and `settle_conflicts_when_already_closed`. The existing `settle_request_matches_sdk_camelcase_json`, `bearer_matches_only_exact_token`, etc. still pass (the `SettleRequest`/`Settlement` structs and `bearer_matches` are unchanged).

- [ ] **Step 6: Commit**

```bash
git add backend/tunnel-manager/src/main.rs backend/tunnel-manager/src/routes.rs
git commit -m "feat(be): settle by tunnel, drop session token"
```

---

### Task 2: `controlPlane.settle(tunnelId, body)` client change

**Files:**
- Modify: `frontend/src/backend/controlPlane.ts`
- Test: `frontend/src/backend/controlPlane.test.ts`

- [ ] **Step 1: Update the failing test**

In `frontend/src/backend/controlPlane.test.ts`, replace the existing `settle posts ...` test with the tunnel-resource, no-auth version (keep the `StatsSnapshot` test and the imports `createControlPlaneClient` + `type SettleRequestBody`):

```ts
// ADR-0007: settle posts to the TUNNEL resource with NO Authorization — the co-signed settlement
// is the authorization, not a bearer token. This pins the path + the absence of the header so a
// regression can't silently re-introduce the session gate.
test("settle posts to the tunnel settle path with no auth and returns the proof", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ txDigest: "DiG", walrusBlobId: "blob1", proofUrl: "https://agg/v1/blobs/blob1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const cp = createControlPlaneClient("https://backend.example");
    const body: SettleRequestBody = {
      settlement: {
        tunnelId: "0x1",
        partyABalance: "1500",
        partyBBalance: "500",
        finalNonce: "1",
        timestamp: "1750000000000",
        transcriptRoot: "deadbeef",
      },
      sigA: "aa",
      sigB: "bb",
      transcript: [],
    };
    const res = await cp.settle("0x1", body);
    assert.equal(res.txDigest, "DiG");
    assert.equal(res.walrusBlobId, "blob1");
    assert.equal(res.proofUrl, "https://agg/v1/blobs/blob1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://backend.example/v1/tunnels/0x1/settle");
    assert.equal(String(calls[0].init.method).toUpperCase(), "POST");
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), body);
  } finally {
    globalThis.fetch = orig;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node --import tsx --test src/backend/controlPlane.test.ts`
Expected: FAIL — `cp.settle("0x1", body)` is a 3-arg method today (`settle(sessionId, statsToken, body)`), so the call shape and asserted URL/header don't match.

- [ ] **Step 3: Update the interface + implementation**

In `frontend/src/backend/controlPlane.ts`, replace the `settle` method on the `ControlPlaneClient` interface:

```ts
  /** Route a cooperative close through the backend: the settler dry-runs + submits
   *  close_cooperative_with_root (anchoring the transcript root), archives the transcript to
   *  Walrus, and returns the proof links. Authorization is the co-signed settlement in `body`
   *  (ADR-0007) — no session token. */
  settle(tunnelId: string, body: SettleRequestBody): Promise<SettleResult>;
```

and replace the `settle` implementation in `createControlPlaneClient`:

```ts
    async settle(tunnelId, body) {
      const res = await fetch(`${root}/v1/tunnels/${tunnelId}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await failIfNotOk(res, "settle");
      return (await res.json()) as SettleResult;
    },
```

(The `SettleRequestBody`/`SettleSettlement`/`SettleTranscriptEntry`/`SettleResult` types are unchanged.)

- [ ] **Step 4: Run the test + typecheck**

Run: `cd frontend && node --import tsx --test src/backend/controlPlane.test.ts && pnpm typecheck`
Expected: test PASS; `tsc --noEmit` reports errors only in `usePvpTicTacToe.ts` (the stale 3-arg `cp.settle` call) — that is fixed in Task 3. If you want a clean typecheck at this commit, do Task 3 before committing; otherwise commit the client+test now and let Task 3 restore green. **Decision: commit now; Task 3 immediately follows.**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/backend/controlPlane.ts frontend/src/backend/controlPlane.test.ts
git commit -m "feat(fe): settle by tunnelId, drop session token"
```

---

### Task 3: PvP lane drops `registerSession`

**Files:**
- Modify: `frontend/src/games/ticTacToe/usePvpTicTacToe.ts`

**Read the file first** (it carries pre-existing telemetry + the Task-8/9 settle wiring from a prior plan). Use the canonical-case path for git.

- [ ] **Step 1: Drop the `RegisterSessionResult` import**

Replace the control-plane import block:

```ts
import {
  getControlPlaneClient,
  resolveBackendUrl,
  type RegisterSessionResult,
} from "../../backend/controlPlane";
```

with:

```ts
import { getControlPlaneClient, resolveBackendUrl } from "../../backend/controlPlane";
```

- [ ] **Step 2: Remove the `sessionRef`**

Delete this line (next to `transcriptRef`):

```ts
  const sessionRef = useRef<RegisterSessionResult | null>(null);
```

- [ ] **Step 3: Remove the `sessionRef` reset**

In `reset`, delete the line:

```ts
    sessionRef.current = null;
```

(Keep `transcriptRef.current = null;`.)

- [ ] **Step 4: Remove the `registerSession` block**

Delete the entire seat-A registration block (the comment `// Register the funded tunnel under a control-plane session ...` through the closing `}` of the `if (match.role === "A") { getControlPlaneClient().registerSession(...) }`). Stats/throughput is counted server-side at the relay (ADR-0007), so PvP needs no session.

- [ ] **Step 5: Narrow the `settle(...)` call site**

In `dt.onConfirmed`, replace the `void settle(...)` call's argument list:

```ts
            void settle(
              dt,
              match.role,
              channel,
              waitPeer,
              reads,
              signExec,
              tunnelId,
              transcript,
              sessionRef.current,
              getControlPlaneClient(),
            ).then(
```

with (drop the `sessionRef.current` argument):

```ts
            void settle(
              dt,
              match.role,
              channel,
              waitPeer,
              reads,
              signExec,
              tunnelId,
              transcript,
              getControlPlaneClient(),
            ).then(
```

- [ ] **Step 6: Update the `settle` helper signature + body**

Replace the bottom-of-file `settle` helper (from its doc comment through its closing brace) with:

```ts
/** Exchange root-anchored settlement halves over the relay, then seat A submits the close via the
 *  backend /settle (the settler dry-runs + anchors the transcript root + archives to Walrus).
 *  Authorization is the co-signed settlement itself (ADR-0007) — no session token. Both seats must
 *  anchor the SAME root or close_cooperative_with_root rebuilds different bytes and on-chain verify
 *  fails — so the root is exchanged and asserted equal before either side trusts the combine.
 *  Fallback: wallet-submitted close_cooperative_with_root (backend down). */
async function settle(
  dt: DistributedTunnel<TicTacToeState, { cell: number }>,
  role: Role,
  channel: PvpChannel,
  waitPeer: <T>(t: string) => Promise<T>,
  reads: Parameters<typeof readCreatedAt>[0],
  signExec: Parameters<typeof closeCooperativeWithRoot>[0]["signExec"],
  tunnelId: string,
  transcript: Transcript,
  cp: ReturnType<typeof getControlPlaneClient>,
): Promise<void> {
  const createdAt = await readCreatedAt(reads, tunnelId);
  const root = transcript.root();
  const half = dt.buildSettlementHalfWithRoot(createdAt, root, 0n);
  channel.sendPeer({
    t: "settleHalf",
    partyABalance: half.settlement.partyABalance.toString(),
    partyBBalance: half.settlement.partyBBalance.toString(),
    finalNonce: half.settlement.finalNonce.toString(),
    timestamp: half.settlement.timestamp.toString(),
    transcriptRoot: toHex(root),
    sig: toHex(half.sigSelf),
  });
  const other = await waitPeer<{ sig: string; transcriptRoot: string }>("settleHalf");
  if (other.transcriptRoot !== toHex(root)) {
    throw new Error("settlement transcript-root mismatch between parties");
  }
  const co = dt.combineSettlementWithRoot(half.settlement, half.sigSelf, fromHex(other.sig));
  if (role !== "A") return; // single submitter, mirrors the cooperative-close pattern
  try {
    await cp.settle(tunnelId, coSignedToSettleRequest(co, transcript.toRecord().entries));
  } catch (e) {
    console.error("[tictactoe] backend settle failed; falling back to wallet close:", e);
    await closeCooperativeWithRoot({ signExec, tunnelId, settlement: co });
  }
}
```

- [ ] **Step 7: Typecheck + build**

Run: `cd frontend && pnpm typecheck && pnpm build`
Expected: `tsc --noEmit` clean (no stale `sessionRef`/`RegisterSessionResult`/3-arg `settle`), `vite build` succeeds. (The pre-existing chunk-size warning is unrelated.)

- [ ] **Step 8: Commit** (use the canonical-case path)

```bash
git add "frontend/src/games/ticTacToe/usePvpTicTacToe.ts"
git commit -m "feat(pvp): drop registerSession from settle"
```

---

## Phase B — Verify-before-gas (dry-run)

### Task 4: `dryrun_effects_ok` pure parser

**Files:**
- Modify: `backend/tunnel-manager/src/sui.rs` (the helper + its tests)

- [ ] **Step 1: Write the failing tests**

In `backend/tunnel-manager/src/sui.rs`, add to the `#[cfg(test)] mod tests` block (it already has `use super::*;`):

```rust
    // A dry-run that succeeds means the close WILL land — proceed to execute.
    #[test]
    fn dryrun_ok_on_success_effects() {
        let r = serde_json::json!({ "effects": { "status": { "status": "success" } } });
        assert!(dryrun_effects_ok(&r).is_ok());
    }

    // A dry-run failure (e.g. a bad seat signature the Move rejects) must error so the settler
    // refuses to sponsor gas — the error carries the on-chain status for the client log.
    #[test]
    fn dryrun_err_on_failure_effects() {
        let r = serde_json::json!({
            "effects": { "status": { "status": "failure", "error": "InvalidSignature" } }
        });
        let e = dryrun_effects_ok(&r).unwrap_err();
        assert!(e.contains("failure") || e.contains("InvalidSignature"), "got: {e}");
    }

    // A malformed result with no effects is treated as a failure, never a silent pass.
    #[test]
    fn dryrun_err_when_effects_missing() {
        let r = serde_json::json!({ "nope": true });
        assert!(dryrun_effects_ok(&r).is_err());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend/tunnel-manager && cargo test -p tunnel-manager dryrun > /tmp/ct.log 2>&1; sed -n '1,40p' /tmp/ct.log`
Expected: compile error — `dryrun_effects_ok` is not defined.

- [ ] **Step 3: Add the pure helper**

In `backend/tunnel-manager/src/sui.rs`, add this free function (next to `parse_event_row`, above `impl SuiSettler`):

```rust
/// Read a `sui_dryRunTransactionBlock` result: `Ok` iff `effects.status.status == "success"`,
/// else `Err(<status json>)`. Mirrors the `execute()` status check; lets the settler reject a
/// settlement that will not land BEFORE sponsoring gas (ADR-0007). Unit-tested against sample JSON.
fn dryrun_effects_ok(resp: &serde_json::Value) -> Result<(), String> {
    match resp
        .pointer("/effects/status/status")
        .and_then(|v| v.as_str())
    {
        Some("success") => Ok(()),
        _ => Err(resp
            .pointer("/effects/status")
            .map(|v| v.to_string())
            .unwrap_or_else(|| "dry-run result missing effects.status".to_string())),
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend/tunnel-manager && cargo test -p tunnel-manager dryrun > /tmp/ct.log 2>&1; tail -15 /tmp/ct.log`
Expected: 3 dryrun tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/tunnel-manager/src/sui.rs
git commit -m "feat(be): add dry-run effects parser"
```

---

### Task 5: Dry-run the close before sponsoring gas

**Files:**
- Modify: `backend/tunnel-manager/src/sui.rs` (`dry_run` method + wire into `submit_close`)

No new unit test — the parse logic is covered by Task 4; this wires the (e2e-deferred) RPC call. Build-verified.

- [ ] **Step 1: Add the `dry_run` method**

In `backend/tunnel-manager/src/sui.rs`, inside `impl SuiSettler`, add immediately after `submit_close` (before the `// ---- JSON-RPC reads/execute` comment):

```rust
    /// Dry-run the built close tx so the real `close_cooperative_with_root` runs (re-verifying
    /// both seat sigs against the on-chain pubkeys and the balance sum) WITHOUT executing — an
    /// invalid settlement is rejected here, before any gas is sponsored (ADR-0007). The seat sigs
    /// are PTB `vector<u8>` arguments, so an unsigned tx is sufficient to exercise them.
    /// e2e-deferred (needs a live node); the status parse is unit-tested (`dryrun_effects_ok`).
    async fn dry_run(&self, tx: &Transaction) -> anyhow::Result<()> {
        let tx_b64 = base64::engine::general_purpose::STANDARD
            .encode(bcs::to_bytes(tx).context("bcs tx")?);
        let r = self
            .rpc("sui_dryRunTransactionBlock", serde_json::json!([tx_b64]))
            .await?;
        dryrun_effects_ok(&r).map_err(|e| anyhow!("close dry-run failed: {e}"))
    }
```

- [ ] **Step 2: Call `dry_run` in `submit_close` before signing**

In `submit_close`, after the `let tx = build_close_tx(...)?;` block and before `let sig = self.signer.sign_transaction(&tx)`, insert:

```rust
        // Verify-before-gas: reject a settlement that won't land before sponsoring it (ADR-0007).
        self.dry_run(&tx).await?;
```

So the body reads: resolve shared → gas price → `build_close_tx` → `dry_run` → sign → `execute`.

- [ ] **Step 3: Build + full crate test**

Run: `cd backend/tunnel-manager && cargo test -p tunnel-manager > /tmp/ct.log 2>&1; tail -25 /tmp/ct.log`
Expected: compiles; all tests pass (the dryrun parse tests + the Task 1 guard tests + the existing `build_close_tx_*` / event / key tests). The live dry-run call is e2e-deferred.

- [ ] **Step 4: Commit**

```bash
git add backend/tunnel-manager/src/sui.rs
git commit -m "feat(be): dry-run close before sponsoring gas"
```

---

## Success criteria

Unit-tested (must pass):
- `/settle` handler: `422` on path/body tunnel mismatch; `409` when the registry shows the tunnel closed — **no auth path remains** (Task 1, cargo).
- `dryrun_effects_ok`: `Ok` on `success` effects, `Err` on `failure`/missing (Task 4, cargo).
- Client `settle(tunnelId, body)` POSTs to `/v1/tunnels/{id}/settle`, **no `authorization` header**, body round-trips, parses the proof (Task 2, tsx).

Build-verified (must compile/bundle):
- Backend compiles with the de-authed handler + dry-run wired into `submit_close` (`cargo test`).
- PvP lane compiles + bundles with `registerSession` removed and `settle(tunnelId, …)` (`pnpm typecheck` + `pnpm build`, Task 3).

**e2e-deferred (NOT a success criterion here):** an actual dry-run + on-chain `close_cooperative_with_root` + Walrus archive on a live node with the published package + funded settler.

## Out of scope (follow-up)

- Authenticating `register_session` (wallet-signature challenge) — stats token is low-stakes.
- Reverse `tunnel_id → game` attribution on the settled feed row (still `None` for game).
- Dispute / timeout / non-cooperative close paths.

---

## Self-review notes

- **Spec coverage:** route→tunnel + de-auth (Task 1), client (Task 2), PvP drop registerSession (Task 3), dry-run parse (Task 4) + wiring (Task 5) — all spec sections mapped.
- **Type/contract consistency:** `settle(tunnelId, body)` shape identical across controlPlane interface/impl (Task 2), the PvP call (Task 3), and the test (Task 2). Backend `settle(State, Path<String>, Json<SettleRequest>)` matches the two guard tests' call shape (Task 1). `dryrun_effects_ok(&Value) -> Result<(), String>` defined in Task 4, used in Task 5.
- **Honest deferral:** the happy-path 200 and the live dry-run are e2e-deferred (no settler mock added — matches the codebase); guards + parser are the real unit tests.
- **Ordering:** Task 2 intentionally leaves `usePvpTicTacToe.ts` red until Task 3 (stated in Task 2 Step 4); every other commit is green.
