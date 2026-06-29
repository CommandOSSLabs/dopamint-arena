// @mysten/sui v2 moved the JSON-RPC client to `@mysten/sui/jsonRpc` and renamed it
// (`SuiClient` -> `SuiJsonRpcClient`, `getFullnodeUrl` -> `getJsonRpcFullnodeUrl`). This shim
// re-exports the v1 names so loadbench's call sites stay unchanged after the v2 bump (same pattern
// as frontend/src/shims/sui-client.ts). The v2 client keeps the methods we use:
// signAndExecuteTransaction / executeTransactionBlock / call / getCoins / getCheckpoint /
// waitForTransaction / getBalance / getLatestSuiSystemState.
export {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
