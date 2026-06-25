import { useCallback, useEffect, useMemo, useState } from "react";
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import {
  Banknote,
  CircleSlash,
  Plus,
  RotateCcw,
  Send,
  User,
  Wallet,
} from "lucide-react";

import type { GameWindowProps } from "../types";
import { Button } from "@/components/ui/button";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { MTPS_DECIMALS } from "@/onchain/mtps";
import {
  buildCancelStreamTx,
  buildCreateStreamTx,
  buildTopUpTx,
  computeAvailable,
  computeLocked,
  computeUnlocked,
  fetchStream,
  findCreatedStreamId,
  isStreamingPaymentConfigured,
  ratePerSecond,
  StreamStatus,
  streamStatusName,
  topUpAmountFor,
  type StreamFields,
  type StreamReader,
} from "@/onchain/streamingPayment";

const ONE_MTPS = 10n ** BigInt(MTPS_DECIMALS);

/** Sample recipients to stream to (each a distinct address — the contract forbids paying yourself). */
const RECIPIENTS = [
  {
    name: "Contractor",
    address:
      "0xc047c047c047c047c047c047c047c047c047c047c047c047c047c047c047c047",
  },
  {
    name: "Freelancer",
    address:
      "0xf2eef2eef2eef2eef2eef2eef2eef2eef2eef2eef2eef2eef2eef2eef2eef2ee",
  },
  {
    name: "Teammate",
    address:
      "0x7ea37ea37ea37ea37ea37ea37ea37ea37ea37ea37ea37ea37ea37ea37ea37ea3",
  },
] as const;

/** Stream durations (>= the contract's 1-hour minimum). */
const DURATIONS = [
  { label: "1 hour", ms: 3_600_000n },
  { label: "6 hours", ms: 21_600_000n },
  { label: "1 day", ms: 86_400_000n },
] as const;

const TOPUP_MS = 3_600_000n; // "Add 1 hour" at the current rate.

function parseMtps(input: string): bigint {
  const [whole = "0", frac = ""] = input.trim().split(".");
  const fracPadded = (frac + "0".repeat(MTPS_DECIMALS)).slice(0, MTPS_DECIMALS);
  const w = BigInt(whole.replace(/[^0-9]/g, "") || "0");
  const f = BigInt(fracPadded.replace(/[^0-9]/g, "") || "0");
  return w * ONE_MTPS + f;
}

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

function timeAgo(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function recipientNameFor(addr: string): string {
  return RECIPIENTS.find((r) => r.address === addr)?.name ?? "Recipient";
}

type LedgerKind = "create" | "topup" | "cancel";
const LEDGER_ICON: Record<LedgerKind, typeof Plus> = {
  create: Banknote,
  topup: Plus,
  cancel: CircleSlash,
};
const LEDGER_LABEL: Record<LedgerKind, string> = {
  create: "Stream started",
  topup: "Topped up",
  cancel: "Cancelled & refunded",
};

interface LedgerEntry {
  kind: LedgerKind;
  amount?: string;
  digest: string;
  at: number;
}

interface StreamMeta {
  recipientName: string;
}

const txUrl = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;
const objUrl = (id: string) => `https://suiscan.xyz/testnet/object/${id}`;

/**
 * Streaming Payment — a salary / subscription / vesting stream. You lock a total amount that
 * unlocks linearly over a duration; the recipient withdraws what's unlocked at any time; you can
 * top up or cancel (the recipient keeps what it earned, the rest refunds to you). The live meter is
 * the real Move unlock math; start / top up / cancel are real testnet transactions. This is the
 * SENDER's view — withdrawing is the recipient's action, so the recipient's claimable is shown live.
 */
export function StreamingPaymentWindow({ windowId }: GameWindowProps) {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const client = suiClient as unknown as StreamReader;
  const { ready, signExec, prepareStake } = useSponsoredSignExec();
  const address = account?.address ?? "";

  const [streamId, setStreamId] = useLocalStorageState<string | null>(
    `mtps.streaming.id.${windowId}`,
    null,
  );
  const [meta, setMeta] = useLocalStorageState<StreamMeta | null>(
    `mtps.streaming.meta.${windowId}`,
    null,
  );
  const [ledger, setLedger] = useLocalStorageState<LedgerEntry[]>(
    `mtps.streaming.ledger.${windowId}`,
    [],
  );

  // Create-form inputs.
  const [recipientIdx, setRecipientIdx] = useState(0);
  const [totalInput, setTotalInput] = useState("3600");
  const [durationIdx, setDurationIdx] = useState(0);

  const [stream, setStream] = useState<StreamFields | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    if (!streamId) {
      setStream(null);
      return;
    }
    let alive = true;
    const tick = () =>
      fetchStream(client, streamId)
        .then((s) => {
          if (alive && s) setStream(s);
        })
        .catch(() => {});
    tick();
    const iv = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [streamId, client]);

  // Animate the unlock meter locally while active.
  useEffect(() => {
    if (!stream || stream.status !== StreamStatus.ACTIVE) return;
    const iv = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(iv);
  }, [stream]);

  useEffect(() => {
    if (!confirmCancel) return;
    const t = setTimeout(() => setConfirmCancel(false), 4000);
    return () => clearTimeout(t);
  }, [confirmCancel]);

  const now = BigInt(nowMs);
  const unlocked = stream ? computeUnlocked(stream, now) : 0n;
  const available = stream ? computeAvailable(stream, now) : 0n;
  const locked = stream ? computeLocked(stream, now) : 0n;

  const recipientName =
    meta?.recipientName ??
    (stream ? recipientNameFor(stream.recipient) : RECIPIENTS[recipientIdx].name);

  // Derived rate hint for the form.
  const formRate = useMemo(() => {
    const total = parseMtps(totalInput);
    const secs = DURATIONS[durationIdx].ms / 1000n;
    return secs > 0n ? total / secs : 0n;
  }, [totalInput, durationIdx]);

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

  const onStart = () =>
    run("Starting stream…", async () => {
      const recipient = RECIPIENTS[recipientIdx];
      const total = parseMtps(totalInput);
      const durationMs = DURATIONS[durationIdx].ms;
      if (total <= 0n) throw new Error("Amount must be greater than 0");
      if (recipient.address.toLowerCase() === address.toLowerCase())
        throw new Error("Recipient must differ from you");
      const coinId = await prepareStake(total);
      const tx = buildCreateStreamTx({
        fundsCoinId: coinId,
        totalAmount: total,
        recipient: recipient.address,
        durationMs,
        memo: recipient.name,
      });
      const { digest } = await signExec(tx);
      const id = await findCreatedStreamId(client, digest);
      if (!id) throw new Error("Stream created but its id wasn't found yet");
      setStreamId(id);
      setMeta({ recipientName: recipient.name });
      pushLedger({ kind: "create", digest, at: Date.now() });
      setStream(await fetchStream(client, id));
    });

  const onTopUp = () =>
    run("Adding funds…", async () => {
      if (!streamId || !stream) return;
      const addedAmount = topUpAmountFor(stream, TOPUP_MS);
      if (addedAmount <= 0n) return;
      const coinId = await prepareStake(addedAmount);
      const { digest } = await signExec(
        buildTopUpTx({
          streamId,
          fundsCoinId: coinId,
          addedAmount,
          addedDurationMs: TOPUP_MS,
        }),
      );
      pushLedger({ kind: "topup", amount: addedAmount.toString(), digest, at: Date.now() });
      setStream(await fetchStream(client, streamId));
    });

  const onCancel = () =>
    run("Cancelling…", async () => {
      if (!streamId) return;
      const { digest } = await signExec(buildCancelStreamTx(streamId));
      pushLedger({ kind: "cancel", digest, at: Date.now() });
      setStream(await fetchStream(client, streamId));
    });

  const reset = () => {
    setStreamId(null);
    setMeta(null);
    setLedger([]);
    setStream(null);
    setError(null);
  };

  const fillPct = useMemo(() => {
    if (!stream || stream.totalAmount === 0n) return 0;
    const pct = Number((unlocked * 10000n) / stream.totalAmount) / 100;
    return Math.max(0, Math.min(100, pct));
  }, [unlocked, stream]);

  if (!isStreamingPaymentConfigured) {
    return (
      <Shell>
        <p className="text-sm text-arena-muted">
          Streaming Payment isn't configured. Set{" "}
          <code className="text-arena-text">VITE_STREAMING_PAYMENT_PACKAGE_ID</code>{" "}
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
            Sign in to stream a payment to someone.
          </p>
        </div>
      </Shell>
    );
  }

  const isCancelled = stream?.status === StreamStatus.CANCELLED;
  const isCompleted = stream?.status === StreamStatus.COMPLETED;
  const isActive = stream?.status === StreamStatus.ACTIVE;

  // ── Create form ──────────────────────────────────────────────
  if (!streamId || isCancelled) {
    const recipient = RECIPIENTS[recipientIdx];
    return (
      <Shell>
        {isCancelled ? (
          <div className="rounded-md border border-arena-edge bg-arena-bg/60 px-3 py-2 text-xs text-arena-muted">
            Stream cancelled. The recipient kept what it earned; the rest was
            refunded to you. Start a new one below.
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-arena-muted">
            Pay someone over time — a salary or subscription. The money unlocks
            every second; they withdraw what they've earned, and you can top up or
            cancel anytime (you get the unused part back).
          </p>
        )}
        <Field label="Pay to">
          <select
            value={recipientIdx}
            onChange={(e) => setRecipientIdx(Number(e.target.value))}
            className="w-full rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-sm text-arena-text outline-none focus:border-arena-accent"
          >
            {RECIPIENTS.map((r, i) => (
              <option key={r.name} value={i}>
                {r.name}
              </option>
            ))}
          </select>
          <span className="font-mono text-[11px] text-arena-muted">
            {shortAddr(recipient.address)}
          </span>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Total amount">
            <NumberInput value={totalInput} onChange={setTotalInput} suffix="MTPS" min="0" />
          </Field>
          <Field label="Over">
            <select
              value={durationIdx}
              onChange={(e) => setDurationIdx(Number(e.target.value))}
              className="w-full rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-sm text-arena-text outline-none focus:border-arena-accent"
            >
              {DURATIONS.map((d, i) => (
                <option key={d.label} value={i}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <span className="text-[11px] text-arena-muted">
          ≈ {formatMtps(formRate)} MTPS / sec
        </span>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button onClick={onStart} disabled={Boolean(busy)} className="mt-1 gap-1.5">
          <Send className="size-4" />
          {busy ?? "Start stream"}
        </Button>
      </Shell>
    );
  }

  // First load.
  if (!stream) {
    return (
      <Shell>
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-arena-muted">
          <Banknote className="size-4 animate-pulse" /> Loading stream…
        </div>
      </Shell>
    );
  }

  // ── Live dashboard ───────────────────────────────────────────
  return (
    <Shell>
      {/* You → recipient */}
      <div className="flex items-center gap-2 text-sm">
        <span className="flex items-center gap-1.5 font-semibold text-arena-text">
          <Send className="size-4 text-arena-accent" />
          You
        </span>
        <span className="text-arena-muted">→</span>
        <span className="flex items-center gap-1.5 text-arena-text">
          <User className="size-4 text-arena-muted" />
          {recipientName}
        </span>
        <span className="ml-auto">
          <StatusBadge status={stream.status} />
        </span>
      </div>

      <div className="-mt-1 flex items-center gap-2 text-[11px] text-arena-muted">
        <a
          href={objUrl(stream.id)}
          target="_blank"
          rel="noreferrer"
          className="text-arena-accent hover:underline"
        >
          View on explorer ↗
        </a>
      </div>

      {/* Unlock meter */}
      <div className="rounded-lg border border-arena-edge bg-arena-bg/60 p-3">
        <span className="text-[11px] uppercase tracking-wide text-arena-muted">
          Streamed so far
        </span>
        <div className="mt-0.5 font-mono text-2xl font-semibold text-arena-text">
          {formatMtps(unlocked)}{" "}
          <span className="text-sm font-normal text-arena-muted">
            / {formatMtps(stream.totalAmount, 0)} MTPS
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-arena-edge">
          <div
            className="h-full rounded-full bg-arena-accent transition-[width] duration-200"
            style={{ width: `${fillPct}%` }}
          />
        </div>
        <div className="mt-1 font-mono text-[11px] text-arena-muted">
          {recipientName} can withdraw {formatMtps(available)} MTPS now
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Locked" value={formatMtps(locked)} />
        <Stat label="Withdrawn" value={formatMtps(stream.withdrawnAmount)} />
        <Stat label="Per sec" value={formatMtps(ratePerSecond(stream))} />
      </div>

      {/* Sender controls */}
      <div className="grid grid-cols-2 gap-2">
        <CtrlButton onClick={onTopUp} disabled={Boolean(busy) || !isActive} icon={Plus}>
          {busy === "Adding funds…" ? "Adding…" : "Add 1 hour"}
        </CtrlButton>
        <CtrlButton
          onClick={() => {
            if (confirmCancel) {
              setConfirmCancel(false);
              onCancel();
            } else {
              setConfirmCancel(true);
            }
          }}
          disabled={Boolean(busy) || !isActive}
          icon={CircleSlash}
          danger
        >
          {confirmCancel ? "Confirm?" : "Cancel"}
        </CtrlButton>
      </div>
      {isCompleted && (
        <p className="text-center text-[11px] text-arena-muted">
          Stream complete — the full amount has unlocked.
        </p>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      {/* Activity */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] uppercase tracking-wide text-arena-muted">
          Activity
        </span>
        <button
          onClick={reset}
          className="flex items-center gap-1 text-[11px] text-arena-muted hover:text-arena-text"
        >
          <RotateCcw className="size-3" /> New stream
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
                {LEDGER_LABEL[e.kind]}
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
        The recipient withdraws their earnings on their end. Cancel anytime —
        unused funds are refunded to you.
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
  const tone =
    status === StreamStatus.ACTIVE
      ? "text-emerald-400 border-emerald-400/40"
      : status === StreamStatus.COMPLETED
        ? "text-sky-400 border-sky-400/40"
        : "text-rose-400 border-rose-400/40";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {streamStatusName(status)}
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
