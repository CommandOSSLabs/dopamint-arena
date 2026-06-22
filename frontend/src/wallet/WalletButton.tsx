import { ConnectModal, useSuiClientContext } from "@mysten/dapp-kit";
import { isEnokiWallet } from "@mysten/enoki";
import { Copy, ExternalLink, LogOut, Wallet } from "lucide-react";
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
import { suivisionAccountUrl } from "@/lib/suivision";
import { useWalletSession } from "@/wallet/useWalletSession";

/** Header wallet control: connect (real dapp-kit), or a connected account menu. */
export function WalletButton() {
  const session = useWalletSession();
  const { network } = useSuiClientContext();

  if (!session.connected) {
    // dapp-kit's wallet picker, with our own design-system trigger. The filter keeps the
    // picker to Enoki wallets only — and since RegisterEnokiWallets registers just the
    // Google provider, that collapses to a single "Sign in with Google" entry.
    return (
      <ConnectModal
        walletFilter={isEnokiWallet}
        trigger={
          <Button size="sm">
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
        <Button variant="outline" size="sm">
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
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="grid size-4 shrink-0 place-items-center rounded-full bg-[#4da2ff]">
              <img
                src="/icons/sui.png"
                alt=""
                aria-hidden
                className="size-2.5 object-contain"
              />
            </span>
            <span className="tabular-nums">
              {session.balanceSui != null
                ? session.balanceSui.toLocaleString("en-US", {
                    maximumFractionDigits: 2,
                  })
                : "—"}{" "}
              SUI
            </span>
          </span>
        </DropdownMenuLabel>
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
