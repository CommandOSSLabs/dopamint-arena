/**
 * Pure limit math for the on-chain `--probe`: gas-budget sizing, PTB-failure
 * classification, net-gas accounting, and the analytically predicted PTB
 * ceilings. No chain imports — every export is deterministic and unit-tested in
 * `probe.test.ts`, so the suite stays green with no infra.
 */

/** Measured single-open cost on a localnet (MIST). Drives the gas-budget sizer. */
export const OPEN_GAS_MIST = 4_374_000;
/** Measured single-close cost (MIST). */
export const CLOSE_GAS_MIST = 3_809_000;
/** Headroom multiplier over the analytic open cost when auto-sizing a budget. */
export const GAS_BUDGET_SAFETY = 1.5;
/** Sui's per-transaction max gas budget: 50 SUI. A larger budget is rejected. */
export const MAX_TX_GAS_BUDGET_MIST = 50_000_000_000;
/** Sui's default tx gas budget when none is set — caps opens at ~22 (see below). */
export const DEFAULT_TX_BUDGET_MIST = 100_000_000;
/** Events emitted per `create_and_fund` (sui_tunnel/sources/tunnel.move:678-682). */
export const EVENTS_PER_OPEN = 4;
/** Per-PTB event budget; the binding limit for opens at N = 1024/4 = 256. */
export const EVENT_BUDGET = 1024;
/** Per-PTB command budget; one split + N creates ⇒ N ≤ 1023. */
export const COMMAND_BUDGET = 1024;
/** Real testnet net cost of one open/close (SUI), for the vs-testnet delta. */
export const OPEN_TESTNET_SUI = 0.004374;
export const CLOSE_TESTNET_SUI = 0.003809;
export const MIST_PER_SUI = 1_000_000_000;

/** Which PTB ceiling a failing open hit. `gas-budget` means "bump and retry". */
export type LimitBound =
  | "event-budget"
  | "tx-size"
  | "command/arg"
  | "gas-budget"
  | "unknown";

/**
 * Gas budget for an N-open PTB: `min(50 SUI, ceil(N · open · 1.5))`.
 *
 * REQUIRED on every probe tx — no `setGasBudget` exists in the reused builders,
 * and Sui's default 100M budget silently caps a batch open at ~22 tunnels
 * (`gasAtDefault100M_N`), which would otherwise look like a knee at the wrong N.
 */
export function gasBudgetFor(n: number): number {
  return Math.min(
    MAX_TX_GAS_BUDGET_MIST,
    Math.ceil(n * OPEN_GAS_MIST * GAS_BUDGET_SAFETY),
  );
}

/**
 * Map a failing-open error string to the PTB ceiling it hit. Order matters:
 * `gas-budget` is matched so the sweep can bump the budget and retry the same N
 * (a too-small budget is not a structural knee). Heuristic over Sui's error
 * strings, refined empirically — `tx-size` is the Sui `max_tx_size_bytes`
 * (128 KiB) ceiling, the other candidate near N=256.
 */
export function classify(msg: string): LimitBound {
  const m = msg.toLowerCase();
  // Command/arg overflow FIRST: Sui phrases the command-count limit as
  // "Size limit exceeded: maximum commands ... is 1024", which the generic size rule
  // below would otherwise catch (and the old bare `1024` rule wrongly mapped it to
  // event-budget). The close knee surfaces this at ~1024 commands.
  if (/command|argument/.test(m)) return "command/arg";
  if (/event/.test(m)) return "event-budget";
  if (/size|serialized|too large/.test(m)) return "tx-size";
  if (/gas budget|gasbudget|insufficient gas|insufficientgas/.test(m)) return "gas-budget";
  return "unknown";
}

/** Raw `effects.gasUsed` (RPC returns each field as a decimal string). */
export interface GasUsedRaw {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}

export interface NetGas {
  computation: number;
  storage: number;
  rebate: number;
  /** computation + storage − rebate, in MIST. */
  netMist: number;
  /** netMist / 1e9, in SUI. */
  netSui: number;
}

/** Net on-chain cost of a tx: computation + storage − rebate. */
export function netGas(g: GasUsedRaw): NetGas {
  const computation = Number(g.computationCost);
  const storage = Number(g.storageCost);
  const rebate = Number(g.storageRebate);
  const netMist = computation + storage - rebate;
  return { computation, storage, rebate, netMist, netSui: netMist / MIST_PER_SUI };
}

export interface PredictedCeilings {
  /** Opens bound by the 1024-event budget (4 events/open) — expected binding N. */
  eventBudgetN: number;
  /** Opens bound by the PTB command budget (1 split + N creates). */
  commandBudgetN: number;
  /** Opens bound by the 50-SUI max budget at the 1.5× safety factor. */
  gasCapN: number;
  /** Opens the default 100M budget allows — the trap `gasBudgetFor` avoids. */
  gasAtDefault100M_N: number;
}

/** Analytic per-PTB open ceilings (no chain calls); reported alongside the sweep. */
export function predictedCeilings(): PredictedCeilings {
  return {
    eventBudgetN: Math.floor(EVENT_BUDGET / EVENTS_PER_OPEN),
    commandBudgetN: COMMAND_BUDGET - 1,
    gasCapN: Math.floor(
      MAX_TX_GAS_BUDGET_MIST / (OPEN_GAS_MIST * GAS_BUDGET_SAFETY),
    ),
    gasAtDefault100M_N: Math.floor(DEFAULT_TX_BUDGET_MIST / OPEN_GAS_MIST),
  };
}
