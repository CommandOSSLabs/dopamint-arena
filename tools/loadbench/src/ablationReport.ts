import type { AblationResult, AblationLine } from "./ablation";

const PREFIX = "[local/offchain]";

function pct(ns: number, budget: number): string {
  if (budget <= 0) return "n/a";
  return `${Math.round((ns / budget) * 100)}%`;
}

function ns(n: number): string {
  return `${Math.round(n)}ns`;
}

function line(l: AblationLine, budget: number): string {
  return `  ${l.label.padEnd(48)} ${ns(l.nsPerMove).padStart(10)}  ${pct(
    l.nsPerMove,
    budget,
  ).padStart(5)}`;
}

export function renderAblation(
  r: AblationResult,
  rustbenchFloorNs?: number | null,
): string {
  const b = r.perMoveBudgetNs;
  const out: string[] = [];
  out.push(`${PREFIX} JS-overhead ablation: ${r.game}, ${r.moves} moves`);
  out.push(`${PREFIX} additive per-move buckets (non-overlapping):`);
  for (const bucket of r.buckets) out.push(line(bucket, b));
  out.push(line({ label: "attributed subtotal", nsPerMove: r.attributedNs }, b));
  out.push(
    line(
      { label: "unattributed (engine + microtask delivery + JIT/AOT)", nsPerMove: r.residualNs },
      b,
    ),
  );
  out.push(line({ label: "per-move budget (measured)", nsPerMove: b }, b));
  if (rustbenchFloorNs != null) {
    out.push(`${PREFIX} rustbench floor (AOT ref): ${ns(rustbenchFloorNs)}/move`);
  }
  out.push(`${PREFIX} informational sub-measures (overlap buckets; not additive):`);
  for (const sub of r.subMeasures) out.push(line(sub, b));
  out.push(
    `${PREFIX} note: isolated costs are measured outside the real interleaving; ` +
      `the attributed subtotal need not equal the budget, and the residual ` +
      `absorbs engine logic, microtask delivery, JIT-vs-AOT, and measurement drift.`,
  );
  return out.join("\n") + "\n";
}

export function renderAblationMarkdown(
  r: AblationResult,
  stampedAt: string,
  rustbenchFloorNs?: number | null,
): string {
  const b = r.perMoveBudgetNs;
  const row = (l: AblationLine) =>
    `| ${l.label} | ${Math.round(l.nsPerMove)} | ${pct(l.nsPerMove, b)} |`;
  const lines: string[] = [];
  lines.push(`# loadbench JS-overhead ablation`);
  lines.push("");
  lines.push(`- game: \`${r.game}\``);
  lines.push(`- moves: ${r.moves}`);
  lines.push(`- generated: ${stampedAt}`);
  if (rustbenchFloorNs != null) {
    lines.push(`- rustbench floor (AOT ref): ${Math.round(rustbenchFloorNs)} ns/move`);
  }
  lines.push("");
  lines.push(`## Additive per-move buckets (non-overlapping)`);
  lines.push("");
  lines.push(`| overhead | ns/move | % of budget |`);
  lines.push(`|---|---|---|`);
  for (const bucket of r.buckets) lines.push(row(bucket));
  lines.push(row({ label: "attributed subtotal", nsPerMove: r.attributedNs }));
  lines.push(
    row({
      label: "unattributed (engine + microtask delivery + JIT/AOT)",
      nsPerMove: r.residualNs,
    }),
  );
  lines.push(row({ label: "per-move budget (measured)", nsPerMove: b }));
  lines.push("");
  lines.push(`## Informational sub-measures (overlap buckets; not additive)`);
  lines.push("");
  lines.push(`| overhead | ns/move | % of budget |`);
  lines.push(`|---|---|---|`);
  for (const sub of r.subMeasures) lines.push(row(sub));
  lines.push("");
  lines.push(
    `> Isolated costs are measured outside the real interleaving; the attributed ` +
      `subtotal need not equal the budget, and the residual absorbs engine logic, ` +
      `microtask delivery, JIT-vs-AOT, and measurement drift.`,
  );
  return lines.join("\n") + "\n";
}

export function ablationBasename(env: string, stamp: string): string {
  return `ablation-${env}-${stamp}.md`;
}
