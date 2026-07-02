import { WalletButton } from "@/wallet/WalletButton";

/**
 * Overlay shown over a wallet-gated game while the wallet is disconnected. Dims the
 * frozen game and offers a reconnect action; on reconnect the game resumes in place
 * (or auto-enters a fresh match). Absolutely positioned to fill the window body.
 */
export function FrozenScrim() {
  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-background/85 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 px-4 text-center">
        <p className="text-sm font-medium text-foreground">
          Wallet disconnected
        </p>
        <p className="text-xs text-muted-foreground">
          Reconnect to resume this game.
        </p>
        <WalletButton />
      </div>
    </div>
  );
}
