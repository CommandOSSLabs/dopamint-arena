# 0014 — Enoki sponsored transactions with settler-wallet fallback

- **Status**: Accepted
- **Date**: 2026-06-25

## Context

Gas sponsorship for open/fund (and bot-close, faucet, example-app) txs has been
served only by our own **settler wallet** (ADR-0009): the backend wraps the
client-built tx KIND in SIP-58 address-balance gas owned by the settler, dry-runs
it (verify-before-gas), and returns `(txBytes, sponsorSignature)`; the **frontend**
then submits the bytes with both signatures. This couples liveness to a settler
account that must hold SUI and to our own RPC, and makes us operate the gas tank.

We want a managed gas source — **Enoki** (Mysten's sponsorship service) — as the
primary, keeping the settler as a fallback so an Enoki outage or misconfig never
blocks play. Enoki's model differs fundamentally: it holds its own gas key and
**executes the tx itself**, so it never returns a detached sponsor signature.
Its flow is two calls — create (`POST /v1/transaction-blocks/sponsor` →
`{bytes, digest}`) then, after the user signs `bytes`, execute
(`POST /v1/transaction-blocks/sponsor/{digest}` with `{signature}`). This can't be
folded into the settler's "return a sponsor sig, client executes" shape. Two
reasonable people could wire this either by making the backend stateful (store the
settler sig per-digest and execute both providers backend-side) or by tagging the
response with a `provider` and letting the thin frontend branch.

## Decision

We try **Enoki first; on any Enoki sponsor error, fall back to the settler** (the
order is the operator's choice). The backend validates the tx KIND against the
**existing** allowlist (`validate_sponsorable_inner`) *first* — so neither provider
is ever asked to sponsor abuse — and passes the KIND's move-call targets to Enoki
as `allowedMoveCallTargets`. The `/v1/sponsor` response gains a `provider` field
(`"enoki" | "settler"`); the frontend branches in one place (`runSponsoredFlow`):
settler → submit both sigs client-side (unchanged); enoki → `POST /v1/sponsor/execute`
(a new backend route that calls Enoki's execute). The **settler path stays
byte-for-byte unchanged** and the backend stays **stateless** — no digest→sig map.
Enoki's private key (`enoki_private_…`) lives server-side only, distinct from the
frontend's public `VITE_ENOKI_API_KEY` (zkLogin wallet). A new `SUI_NETWORK` env
(default `testnet`) feeds Enoki's `network`.

## Consequences

- **Easier**: the settler tank is now a backstop, not the hot path; a 0-SUI player
  is sponsored by Enoki when its portal allowlist covers our packages.
- **Stateless & low-risk**: the frontend carries Enoki's `digest` between the two
  calls; no backend state, no Redis map (the prod backend is multi-instance HA,
  ADR-0005, so a per-digest map would have had to live in Redis). The working
  settler flow is untouched — the only forced edits to existing files are an
  `enoki: None` field on test-state constructors and the response gaining fields.
- **Harder / committed to**: an **execute-step** Enoki failure can NOT fall back to
  the settler — the signed bytes commit to Enoki's gas owner. We surface it; the
  frontend's outer `withSponsorFallback` (sender-pays a *fresh* tx) remains the last
  resort (no double-spend). Enoki is on the critical path (tried first), so its
  client carries a hard request timeout to fail fast into the fallback.
- **Operational prerequisite**: the Enoki app must allowlist our tunnel/coin/example
  packages on the configured network in the Enoki portal; otherwise every sponsor
  4xxs and falls back to the settler (graceful, but Enoki effectively off).
- **Chosen *not* to**: set `allowedAddresses` (open arena: any connected
  wallet/keypair is a valid sender; `allowedMoveCallTargets` + validate-first bound
  abuse); add a second dry-run on the Enoki path (Enoki dry-runs internally; the
  settler keeps its own). **Constraint**: the settler fallback's `ValidDuring` chain
  digest is a hard-coded testnet constant, so startup asserts `SUI_NETWORK=testnet`
  until that digest is config-driven — no mainnet-Enoki / testnet-settler split-brain.
