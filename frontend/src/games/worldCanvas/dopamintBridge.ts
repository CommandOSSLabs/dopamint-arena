// Thin re-export of the DOPAMINT stake helpers the on-chain engine needs. The engine's
// direct `@/onchain/dopamint` import resolved everywhere except CI's Linux build (it works
// for every other game from the same depth); routing through this sibling barrel sidesteps
// that one file-specific resolution quirk. See PR #44 CI investigation.
export {
  isDopamintConfigured,
  ensureDopamintStakeCoin,
  DOPAMINT_COIN_TYPE,
} from "@/onchain/dopamint";
