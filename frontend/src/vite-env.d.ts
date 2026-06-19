/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_QUANTUM_POKER_SERVER_URL?: string;
  readonly VITE_TUNNEL_PACKAGE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
