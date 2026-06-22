/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_QUANTUM_POKER_SERVER_URL?: string;
  readonly VITE_TUNNEL_PACKAGE_ID?: string;
  // zkLogin (Enoki + Google) sign-in. Public client identifiers; both required to enable it.
  readonly VITE_ENOKI_API_KEY?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
