/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUI_NETWORK: string;
  readonly VITE_SUI_NETWORK_NAME: "mainnet" | "testnet" | "devnet";
  readonly VITE_USE_TOP_NAVBAR_IN_LARGE_SCREEN: string;
  readonly VITE_ENOKI_API_KEY: string;
  readonly VITE_GOOGLE_CLIENT_ID: string;
  readonly VITE_BLACK_JACK_PACKAGE_ID: string;
  readonly VITE_BLACK_JACK_GAME_MANAGER_ID: string;
  readonly VITE_BLACK_JACK_TEST_BUCK_MANAGER_ID: string;
  readonly VITE_COIN_TYPE: string;
  readonly VITE_COIN_SYMBOL: string;
  readonly VITE_BLS_PUBLIC_KEY: string;
  readonly VITE_API_URL: string;
  readonly VITE_TUNNEL_PACKAGE_ID: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
