import { PROVIDERS } from "./constants";

export {
  CLAIM_SKEW_MS,
  EXPIRY_OPTIONS,
  GAME_ID,
  METER_INTERVAL_MS,
  objUrl,
  PROVIDERS,
  txUrl,
} from "./constants";
export { formatMtps, parseMtps, shortAddr, timeAgo } from "./formatMtps";
export { parseWholeMtps, validateMandateInputs } from "./mandateInputs";

export function providerNameFor(payee: string): string {
  return PROVIDERS.find((p) => p.address === payee)?.name ?? "Provider";
}
