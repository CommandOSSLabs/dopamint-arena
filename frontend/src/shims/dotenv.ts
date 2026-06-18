// Browser stub for `dotenv` — the SDK's config.ts calls `dotenv.config()` at import time,
// which reads the filesystem and has no meaning in a bundle. Env values are injected via
// vite `define` instead (see vite.config.ts). No-op here.
export default { config: () => ({ parsed: {} }) };
