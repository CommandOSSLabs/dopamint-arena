import { ConnectModal, useSuiClientContext } from "@mysten/dapp-kit";
import { isEnokiWallet } from "@mysten/enoki";
import {
  Coins,
  Copy,
  ExternalLink,
  Loader2,
  LogOut,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MTPS_ICON_URL, faucetMtps, isMtpsConfigured } from "@/onchain/mtps";
import { suivisionAccountUrl } from "@/lib/suivision";
import { useWalletSession } from "@/wallet/useWalletSession";

/** Header wallet control: connect (real dapp-kit), or a connected account menu. */
export function WalletButton({
  className,
  variant = "outline",
}: {
  className?: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
}) {
  const session = useWalletSession();
  const { network } = useSuiClientContext();
  const [fauceting, setFauceting] = useState(false);

  // Faucet MTPS into the connected address (server-side admin_mint → address balance). The new
  // balance settles a beat later (next balance poll), so we just confirm the request landed.
  const handleFaucet = async () => {
    if (!session.address || fauceting) return;
    setFauceting(true);
    try {
      await faucetMtps({ recipient: session.address });
      toast.success("Faucet sent — your MTPS will arrive shortly");
    } catch (e) {
      toast.error(`Faucet failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setFauceting(false);
    }
  };

  if (!session.connected) {
    // dapp-kit's wallet picker, with our own design-system trigger. The filter keeps the
    // picker to Enoki wallets only — and since RegisterEnokiWallets registers just the
    // Google provider, that collapses to a single "Sign in with Google" entry.
    return (
      <ConnectModal
        walletFilter={isEnokiWallet}
        trigger={
          <Button size="sm" variant={variant} className={className}>
            <Wallet />
            <span className="hidden sm:inline">Connect Wallet</span>
          </Button>
        }
      />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size="sm" className={className}>
          <Wallet />
          <span className="tabular-nums">{session.shortAddress}</span>
          {session.isDemo && (
            <span className="text-muted-foreground">· demo</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
          <span className="tabular-nums text-sm font-medium text-foreground">
            {session.shortAddress}
            {session.isDemo && (
              <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                demo
              </span>
            )}
          </span>
          <span className="flex items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-full border bg-background">
              <img
                src={MTPS_ICON_URL}
                alt=""
                aria-hidden
                className="size-5 object-contain"
              />
            </span>
            <span className="text-base font-semibold tabular-nums text-foreground">
              {session.balanceMtps != null
                ? session.balanceMtps.toLocaleString("en-US")
                : "—"}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                MTPS
              </span>
            </span>
          </span>
        </DropdownMenuLabel>
        {!session.isDemo && isMtpsConfigured && (
          <div className="px-1 pb-1">
            <Button
              size="sm"
              className="w-full"
              disabled={fauceting}
              onClick={handleFaucet}
            >
              {fauceting ? <Loader2 className="animate-spin" /> : <Coins />}
              {fauceting ? "Fauceting…" : "Faucet MTPS"}
            </Button>
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            navigator.clipboard
              ?.writeText(session.address ?? "")
              .then(() => toast("Address copied"))
              .catch(() => toast.error("Copy failed"));
          }}
        >
          <Copy /> Copy address
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a
            href={suivisionAccountUrl(session.address ?? "", network)}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalLink /> Open in explorer
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={session.disconnect}>
          <LogOut /> Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
