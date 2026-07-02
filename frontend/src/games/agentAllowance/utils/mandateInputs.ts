/** Parse a whole-MTPS amount; rejects decimals (MTPS is 0-decimal per ADR-0023). */
export function parseWholeMtps(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

/** Lobby deploy gate — returns a user-facing error or null when inputs are valid. */
export function validateMandateInputs(
  capInput: string,
  rateInput: string,
): string | null {
  if (!capInput.trim()) return "Budget is required";

  const cap = parseWholeMtps(capInput);
  if (cap === null) {
    return "Budget must be a whole number of MTPS (no decimals)";
  }
  if (cap <= 0n) return "Budget must be greater than 0";

  if (!rateInput.trim()) return "Per-second rate is required";

  const rate = parseWholeMtps(rateInput);
  if (rate === null) {
    return "Per-second rate must be a whole number of MTPS (no decimals)";
  }
  if (rate <= 0n) return "Per-second rate must be at least 1";
  if (rate > cap) return "Per-second rate cannot exceed the budget";

  return null;
}
