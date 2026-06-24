// Barrel re-export of the DOPAMINT stake helpers. The World Canvas engine imports these from
// here instead of directly from "./dopamint": its direct import hit a CI-only Linux
// module-resolution quirk on that one file from the games/worldCanvas subtree (other onchain
// modules like tunnelTx resolve fine from there). The sibling "./dopamint" resolves cleanly
// from within onchain/, so going through this barrel sidesteps it.
export {
  isDopamintConfigured,
  ensureDopamintStakeCoin,
  DOPAMINT_COIN_TYPE,
} from "./dopamint";
