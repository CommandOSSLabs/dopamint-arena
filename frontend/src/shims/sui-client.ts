// Shim cho sui-tunnel-ts: Thư viện này đang import SuiClient (v1) từ @mysten/sui/client
// Tuy nhiên ở @mysten/sui v2, các object này đã được dời sang @mysten/sui/jsonRpc và đổi tên.
// File shim này sẽ dịch ngược lại để sui-tunnel-ts hoạt động mượt mà với v2 mà không cần sửa code gốc.
export {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
