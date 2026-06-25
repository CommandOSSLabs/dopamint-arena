import { useCallback, useEffect, useMemo, useState } from "react";
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import {
  Bot,
  CircleSlash,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Server,
  Wallet,
  Zap,
} from "lucide-react";

import type { GameWindowProps } from "../types";
import { Button } from "@/components/ui/button";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { MTPS_DECIMALS } from "@/onchain/mtps";
import {
  AllowanceStatus,
  allowanceStatusName,
  buildClaimTx,
  buildCreateAllowanceTx,
  buildPauseTx,
  buildResumeTx,
  buildRevokeTx,
  computeAvailable,
  computeEntitled,
  fetchAllowance,
  findCreatedAllowanceId,
  isAgentAllowanceConfigured,
  toAccrualState,
  type AllowanceFields,
  type AllowanceReader,
} from "@/onchain/agentAllowance";

const ONE_MTPS = 10n ** BigInt(MTPS_DECIMALS);

/**
 * Sample services an agent can be funded to pay — the real-world x402 use case:
 * an autonomous agent metered against an API/compute provider. Each is a distinct
 * on-chain address (the contract forbids the payee being the funder), with a
 * suggested per-second rate. Funds the agent settles flow to this address.
 */
const PROVIDERS = [
  {
    name: "AI Inference",
    blurb: "AI text generation",
    rate: "0.5",
    address:
      "0xa9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7",
  },
  {
    name: "Web Search",
    blurb: "Web search queries",
    rate: "0.3",
    address:
      "0x5ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea4",
  },
  {
    name: "Market Data",
    blurb: "Live market prices",
    rate: "0.8",
    address:
      "0xda7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7a",
  },
] as const;

// A scoped token bounded by TIME (the Stripe Shared-Payment-Token / Coinbase session
// model): the policy can expire so a stale agent can't keep spending. 0 = open-ended.
const EXPIRY_OPTIONS = [
  { label: "Never", ms: 0n },
  { label: "1 hour", ms: 3_600_000n },
  { label: "1 day", ms: 86_400_000n },
] as const;

// On-chain `claim` checks `amount <= entitled(Clock) - spent`, and the Sui Clock lags
// wall-clock by a second or more. Settling against a timestamp this far in the past keeps
// the requested amount safely under what the chain has actually vested (ENotYetVested).
const CLAIM_SKEW_MS = 5000n;

/** Parse a decimal MTPS string ("0.5", "100") to raw base units. */
function parseMtps(input: string): bigint {
  const [whole = "0", frac = ""] = input.trim().split(".");
  const fracPadded = (frac + "0".repeat(MTPS_DECIMALS)).slice(0, MTPS_DECIMALS);
  const w = BigInt(whole.replace(/[^0-9]/g, "") || "0");
  const f = BigInt(fracPadded.replace(/[^0-9]/g, "") || "0");
  return w * ONE_MTPS + f;
}

/** Format raw MTPS base units as a trimmed decimal string. */
function formatMtps(raw: bigint, dp = 4): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const whole = v / ONE_MTPS;
  const frac = (v % ONE_MTPS)
    .toString()
    .padStart(MTPS_DECIMALS, "0")
    .slice(0, dp)
    .replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Name of the provider a payee address maps to, for resumed mandates. */
function providerNameFor(payee: string): string {
  return PROVIDERS.find((p) => p.address === payee)?.name ?? "Provider";
}

type LedgerKind = "create" | "pull" | "pause" | "resume" | "revoke";

interface LedgerEntry {
  kind: LedgerKind;
  /** Raw MTPS amount, as a string (bigint isn't JSON-serializable). */
  amount?: string;
  digest: string;
  at: number;
}

/** The scenario labels (agent + provider) — persisted so a restored window reads right. */
interface MandateMeta {
  agentName: string;
  providerName: string;
}

const txUrl = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;
const objUrl = (id: string) => `https://suiscan.xyz/testnet/object/${id}`;

/** Per-action icon for the activity feed. */
const LEDGER_ICON: Record<LedgerKind, typeof Plus> = {
  create: Bot,
  pull: Zap,
  pause: Pause,
  resume: Play,
  revoke: CircleSlash,
};

/** Compact "2m ago" relative time. */
function timeAgo(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/**
 * Agent Allowance — the x402 use case made concrete: you fund an autonomous AI
 * agent with a capped, revocable budget to pay a metered API/compute provider.
 * Payment streams per second (the live meter is the real Move accrual math); the
 * agent settles usage to the provider with no per-charge signature, and you can
 * pause or revoke (refunding the unspent budget) at any time. Deploy / settle /
 * pause / revoke are real testnet transactions.
 */
export function AgentAllowanceWindow({ windowId }: GameWindowProps) {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  // dapp-kit's client structurally satisfies the reader we need; cast once (the
  // same pattern useSponsoredSignExec uses for its CoinReader).
  const client = suiClient as unknown as AllowanceReader;
  const { ready, signExec, prepareStake } = useSponsoredSignExec();
  const address = account?.address ?? "";

  // Persist the mandate id, scenario labels, and ledger per window so a
  // minimize/restore (or breakpoint reflow) keeps the running agent.
  const [allowanceId, setAllowanceId] = useLocalStorageState<string | null>(
    `mtps.agentAllowance.id.${windowId}`,
    null,
  );
  const [meta, setMeta] = useLocalStorageState<MandateMeta | null>(
    `mtps.agentAllowance.meta.${windowId}`,
    null,
  );
  const [ledger, setLedger] = useLocalStorageState<LedgerEntry[]>(
    `mtps.agentAllowance.ledger.${windowId}`,
    [],
  );

  // Deploy-form inputs.
  const [agentName, setAgentName] = useState("Research Agent");
  const [providerIdx, setProviderIdx] = useState(0);
  const [capInput, setCapInput] = useState("100");
  const [rateInput, setRateInput] = useState<string>(PROVIDERS[0].rate);
  const [expiryIdx, setExpiryIdx] = useState(0);

  const [allowance, setAllowance] = useState<AllowanceFields | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Two-step guard for the destructive Stop (revoke): first click arms, second confirms.
  const [confirmStop, setConfirmStop] = useState(false);

  // Poll the shared Allowance object while one exists (escrow / spent / status).
  useEffect(() => {
    if (!allowanceId) {
      setAllowance(null);
      return;
    }
    let alive = true;
    // Never clobber a loaded snapshot with a transient null (RPC lag) — that would
    // flash the loading state mid-session.
    const tick = () =>
      fetchAllowance(client, allowanceId)
        .then((a) => {
          if (alive && a) setAllowance(a);
        })
        .catch(() => {});
    tick();
    const iv = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [allowanceId, client]);

  // Animate the spend meter locally (no chain calls) while active.
  useEffect(() => {
    if (!allowance || allowance.status !== AllowanceStatus.ACTIVE) return;
    const iv = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(iv);
  }, [allowance]);

  // Auto-disarm the Stop confirmation if it isn't acted on.
  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 4000);
    return () => clearTimeout(t);
  }, [confirmStop]);

  const accrual = allowance ? toAccrualState(allowance) : null;
  const now = BigInt(nowMs);
  const entitled = accrual ? computeEntitled(accrual, now) : 0n;
  const available =
    allowance && accrual
      ? computeAvailable(accrual, allowance.spent, allowance.escrowBalance, now)
      : 0n;
  // What the agent can SAFELY settle now, discounting the Sui Clock lag (see
  // CLAIM_SKEW_MS) so the on-chain `amount <= unspent` check can't trip.
  const claimable =
    allowance && accrual
      ? computeAvailable(
          accrual,
          allowance.spent,
          allowance.escrowBalance,
          now - CLAIM_SKEW_MS,
        )
      : 0n;

  const providerName =
    meta?.providerName ??
    (allowance ? providerNameFor(allowance.payee) : PROVIDERS[providerIdx].name);
  const displayAgent = meta?.agentName ?? agentName;

  // "Observable lifecycle": the policy's time bound, shown live.
  const expiryLabel = (() => {
    if (!allowance || allowance.expiryMs === 0n) return "no expiry";
    const remMs = Number(allowance.expiryMs - now);
    if (remMs <= 0) return "expired";
    const h = Math.floor(remMs / 3_600_000);
    const m = Math.floor((remMs % 3_600_000) / 60_000);
    return h > 0 ? `expires in ${h}h ${m}m` : `expires in ${m}m`;
  })();

  const pushLedger = useCallback(
    (e: LedgerEntry) => setLedger((prev) => [e, ...prev].slice(0, 30)),
    [setLedger],
  );

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const onDeploy = () =>
    run("Starting agent…", async () => {
      const provider = PROVIDERS[providerIdx];
      const cap = parseMtps(capInput);
      const rate = parseMtps(rateInput);
      const payee = provider.address;
      if (cap <= 0n) throw new Error("Budget must be greater than 0");
      if (payee.toLowerCase() === address.toLowerCase())
        throw new Error("Provider must differ from you (the funder)");
      // "Bounded by time": an absolute deadline, or 0 for open-ended.
      const choice = EXPIRY_OPTIONS[expiryIdx];
      const expiryMs = choice.ms === 0n ? 0n : BigInt(Date.now()) + choice.ms;
      // Escrow the full budget so the policy is fully backed.
      const coinId = await prepareStake(cap);
      const tx = buildCreateAllowanceTx({
        fundsCoinId: coinId,
        fundAmount: cap,
        payee,
        ratePerSecond: rate,
        spendCap: cap,
        expiryMs,
      });
      const { digest } = await signExec(tx);
      const id = await findCreatedAllowanceId(client, digest);
      if (!id) throw new Error("Agent deployed but its mandate id wasn't found yet");
      setAllowanceId(id);
      setMeta({ agentName: agentName.trim() || "Agent", providerName: provider.name });
      pushLedger({ kind: "create", digest, at: Date.now() });
      setAllowance(await fetchAllowance(client, id));
    });

  const onSettle = () =>
    run("Paying…", async () => {
      if (!allowanceId || !allowance || !accrual) return;
      // Recompute at click against a past timestamp so the amount stays under
      // the chain's vested total even as the Sui Clock lags wall-clock.
      const amount = computeAvailable(
        accrual,
        allowance.spent,
        allowance.escrowBalance,
        BigInt(Date.now()) - CLAIM_SKEW_MS,
      );
      if (amount <= 0n) throw new Error("Nothing to pay yet — give it a moment");
      const { digest } = await signExec(buildClaimTx(allowanceId, amount));
      pushLedger({ kind: "pull", amount: amount.toString(), digest, at: Date.now() });
      setAllowance(await fetchAllowance(client, allowanceId));
    });

  const onPause = () =>
    run("Pausing…", async () => {
      if (!allowanceId) return;
      const { digest } = await signExec(buildPauseTx(allowanceId));
      pushLedger({ kind: "pause", digest, at: Date.now() });
      setAllowance(await fetchAllowance(client, allowanceId));
    });

  const onResume = () =>
    run("Resuming…", async () => {
      if (!allowanceId) return;
      const { digest } = await signExec(buildResumeTx(allowanceId));
      pushLedger({ kind: "resume", digest, at: Date.now() });
      setAllowance(await fetchAllowance(client, allowanceId));
    });

  const onRevoke = () =>
    run("Revoking…", async () => {
      if (!allowanceId) return;
      const { digest } = await signExec(buildRevokeTx(allowanceId));
      pushLedger({ kind: "revoke", digest, at: Date.now() });
      setAllowance(await fetchAllowance(client, allowanceId));
    });

  const reset = () => {
    setAllowanceId(null);
    setMeta(null);
    setLedger([]);
    setAllowance(null);
    setError(null);
  };

  // Meter fill fraction toward the budget cap.
  const fillPct = useMemo(() => {
    if (!allowance || allowance.spendCap === 0n) return 0;
    const pct = Number((entitled * 10000n) / allowance.spendCap) / 100;
    return Math.max(0, Math.min(100, pct));
  }, [entitled, allowance]);

  const ledgerLabel = useCallback(
    (kind: LedgerKind): string => {
      switch (kind) {
        case "create":
          return "Started";
        case "pull":
          return `Paid ${providerName}`;
        case "pause":
          return "Paused";
        case "resume":
          return "Resumed";
        case "revoke":
          return "Stopped & refunded";
      }
    },
    [providerName],
  );

  if (!isAgentAllowanceConfigured) {
    return (
      <Shell>
        <p className="text-sm text-arena-muted">
          Agent Allowance isn't configured. Set{" "}
          <code className="text-arena-text">VITE_AGENT_ALLOWANCE_PACKAGE_ID</code>{" "}
          and the MTPS env vars.
        </p>
      </Shell>
    );
  }

  if (!ready) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Wallet className="size-7 text-arena-muted" />
          <p className="text-sm text-arena-muted">
            Sign in to fund an agent's spending budget.
          </p>
        </div>
      </Shell>
    );
  }

  const isRevoked = allowance?.status === AllowanceStatus.REVOKED;
  const isPaused = allowance?.status === AllowanceStatus.PAUSED;

  // ── Deploy form ──────────────────────────────────────────────
  if (!allowanceId || isRevoked) {
    const provider = PROVIDERS[providerIdx];
    return (
      <Shell>
        {isRevoked ? (
          <div className="rounded-md border border-arena-edge bg-arena-bg/60 px-3 py-2 text-xs text-arena-muted">
            Agent stopped. The service kept what it earned; the unused budget was
            refunded to you. Start a new one below.
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-arena-muted">
            Give an AI agent a budget to pay a service for you. It pays a little
            every second as it works — pause or stop anytime and get the unused
            budget back.
          </p>
        )}
        <Field label="Agent">
          <input
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="Research Agent"
            className="w-full rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-sm text-arena-text outline-none focus:border-arena-accent"
          />
        </Field>
        <Field label="Service to pay">
          <select
            value={providerIdx}
            onChange={(e) => {
              const i = Number(e.target.value);
              setProviderIdx(i);
              setRateInput(PROVIDERS[i].rate);
            }}
            className="w-full rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-sm text-arena-text outline-none focus:border-arena-accent"
          >
            {PROVIDERS.map((p, i) => (
              <option key={p.name} value={i}>
                {p.name} — {p.blurb}
              </option>
            ))}
          </select>
          <span className="font-mono text-[11px] text-arena-muted">
            {shortAddr(provider.address)}
          </span>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Budget">
            <NumberInput value={capInput} onChange={setCapInput} suffix="MTPS" min="0" />
          </Field>
          <Field label="Per second">
            <NumberInput value={rateInput} onChange={setRateInput} suffix="MTPS" min="0" />
          </Field>
        </div>
        <Field label="Expires">
          <select
            value={expiryIdx}
            onChange={(e) => setExpiryIdx(Number(e.target.value))}
            className="w-full rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-sm text-arena-text outline-none focus:border-arena-accent"
          >
            {EXPIRY_OPTIONS.map((o, i) => (
              <option key={o.label} value={i}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button onClick={onDeploy} disabled={Boolean(busy)} className="mt-1 gap-1.5">
          <Bot className="size-4" />
          {busy ?? "Start agent"}
        </Button>
      </Shell>
    );
  }

  // First load: the mandate id is known but its on-chain object hasn't arrived yet.
  if (!allowance) {
    return (
      <Shell>
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-arena-muted">
          <Bot className="size-4 animate-pulse" /> Loading agent…
        </div>
      </Shell>
    );
  }

  // ── Live dashboard ───────────────────────────────────────────
  return (
    <Shell>
      {/* Agent → provider relationship */}
      <div className="flex items-center gap-2 text-sm">
        <span className="flex items-center gap-1.5 font-semibold text-arena-text">
          <Bot className="size-4 text-arena-accent" />
          {displayAgent}
        </span>
        <span className="text-arena-muted">→</span>
        <span className="flex items-center gap-1.5 text-arena-text">
          <Server className="size-4 text-arena-muted" />
          {providerName}
        </span>
        <span className="ml-auto">
          <StatusBadge status={allowance?.status ?? AllowanceStatus.ACTIVE} />
        </span>
      </div>

      {/* Explorer link + optional expiry */}
      <div className="-mt-1 flex items-center gap-2 text-[11px] text-arena-muted">
        {allowanceId && (
          <a
            href={objUrl(allowanceId)}
            target="_blank"
            rel="noreferrer"
            className="text-arena-accent hover:underline"
          >
            View on explorer ↗
          </a>
        )}
        {expiryLabel !== "no expiry" && <span>· {expiryLabel}</span>}
      </div>

      {/* Spend meter */}
      <div
        className={`rounded-lg border border-arena-edge bg-arena-bg/60 p-3 transition-opacity ${isPaused ? "opacity-60" : ""}`}
      >
        <span className="text-[11px] uppercase tracking-wide text-arena-muted">
          {isPaused ? "Paused — not accruing" : "Ready to pay"}
        </span>
        <div className="mt-0.5 font-mono text-2xl font-semibold text-arena-text">
          {formatMtps(available)}{" "}
          <span className="text-sm font-normal text-arena-muted">MTPS</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-arena-edge">
          <div
            className="h-full rounded-full bg-arena-accent transition-[width] duration-200"
            style={{ width: `${fillPct}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[11px] text-arena-muted">
          <span>used {formatMtps(entitled)}</span>
          <span>budget {formatMtps(allowance?.spendCap ?? 0n, 0)}</span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Budget left" value={formatMtps(allowance?.escrowBalance ?? 0n)} />
        <Stat label="Paid" value={formatMtps(allowance?.spent ?? 0n)} />
        <Stat label="Per sec" value={formatMtps(allowance?.ratePerSecond ?? 0n)} />
      </div>

      {/* Pay + controls */}
      <div className="flex flex-col gap-1">
        <Button
          onClick={onSettle}
          disabled={Boolean(busy) || claimable <= 0n || isPaused}
          className="gap-1.5"
        >
          <Zap className="size-4" />
          {busy === "Paying…" ? busy : "Pay now"}
        </Button>
        {!isPaused && !busy && claimable <= 0n && (
          <span className="text-center text-[11px] text-arena-muted">
            Funds are building up — you can pay in a few seconds.
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {isPaused ? (
          <CtrlButton onClick={onResume} disabled={Boolean(busy)} icon={Play}>
            Resume
          </CtrlButton>
        ) : (
          <CtrlButton onClick={onPause} disabled={Boolean(busy)} icon={Pause}>
            Pause
          </CtrlButton>
        )}
        <CtrlButton
          onClick={() => {
            if (confirmStop) {
              setConfirmStop(false);
              onRevoke();
            } else {
              setConfirmStop(true);
            }
          }}
          disabled={Boolean(busy)}
          icon={CircleSlash}
          danger
        >
          {confirmStop ? "Confirm?" : "Stop"}
        </CtrlButton>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {/* Activity ledger */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] uppercase tracking-wide text-arena-muted">
          Activity
        </span>
        <button
          onClick={reset}
          className="flex items-center gap-1 text-[11px] text-arena-muted hover:text-arena-text"
        >
          <RotateCcw className="size-3" /> New agent
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {ledger.length === 0 && (
          <li className="text-[11px] text-arena-muted">No activity yet.</li>
        )}
        {ledger.map((e, i) => {
          const Icon = LEDGER_ICON[e.kind];
          return (
            <li
              key={`${e.digest}-${i}`}
              className="flex items-center gap-2 rounded border border-arena-edge bg-arena-bg/40 px-2 py-1 text-xs"
            >
              <Icon className="size-3.5 shrink-0 text-arena-muted" />
              <span className="min-w-0 truncate text-arena-text">
                {ledgerLabel(e.kind)}
                {e.amount && (
                  <span className="ml-1 font-mono text-arena-muted">
                    {formatMtps(BigInt(e.amount))} MTPS
                  </span>
                )}
              </span>
              <a
                href={txUrl(e.digest)}
                target="_blank"
                rel="noreferrer"
                className="ml-auto shrink-0 text-[10px] text-arena-muted hover:text-arena-accent hover:underline"
              >
                {timeAgo(e.at)} ↗
              </a>
            </li>
          );
        })}
      </ul>
      <p className="text-[10px] leading-relaxed text-arena-muted">
        The agent pays as it works, with no fee to you. Pause or stop anytime —
        unused budget is refunded.
      </p>
    </Shell>
  );
}

// ── Small presentational helpers ───────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-3 p-4">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-arena-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  suffix,
  min,
}: {
  value: string;
  onChange: (v: string) => void;
  suffix: string;
  min?: string;
}) {
  return (
    <div className="flex items-center rounded border border-arena-edge bg-arena-bg focus-within:border-arena-accent">
      <input
        type="number"
        inputMode="decimal"
        min={min}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 bg-transparent px-2 py-1.5 text-sm text-arena-text outline-none"
      />
      <span className="px-2 text-[11px] text-arena-muted">{suffix}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-arena-edge bg-arena-bg/40 px-1 py-1.5">
      <div className="font-mono text-sm text-arena-text">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-arena-muted">
        {label}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: number }) {
  const active = status === AllowanceStatus.ACTIVE;
  const paused = status === AllowanceStatus.PAUSED;
  const color = active
    ? "text-emerald-400 border-emerald-400/40"
    : paused
      ? "text-amber-400 border-amber-400/40"
      : "text-rose-400 border-rose-400/40";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${color}`}>
      {allowanceStatusName(status)}
    </span>
  );
}

function CtrlButton({
  onClick,
  disabled,
  icon: Icon,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: typeof Plus;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      className={`gap-1.5 ${danger ? "border-rose-400/40 text-rose-400 hover:bg-rose-400/10" : ""}`}
    >
      <Icon className="size-4" />
      {children}
    </Button>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded border border-rose-400/40 bg-rose-400/10 px-2 py-1.5 text-xs text-rose-300">
      {children}
    </p>
  );
}
