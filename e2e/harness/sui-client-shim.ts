// v2-mirror shim for sui-tunnel-ts (verbatim copy of frontend/src/shims/sui-client.ts).
// The SDK is pinned to @mysten/sui v1 and imports the JSON-RPC client from
// `@mysten/sui/client`. In v2 those moved to `@mysten/sui/jsonRpc` and were
// renamed. The loader bridge remaps `@mysten/sui/client` -> this file so the
// v1-shaped imports keep working against the v2 SDK with zero edits to the SDK.
export {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
