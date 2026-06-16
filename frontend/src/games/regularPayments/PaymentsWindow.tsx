import type { GameWindowProps } from "../types";

/**
 * Reference game stub. To add a game: copy this folder, rename it, swap this
 * content for your game UI, and call register() in index.ts. The `_props`
 * (windowId, onClose) are how a real game would settle and close itself.
 */
export function PaymentsWindow(_props: GameWindowProps) {
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <div className="text-arena-muted">
        From Balance
        <span className="float-right text-arena-text">$1,248.75</span>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase text-arena-muted">To Account</span>
        <input
          id="to-account"
          name="toAccount"
          disabled
          defaultValue="user_84219"
          className="rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-arena-text"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase text-arena-muted">Amount</span>
        <input
          id="amount"
          name="amount"
          disabled
          defaultValue="75.00 USD"
          className="rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-arena-text"
        />
      </label>
      <button
        disabled
        className="mt-1 cursor-not-allowed rounded bg-arena-accent/70 px-3 py-2 font-medium text-arena-bg"
      >
        Send Payment
      </button>
      <p className="text-[11px] text-arena-muted">
        Placeholder — wire to the payments Protocol + agent loop.
      </p>
    </div>
  );
}
