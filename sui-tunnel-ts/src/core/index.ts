/**
 * Core off-chain primitives for the Sui Tunnel Framework.
 *
 * These modules are the foundation of the off-chain state-transition hot path
 * that determines effective TPS:
 *  - `bytes`      — allocation-aware byte utilities
 *  - `wire`       — canonical signed-message serialization (byte-exact vs Move)
 *  - `crypto`     — synchronous ed25519 sign/verify + bulk key generation
 *  - `commitment` — two-party commit-reveal (byte-exact vs randomness.move)
 *
 * Everything here is dependency-light (no Sui RPC client) so it can run in tight
 * loops and worker threads. Cross-checked against Move by
 * `sui_tunnel/tests/wire_format_tests.move`.
 */
export * from "./bytes";
export * from "./wire";
export * from "./crypto";
export * from "./crypto-native";
export * from "./commitment";
export * from "./randomness";
export * from "./tunnel";
export * from "./distributedTunnel";
export * from "./keys";
