import { test, expect } from "bun:test";
import { readEnvLocal } from "./env";
import {
  gasBudgetFor,
  classify,
  netGas,
  predictedCeilings,
  MAX_TX_GAS_BUDGET_MIST,
  OPEN_GAS_MIST,
  GAS_BUDGET_SAFETY,
} from "./probeLimits";
import { parseProbeArgs } from "./probe";
import {
  renderProbeMarkdown,
  renderProbeSummary,
  probeBasename,
  type ProbeReport,
} from "./probeReport";

// Chain calls (if any are added later) MUST be gated like smoke.test.ts so the
// suite stays green with no infra. Everything below is pure — no chain, no IO.
const env = readEnvLocal();
const _gated = env.TUNNEL_PACKAGE_ID ? test : test.skip;
void _gated;

// ── probeLimits: gas budget ────────────────────────────────────────────────

test("gasBudgetFor scales N by the open cost and the 1.5x safety factor", () => {
  expect(gasBudgetFor(1)).toBe(Math.ceil(OPEN_GAS_MIST * GAS_BUDGET_SAFETY));
  expect(gasBudgetFor(256)).toBe(Math.ceil(256 * OPEN_GAS_MIST * GAS_BUDGET_SAFETY));
});

test("gasBudgetFor caps at the 50 SUI per-tx maximum", () => {
  expect(gasBudgetFor(1_000_000_000)).toBe(MAX_TX_GAS_BUDGET_MIST);
});

// ── probeLimits: classify ──────────────────────────────────────────────────

test("classify maps Sui errors to the PTB ceiling they hit", () => {
  expect(classify("number of events 1028 exceeds budget")).toBe("event-budget");
  expect(classify("emitted too many events")).toBe("event-budget");
  expect(classify("SizeLimitExceeded: serialized tx too large")).toBe("tx-size");
  expect(classify("too many commands in the programmable transaction")).toBe("command/arg");
  // Sui phrases the command-count limit with a "Size limit exceeded" prefix — must NOT
  // be read as tx-size or event-budget.
  expect(
    classify("Size limit exceeded: maximum commands in a programmable transaction is 1024"),
  ).toBe("command/arg");
  expect(classify("GasBudgetTooLow / InsufficientGas")).toBe("gas-budget");
  expect(classify("some unrelated abort")).toBe("unknown");
  expect(classify("Internal error")).toBe("unknown");
});

// ── probeLimits: netGas ────────────────────────────────────────────────────

test("netGas computes computation + storage - rebate in MIST and SUI", () => {
  const g = netGas({
    computationCost: "1000000",
    storageCost: "2976000",
    storageRebate: "978120",
  });
  expect(g.netMist).toBe(2_997_880);
  expect(g.netSui).toBeCloseTo(0.00299788, 9);
});

// ── probeLimits: predicted ceilings ────────────────────────────────────────

test("predictedCeilings reports the analytic per-PTB open limits", () => {
  expect(predictedCeilings()).toEqual({
    eventBudgetN: 256,
    commandBudgetN: 1023,
    gasCapN: 7620,
    gasAtDefault100M_N: 22,
  });
});

// ── arg parsing ────────────────────────────────────────────────────────────

test("parseProbeArgs defaults to the full A+B+C sweep", () => {
  const a = parseProbeArgs(["--probe"]);
  expect(a.phase).toBe("all");
  expect(a.batchSizes).toEqual([1, 8, 32, 64, 128, 256, 320]);
  expect(a.poolSizes).toEqual([1, 4, 8]);
  expect(a.stakeMist).toBe(1000n);
  expect(a.samples).toBe(5);
  expect(a.settlerKeyEnv).toBe("SUI_SETTLER_KEY");
  expect(a.coinType).toBe("0x2::sui::SUI");
});

test("parseProbeArgs reads overrides", () => {
  const a = parseProbeArgs([
    "--probe",
    "--phase",
    "open-knee",
    "--batch-sizes",
    "1,16,256",
    "--pool-sizes",
    "2,4",
    "--stake-mist",
    "500",
    "--samples",
    "3",
    "--settler-key-env",
    "MY_KEY",
  ]);
  expect(a.phase).toBe("open-knee");
  expect(a.batchSizes).toEqual([1, 16, 256]);
  expect(a.poolSizes).toEqual([2, 4]);
  expect(a.stakeMist).toBe(500n);
  expect(a.samples).toBe(3);
  expect(a.settlerKeyEnv).toBe("MY_KEY");
});

test("parseProbeArgs enables the open-loop pacer and defaults the ramp", () => {
  const a = parseProbeArgs(["--probe", "--target-rate", "200"]);
  expect(a.targetRate).toBe(200);
  expect(a.rateSteps).toBe(4);
});

test("parseProbeArgs rejects --rate-steps without --target-rate", () => {
  expect(() => parseProbeArgs(["--probe", "--rate-steps", "3"])).toThrow(
    /--rate-steps requires --target-rate/,
  );
});

test("parseProbeArgs rejects an invalid phase and unknown flags", () => {
  expect(() => parseProbeArgs(["--probe", "--phase", "nope"])).toThrow(/--phase must be/);
  expect(() => parseProbeArgs(["--probe", "--frobnicate"])).toThrow(/unknown probe flag/);
});

test("parseProbeArgs never accepts a settler key value on argv", () => {
  // Only the env-var NAME is a flag; there is no --settler-key value flag.
  expect(() => parseProbeArgs(["--probe", "--settler-key", "suiprivkey1"])).toThrow(
    /unknown probe flag/,
  );
});

// ── report shape / rendering ───────────────────────────────────────────────

function fullReport(): ProbeReport {
  return {
    meta: {
      env: "feat-x",
      rpcUrl: "http://127.0.0.1:9000",
      packageId: "0xpkg",
      coinType: "0x2::sui::SUI",
      refGasPriceMist: "1000",
      startedAtIso: "2026-01-01T00:00:00.000Z",
      poolSize: 4,
      stakeMist: 1000,
      samples: 5,
    },
    opensPerPtb: {
      max: 256,
      bindingLimit: "event-budget",
      sweep: [
        { N: 1, ok: true, wallMs: 10, gasPerOpenMist: 4_374_000, events: 4, commands: 2 },
        {
          N: 320,
          ok: false,
          wallMs: 0,
          gasPerOpenMist: 0,
          events: 1280,
          commands: 321,
          error: "events exceed 1024 budget",
          bound: "event-budget",
        },
      ],
      predicted: predictedCeilings(),
    },
    closesPerPtb: {
      max: 256,
      bindingLimit: "event-budget",
      reachedCap: false,
      sweep: [
        { K: 32, ok: true, wallMs: 20 },
        { K: 512, ok: false, wallMs: 0, error: "events exceed 1024 budget", bound: "event-budget" },
      ],
    },
    throughput: {
      open: [
        {
          batch: 8,
          pool: 4,
          offeredRate: 100,
          acceptedOpensPerSec: 90,
          p50Ms: 5,
          p99Ms: 9,
          errorRate: 0,
        },
      ],
      close: [
        {
          pool: 4,
          workingSet: 32,
          offeredRate: 50,
          acceptedClosesPerSec: 48,
          p50Ms: 6,
          p99Ms: 10,
          errorRate: 0,
        },
      ],
      openCeilingPerSec: 90,
      closeCeilingPerSec: 48,
    },
    gas: {
      openMist: { computation: 1, storage: 2, rebate: 1, netMist: 2, netSui: 2e-9 },
      closeMist: { computation: 1, storage: 1, rebate: 1, netMist: 1, netSui: 1e-9 },
      vsTestnet: { openDeltaSui: -0.004, closeDeltaSui: -0.003 },
    },
    derived: { netSuiPerTunnel: 3e-9, tunnelsSettledPerSec: 48 },
  };
}

test("renderProbeMarkdown renders every present section", () => {
  const md = renderProbeMarkdown(fullReport());
  expect(md).toContain("# loadbench probe — feat-x");
  expect(md).toContain("## Opens-per-PTB knee");
  expect(md).toContain("## Closes-per-PTB knee");
  expect(md).toContain("## Throughput (back-pressure)");
  expect(md).toContain("## Per-tx gas");
  expect(md).toContain("## Derived");
  expect(md).toContain("event-budget");
});

test("renderProbeMarkdown omits skipped phases but always shows Derived", () => {
  const r = fullReport();
  r.opensPerPtb = null;
  r.closesPerPtb = null;
  r.throughput = null;
  r.gas = null;
  r.derived = { netSuiPerTunnel: 0, tunnelsSettledPerSec: null };
  const md = renderProbeMarkdown(r);
  expect(md).not.toContain("## Opens-per-PTB knee");
  expect(md).not.toContain("## Closes-per-PTB knee");
  expect(md).not.toContain("## Per-tx gas");
  expect(md).toContain("## Derived");
  expect(md).toContain("Tunnels settled / s:** —");
});

test("renderProbeSummary is a single labelled line", () => {
  const line = renderProbeSummary(fullReport());
  expect(line.startsWith("[localnet/probe]")).toBe(true);
  expect(line).toContain("opens/PTB=256");
  expect(line.split("\n")).toHaveLength(1);
});

test("probeBasename builds a stamped, ext-suffixed filename", () => {
  expect(probeBasename("feat-x", "20260101-120000", "json")).toBe(
    "probe-feat-x-20260101-120000.json",
  );
});
