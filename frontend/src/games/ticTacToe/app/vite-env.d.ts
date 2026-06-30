/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_BLS_PUBLIC_KEY: string;
  readonly VITE_SUI_NETWORK: string;
  readonly VITE_SUI_NETWORK_NAME: "mainnet" | "testnet" | "devnet";
  readonly VITE_ENOKI_API_KEY: string;
  readonly VITE_GOOGLE_CLIENT_ID: string;
  readonly VITE_TTT_PACKAGE_ID: string;
  readonly VITE_TTT_REGISTRY_ID: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
