// Internal MTPS faucet — an ops-only page (route `/faucet`) that mints MTPS to any address via the
// backend's bearer-gated internal endpoint (`POST /v1/faucet/internal`, ADR-0015). Inputs are the
// recipient address and the backend's `FAUCET_ADMIN_TOKEN`; unlike the public faucet there is no
// per-address cooldown, so this is deliberately kept outside the wallet gate and off the navbar.
import { useState, type FormEvent } from "react";
import { useSuiClientContext } from "@mysten/dapp-kit";
import { toast } from "sonner";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Panel,
  PanelHeader,
  PanelTitle,
  PanelContent,
} from "@/components/ui/panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  faucetMtpsInternal,
  isMtpsConfigured,
  MTPS_MAX_MINT_PER_CALL,
  type FaucetMintResult,
} from "@/onchain/mtps";
import { suivisionTxUrl, truncateMiddle } from "@/lib/suivision";
import { usePageMeta } from "@/lib/usePageMeta";

export function FaucetInternalPage() {
  usePageMeta({
    title: "Faucet — MillionsTPS",
    description: "Mint testnet MTPS to any Sui address.",
    image: "/og-faucet.png",
    imageAlt: "MillionsTPS Faucet — mint testnet MTPS to any Sui address.",
  });
  const { network } = useSuiClientContext();
  const [recipient, setRecipient] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [amount, setAmount] = useState("");
  const [toBalance, setToBalance] = useState(true);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<FaucetMintResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    recipient.trim().length > 0 && adminToken.length > 0 && !pending;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    // Validate the optional amount client-side so an obvious typo is caught before the round-trip;
    // the backend still enforces the same 1..=MAX bound authoritatively.
    let parsedAmount: number | undefined;
    if (amount.trim()) {
      const n = Number(amount.trim());
      if (!Number.isInteger(n) || n < 1 || n > MTPS_MAX_MINT_PER_CALL) {
        setError(
          `Amount must be a whole number 1..=${MTPS_MAX_MINT_PER_CALL}.`,
        );
        return;
      }
      parsedAmount = n;
    }

    setPending(true);
    setError(null);
    setResult(null);
    try {
      const minted = await faucetMtpsInternal({
        adminToken: adminToken.trim(),
        recipient: recipient.trim(),
        amount: parsedAmount,
        toBalance,
      });
      setResult(minted);
      toast.success(`Minted ${minted.amount} MTPS`, {
        description: truncateMiddle(minted.recipient),
      });
    } catch (err) {
      const e = err as Error & { status?: number };
      const message = e.status
        ? `${e.message} (HTTP ${e.status})`
        : e.message || "Faucet request failed";
      setError(message);
      toast.error("Faucet failed", { description: message });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-4 p-6">
      <Panel>
        <PanelHeader>
          <PanelTitle className="flex items-center gap-2">
            <KeyRound className="size-3.5" /> Internal MTPS Faucet
          </PanelTitle>
        </PanelHeader>
        <PanelContent className="gap-5 p-5">
          <p className="text-sm text-muted-foreground">
            Mint MTPS to any address via the bearer-gated internal endpoint. No
            cooldown — for ops use only. The admin token is sent with the
            request and never stored.
          </p>

          {!isMtpsConfigured && (
            <Alert variant="destructive">
              <AlertTitle>MTPS not configured</AlertTitle>
              <AlertDescription>
                The MTPS env ids are unset in this build — minting will fail
                until the backend is pointed at a deployed coin.
              </AlertDescription>
            </Alert>
          )}

          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="faucet-recipient">Recipient address</Label>
              <Input
                id="faucet-recipient"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="faucet-token">
                Admin token (FAUCET_ADMIN_TOKEN)
              </Label>
              <Input
                id="faucet-token"
                type="password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="bearer secret"
                autoComplete="off"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="faucet-amount">
                Amount{" "}
                <span className="font-normal text-muted-foreground">
                  (optional, whole MTPS)
                </span>
              </Label>
              <Input
                id="faucet-amount"
                type="number"
                inputMode="numeric"
                min={1}
                max={MTPS_MAX_MINT_PER_CALL}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="backend default"
              />
            </div>

            <Label
              htmlFor="faucet-to-balance"
              className="cursor-pointer items-start gap-2 font-normal"
            >
              <Checkbox
                id="faucet-to-balance"
                checked={toBalance}
                onCheckedChange={(c) => setToBalance(c === true)}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Deposit to address balance</span>
                <span className="text-xs text-muted-foreground">
                  SIP-58 address balance (the stake path withdraws from it).
                  Uncheck to mint an owned coin instead.
                </span>
              </span>
            </Label>

            <Button type="submit" disabled={!canSubmit}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              {pending ? "Minting…" : "Mint MTPS"}
            </Button>
          </form>

          {error && (
            <Alert variant="destructive">
              <AlertTitle>Mint failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {result && (
            <Alert>
              <AlertTitle>
                Minted {result.amount} MTPS to{" "}
                {truncateMiddle(result.recipient)}
              </AlertTitle>
              <AlertDescription>
                <a
                  href={suivisionTxUrl(result.digest, network)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                >
                  {truncateMiddle(result.digest, 8, 6)}
                  <ExternalLink className="size-3" />
                </a>
              </AlertDescription>
            </Alert>
          )}
        </PanelContent>
      </Panel>
    </div>
  );
}
