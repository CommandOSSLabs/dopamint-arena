import { useState } from "react";
import { useCurrentAccount, useSuiClientQuery } from "@mysten/dapp-kit";
import { formatAddress, SUI_DECIMALS } from "@mysten/sui/utils";
import type { PaymentsTunnelState } from "../PaymentsWindow";
import { PaymentsTransferAction } from "./PaymentsTransferAction";

export interface PaymentsTransferPayState {
  receive: string;
  amount: string;
}

interface PaymentsTransferProps {
  tunnel: PaymentsTunnelState;
  setTunnel: React.Dispatch<React.SetStateAction<PaymentsTunnelState | null>>;
}

export function PaymentsTransfer({ tunnel, setTunnel }: PaymentsTransferProps) {
  const availableAmount = Number(tunnel.totalBalance) / 10 ** SUI_DECIMALS;

  const [amount, setAmount] = useState(availableAmount.toString());

  const currentAccount = useCurrentAccount();

  const balance = useSuiClientQuery("getBalance", {
    owner: currentAccount?.address as string,
  });

  if (balance.isLoading || false) {
    return (
      <div className="p-4 space-y-3">
        <div className="animate-pulse bg-slate-600 w-full h-4" />

        <div className="animate-pulse bg-slate-600 w-full h-14" />

        <div className="animate-pulse bg-slate-600 w-full h-14" />

        <div className="animate-pulse bg-slate-600 w-full h-9" />
      </div>
    );
  }


  return;
  
  return (
    <div className="space-y-2.5 p-4 text-sm">
      <div className="space-y-1">
        <p className="text-[11px] uppercase text-arena-muted">To Account</p>

        <input
          value={formatAddress(tunnel.signer_B.toSuiAddress())}
          className="rounded border border-arena-edge bg-arena-bg px-2 py-1.5 w-full text-arena-text"
          placeholder="Enter address"
        />
      </div>

      <div className="space-y-1">
        <div className="text-[11px] uppercase text-arena-muted">Amount</div>

        <input
          defaultValue={amount || ""}
          value={amount || ""}
          placeholder="Enter amount"
          className="rounded border border-arena-edge bg-arena-bg px-2 py-1.5 w-full text-arena-text"
          type="number"
          onChange={({ currentTarget }) => setAmount(currentTarget.value)}
          onBlur={({ currentTarget }) => {
            const value = currentTarget.value;

            // don't allow negative
            if (value.length && Number(value) <= 0) {
              currentTarget.value = availableAmount.toString();

              setAmount(availableAmount.toString());
            }
          }}
        />

        <div className="text-xs text-right font-medium text-slate-500">
          Avaiable: {availableAmount} SUI
        </div>
      </div>

      <PaymentsTransferAction
        amount={amount}
        tunnel={tunnel}
        setTunnel={setTunnel}
      />
    </div>
  );
}
