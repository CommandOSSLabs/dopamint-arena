import { Role } from "@/pvp/mpClient";
import { formatAddress, SUI_DECIMALS } from "@mysten/sui/utils";
import { Copy } from "lucide-react";
import { toast } from "sonner";

interface PaymentsChallengePlayerProps {
  role: Role;
  address: string;
  amount: BigInt;
}

export default function PaymentsChallengePlayer({
  role,
  address,
  amount,
}: PaymentsChallengePlayerProps) {
  return (
    <div className={`space-y-0.5 ${role === "B" ? "text-right" : ""}`}>
      <p className="text-[10px] uppercase text-slate-500">Player {role}</p>

      <div className="flex gap-2">
        <p className="font-mono text-xs text-slate-200">
          {formatAddress(address)}
        </p>

        <button
          onClick={() => {
            navigator.clipboard
              ?.writeText(address)
              .then(() =>
                toast.success("Address copied", {
                  position: "top-right",
                }),
              )
              .catch(() =>
                toast.error("Copy failed", {
                  position: "top-right",
                }),
              );
          }}
        >
          <Copy className="size-3.5" />
        </button>
      </div>

      <div className="inline-flex items-center gap-2">
        <p className="font-semibold text-sm">
          {Number(amount) / 10 ** SUI_DECIMALS}
        </p>

        <span className="bg-[#4da2ff] flex items-center justify-center size-4 rounded-full">
          <img src="/icons/sui.png" className="size-2.5 object-contain" />
        </span>
      </div>
    </div>
  );
}
