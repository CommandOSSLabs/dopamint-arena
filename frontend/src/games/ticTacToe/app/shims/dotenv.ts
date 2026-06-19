// Browser no-op shim for `dotenv`. The sui-tunnel-ts SDK's config.ts runs
// `dotenv.config()` at import time; in the browser that would call process.cwd()/
// fs.readFileSync and crash module init. Env comes from Vite's `define` instead.
const noop = () => ({ parsed: {} as Record<string, string> });
export const config = noop;
export default { config: noop };
