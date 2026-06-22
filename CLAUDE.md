# CLAUDE.md

Engineering conventions for **dopamint-arena**. These apply to every task
unless explicitly overridden. Bias: caution over speed on non-trivial work.

## Repository layout & toolchain

This repo vendors the **Sui Tunnel Framework** (off-chain state channels
anchored on Sui) and builds Dopamint on top of it.

- `sui_tunnel/` — Move framework (Move 2024 edition): `tunnel`, `signature`,
  `randomness`, `referee`, `zk_verifier`, `hop`, plus example apps. Built and
  tested with `sui move build` / `sui move test`.
- `sui-tunnel-ts/` — TypeScript SDK (off-chain engine, bench, sim, telemetry).
  Uses **pnpm + prettier + `node:test`** (run via `tsx`).

**Upstream is authoritative for the framework.** `sui_tunnel/` and
`sui-tunnel-ts/` are upstream MystenLabs code. Keep them on their existing
toolchain (pnpm / prettier / `node:test`) and avoid gratuitous edits so the
framework can be re-synced from upstream later. Do **not** convert them to
bun/biome. The conventions below apply to all code; the *tooling* choices
match whatever package the file lives in.

**Adding a new arena game** (self-play or PvP over a tunnel): follow
[docs/adding-a-tunnel-game.md](docs/adding-a-tunnel-game.md) — the per-layer
checklist, wiring patterns, and gate.

## Git

- **Rebase over merge; squash on integration.** Keep history linear.
- **No AI attribution in commits.** Commits must read as human-authored.
- **Conventional Commits**: `<type>(<scope>): <subject>`. Types: `feat`, `fix`,
  `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `revert`. Use `!`
  or a `BREAKING CHANGE:` footer for breaking changes.
- **Short messages**: subject ≤ 50 chars, imperative, lowercase after the type,
  no trailing period. Skip the body unless a single line can't carry the
  meaning (then ≤ ~5 lines on *why*, not *what*). One logical change per commit.
  Push rationale, alternatives, and test plans into the PR description.

## Code Convention

Respect the language and framework you're in. Every language has its own
idioms, layout, error-handling style, and accepted best practices — follow
them. Don't import patterns from another ecosystem just because they're
familiar. When the official docs, standard library, or framework examples show
a way of doing something, that's the way — deviate only with a clear reason.

Codex will review your output once you are done
### Naming

Names (types, functions, variables, modules, files) must describe the target's
purpose and meaning — not just its category. A reader should infer what a thing
is and why it exists from the name alone.

- **Specific over generic**: pin down *which* thing. Replace category-only names
  (`Result`, `Data`, `Config`, `Item`) with names that say what kind.
- **Consistent prefixes within a subsystem** so cross-file references stay
  grep-able. Pick the prefix once and stick to it.
- **One concept per name**: if a name answers two questions ("what is this" vs.
  "where does it live"), split it.
- **A few extra tokens for clarity is the right trade**: avoid one/two-letter
  identifiers outside tight local scopes, and vague suffixes like `Handler`,
  `Manager`, `Helper`, `Util`, `Info`, `Data`.
- **Don't ramble**: the name carries the *meaning*; a doc comment carries the
  *mechanism*. Don't encode implementation details in the name.
- **Match the language's conventions** for casing, file naming, pluralization.
- **Renames are atomic**: update every call site, import, and doc reference in
  the same change.

### Doc comments

A name says *what*. A comment captures what the name can't: *why* it exists,
*how* it works when non-obvious, and the constraints a caller must respect. If a
comment only restates the name or signature, delete it.

- **Document the non-obvious**: rationale, invariants, gotchas, edge cases, the
  reason a surprising choice was made. Skip narration of what the code says.
- **Explain *why*, then *how*; never *what*.**
- **Document contracts at the boundary**: on exported APIs, state pre/post
  conditions, error modes, and side effects. Internal helpers usually don't.
- **Keep them short and load-bearing.** Prefer a tight 1–3 line block.
- **Delete stale comments aggressively** in the same change that invalidates
  them. A wrong comment is worse than none.

## Testing

Pick the lowest tier that can prove the behavior. Use the runner idiomatic to
the stack — `node:test` (via `tsx`) for the TS SDK, `sui move test` for Move.

- **Unit**: pure logic, no IO. Fast, deterministic. Co-locate `*.test.ts` next
  to the code.
- **Integration / cross-language**: exercise real boundaries — e.g. the
  byte-for-byte parity between the TS wire format and Move (golden tests). Never
  fake the boundary you're trying to verify.
- **End-to-end**: golden paths and high-value regressions only (e.g. the
  off-chain demo, the bench harness). Treat flakes as bugs — root-cause, don't
  retry-loop green.
- **Name tests by behavior, not implementation**: the name is the spec, the body
  is the proof. A test that can't fail when business logic changes is wrong.

## Architecture decisions

Non-trivial or contested decisions are recorded as short ADRs under
`docs/decisions/` *before* the code that depends on them. See
`docs/decisions/README.md` for the convention and template.
