import { cn } from "@/lib/utils";
import { formatMtps } from "../../utils";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";

interface PaymentsLobbyProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
}

export function PaymentsLobby({ session }: PaymentsLobbyProps) {
  const disabled = !session.walletConnected || session.phase === "opening";

  return (
    <div className="sketch-welcome h-full min-h-0">
      <div
        className={cn(
          "sketch-welcome__card sketch-panel sketch-stroke",
          "w-full max-w-sm",
        )}
      >
        <div className="sketch-welcome__head">
          <span className="sketch-eyebrow">Off-chain checkout</span>
          <h1 className="sketch-title">Tunnel Mart</h1>
        </div>

        <p className="sketch-note">
          Shop with a budget of {formatMtps(session.depositBudget)} MTPS. Browse
          the aisles, add items to your cart, and check out with instant
          micro-payments.
        </p>

        {!session.walletConnected && (
          <p className="sketch-note text-red-500!">
            Connect your wallet to go shopping.
          </p>
        )}

        {session.error && (
          <p className="sketch-note text-(--sketch-felt)">{session.error}</p>
        )}

        <button
          className={cn("sketch-btn sketch-btn--go min-w-26 py-3 font-bold")}
          disabled={disabled}
          onClick={session.goShop}
        >
          {session.phase === "opening" ? "Opening tunnel" : "Go shop"}
        </button>
      </div>
    </div>
  );
}
