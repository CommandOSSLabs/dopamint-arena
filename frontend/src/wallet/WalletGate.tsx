import type { ReactNode } from "react";
import { ConnectButton, useCurrentAccount } from "@mysten/dapp-kit";

/** Renders the connect screen until a wallet account exists, then the children. */
export function WalletGate({ children }: { children: ReactNode }) {
  const account = useCurrentAccount();
  if (account) return <>{children}</>;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-arena-bg">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          Dopamint <span className="text-arena-accent">Arena</span>
        </h1>
        <p className="mt-2 text-sm text-arena-muted">
          Connect a wallet to enter the arena.
        </p>
      </div>
      <ConnectButton />
    </div>
  );
}
