// ESM resolve hook: force a SINGLE @mysten/sui — the e2e project's v2 copy —
// for EVERY importer, including the out-of-root sui-tunnel-ts/src files that
// ship their own pinned v1 in a sibling node_modules (which Node's walk-up
// would otherwise prefer). This mirrors what frontend's vite config does with
// `dedupe`. It also bridges the v1->v2 client move: `@mysten/sui/client` ->
// the rename shim.
//
// We redirect ONLY `@mysten/sui*`, never `@mysten/bcs`: bcs is a transitive
// dep of @mysten/sui (not a declared e2e dep, so it isn't resolvable from the
// e2e anchor), and the SDK never imports it directly — each @mysten/sui copy
// pulls its own matching bcs, so the redirected v2 @mysten/sui finds v2 bcs.
//
// Mechanism: for a @mysten specifier we re-run resolution with `parentURL`
// pinned to a file INSIDE e2e/, so Node resolves it from e2e/node_modules
// (v2) using the correct ESM `exports` conditions — rather than from the
// importing SDK file's directory (v1). `shortCircuit` is implied because we
// return the result of `nextResolve`.

const ANCHOR = import.meta.url; // e2e/loader/ -> walk-up hits e2e/node_modules (v2)
const SHIM_URL = new URL('../harness/sui-client-shim.ts', import.meta.url).href;
const LOG = process.env.V2_BRIDGE_LOG === '1';
const MYSTEN = /^@mysten\/sui(\/.*)?$/;

export async function resolve(specifier, context, nextResolve) {
  // The renamed-export bridge applies ONLY to sui-tunnel-ts source files,
  // which expect v1 `@mysten/sui/client` semantics (SuiClient/getFullnodeUrl).
  // v2-native consumers (e.g. @mysten/walrus, devstack) legitimately import
  // real v2 `/client` exports (e.g. ClientCache) and must NOT be shimmed.
  if (specifier === '@mysten/sui/client') {
    const fromSdk = (context.parentURL ?? '').includes('/sui-tunnel-ts/');
    if (fromSdk) {
      if (LOG) console.error(`[v2-bridge] ${specifier}  ->  shim  [from ${short(context.parentURL)}]`);
      return nextResolve(SHIM_URL, context);
    }
    // fall through to the generic redirect (real v2 /client from the e2e copy)
  }
  if (MYSTEN.test(specifier)) {
    const res = await nextResolve(specifier, { ...context, parentURL: ANCHOR });
    if (LOG) console.error(`[v2-bridge] ${specifier}  ->  ${short(res.url)}`);
    return res;
  }
  return nextResolve(specifier, context);
}

function short(u) {
  if (!u) return 'entry';
  const i = u.lastIndexOf('/node_modules/');
  return i === -1 ? u.replace(/^file:\/\//, '') : u.slice(i);
}
