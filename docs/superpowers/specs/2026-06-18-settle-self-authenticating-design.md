# Settle self-authenticating — design

**ADR:** [0007](../../decisions/0007-settle-authorized-by-settlement-not-token.md).
**Status:** design ready for planning.

## Goal

Make `/settle` best-practice: authorize a cooperative close by the **co-signed
settlement itself** (the chain's own rule), not by a mintable session bearer
token. Concretely:

1. Move `/settle` off the session and onto the tunnel resource; drop the
   `stats_token` gate and the PvP `registerSession` round-trip.
2. As a gas sponsor, **confirm the close will land before paying for it**
   (fail-fast) via a dry-run of the close PTB — so a malformed/forged/replayed
   settlement never burns a failed-tx's gas.

Non-goals: authenticating `register_session` (stats path, low-stakes, unchanged);
dispute/non-cooperative settlement; any change to the on-chain contract or the
signed wire format.

## Read/write model (why this shape)

- **Writer of a settlement:** the two seats, once, at tunnel close. Rate =
  tunnel-count × settle-frequency = **once per tunnel lifetime** (ADR-0005
  settle-at-close cadence) — _not_ TPS. The per-move hot path never touches
  `/settle`.
- **Reader:** the settler (submits) + one bounded feed-row push. No aggregation,
  no unbounded growth on this path.
- **Authority:** the co-signed `SettlementWithRoot` is an unforgeable capability
  (only the seats can produce it) and is **enforced on-chain** at
  `close_cooperative_with_root`. So the right authorization is "present a valid
  co-signed settlement," and the right gas-safety is "don't sponsor a tx that
  won't land." A bearer token adds neither.
- **Consequence:** because the op is once-per-tunnel, an extra dry-run RPC is
  negligible; we optimize for correctness + safety, not request throughput.

## Current state (what changes)

Backend (`backend/tunnel-manager/`):

- Route `POST /v1/sessions/:id/settle` → `routes::settle` (main.rs:95).
- `settle` (routes.rs:182) gates on `control.get_session` + `bearer_matches`
  (stats_token) + tunnel-membership, then `409` if already closed, then
  `settler.submit_close` → archive → push proof row → `{txDigest, walrusBlobId,
proofUrl}`.
- `SuiSettler::submit_close` (sui.rs:141): resolve shared ref → `build_close_tx`
  → sign → `execute`. **No pre-submit verification** — a bad settlement reaches
  the chain and wastes gas.

Frontend:

- `controlPlane.settle(sessionId, statsToken, body)` → POSTs to
  `/v1/sessions/${sessionId}/settle` with `Authorization: Bearer`.
- `usePvpTicTacToe.ts` calls `registerSession` (seat A) purely to obtain the
  token, then `cp.settle(sessionId, statsToken, …)`, with a wallet
  `closeCooperativeWithRoot` fallback.
- **Sole caller** of `cp.settle` is the PvP lane (+ the unit test); blackjack was
  descoped from `/settle`. Clean break is safe.

## Target design

### Backend — route + handler

- **Route:** replace `/v1/sessions/:id/settle` with
  **`POST /v1/tunnels/:tunnel_id/settle`** (main.rs). `register_session` +
  `heartbeat` routes stay.
- **Handler `settle(Path(tunnel_id), Json(req))`** — no `HeaderMap`, no session:
  1. `req.settlement.tunnel_id` must equal the path `tunnel_id` → else `422`
     (`tunnel_mismatch`).
  2. `409 already_settled` if `control.get_tunnel_status(tunnel_id) == Closed`
     (unchanged guard; a free reject before any RPC).
  3. Parse balances/timestamp/root/sigs (unchanged `parse_u64`/`decode_hex`).
  4. `settler.submit_close(CloseArgs)` — now dry-runs first (below).
  5. On `Ok(digest)`: archive transcript to Walrus + `push_recent_event` the
     proof row + return `{txDigest, walrusBlobId, proofUrl}` (unchanged).
  6. On `Err`: `422 settle_failed` (covers dry-run rejection + execution
     failure). The error message distinguishes the cause for the client log.
- `SettleRequest`/`Settlement`/`settled_event` structs unchanged. `bearer_matches`
  stays (heartbeat still uses it). Remove only the session/bearer lines from
  `settle`.

### Backend — verify-before-gas (dry-run)

In `SuiSettler::submit_close`, between `build_close_tx` and `execute`:

- `dry_run(&tx)` calls `sui_dryRunTransactionBlock` with the **same** base64 BCS
  tx bytes `execute` uses (an unsigned tx is fine — the seat sigs are PTB
  `vector<u8>` _arguments_, so the dry-run still runs the real Move
  `close_cooperative_with_root`, which re-verifies `sig_a`/`sig_b` against the
  on-chain `party_a`/`party_b` pubkeys and the balance sum).
- A **pure** `fn dryrun_effects_ok(resp: &serde_json::Value) -> Result<(), String>`
  reads `/effects/status/status`; `"success"` → `Ok`, otherwise `Err(<the status
json>)`. This mirrors the existing `execute()` status check and is unit-tested
  against sample JSON exactly like `parse_event_row`.
- If the dry-run says failure → `submit_close` returns `Err` (→ handler `422`),
  **no `execute`, no gas**. Only a passing dry-run proceeds to sign + execute.
- This is **scheme-agnostic** (the Move verifies whatever scheme each
  `PartyConfig.signature_type` declares) and **correct by construction** (the
  Move recomputes `final_nonce = state.nonce + 1`; a local byte re-verify against
  the client's `finalNonce` would not).
- **e2e-deferred:** the live dry-run call needs a node (same deferral as the rest
  of the settler). The status-extraction logic is unit-tested now.

### Frontend — client + PvP lane

- `controlPlane.settle(tunnelId, body)` — drop `sessionId`/`statsToken`; POST to
  `/v1/tunnels/${tunnelId}/settle` with `content-type` only, no `Authorization`.
  Interface + impl updated; `SettleRequestBody`/`SettleResult` unchanged. Update
  `controlPlane.test.ts` to assert the new path and the **absence** of an
  `authorization` header.
- `usePvpTicTacToe.ts`:
  - Remove `registerSession` call, `sessionRef`, and the `RegisterSessionResult`
    import. Keep `transcriptRef` (root + Walrus entries) and `getControlPlaneClient`.
  - `settle(...)` helper: drop the `session` param; always try
    `cp.settle(tunnelId, coSignedToSettleRequest(co, transcript.toRecord().entries))`,
    and on failure fall back to the wallet `closeCooperativeWithRoot` (unchanged
    fallback intent). Root-agreement assert over the relay stays.
- `coSignedToSettleRequest` serializer unchanged.

## Test strategy

- **Backend handler (cargo, now):** `settle` returns the proof JSON shape on a
  stubbed-OK settler; `409` when the registry shows Closed; `422` on
  tunnel/path mismatch; **no auth path remains**. (Existing
  `settle_request_matches_sdk_camelcase_json` stays valid.)
- **Dry-run status parse (cargo, now):** `dryrun_effects_ok` → `Ok` on a
  `success` effects JSON, `Err` on a `failure` JSON (sample `serde_json` values,
  like the existing event-parse tests).
- **Frontend client (tsx, now):** `settle` POSTs to `/v1/tunnels/{id}/settle`,
  method POST, `content-type: application/json`, **no `authorization` header**,
  body round-trips, parses `{txDigest, walrusBlobId, proofUrl}`.
- **Build-verified:** PvP lane compiles + bundles without `registerSession`.
- **e2e-deferred (NOT a success criterion):** an actual dry-run + on-chain close
  on a live node with the published package + funded settler.

## Phasing

- **Phase A — contract + client (certain, testable now).** Route → tunnel
  resource, handler de-auth, client `settle(tunnelId, body)`, PvP drops
  `registerSession`. This is the core best-practice win and is fully unit-tested.
- **Phase B — verify-before-gas (hardening, e2e-deferred wiring).** `dry_run` +
  `dryrun_effects_ok` in `submit_close`; status-parse unit-tested. Kept separate
  so the certain Phase-A win can't be blocked by the node-dependent wiring.

## Out of scope (follow-up)

- Authenticating `register_session` (wallet-signature challenge) — the stats
  token is low-stakes; revisit if heartbeat abuse appears.
- Reverse `tunnel_id → game` attribution on the settled feed row (still `None`
  for game; tracked by the indexer follow-up in `sui.rs`).
- Dispute / timeout / non-cooperative close paths.
