import { cn } from "@/lib/utils";
import type { GameWindowProps } from "../../../types";
import { SketchDefs } from "../../../sketch";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";
import { PaymentsLobby } from "../PaymentsLobby";
import { PaymentsShop } from "../PaymentsShop";
import { PaymentsThankYou } from "../PaymentsThankYou";

export function PaymentsWindow({ windowId }: GameWindowProps) {
  const session = useRegularPaymentsSession(windowId);

  return (
    <div className={cn("sketch flex h-full min-h-0 w-full flex-col")}>
      <SketchDefs />

      {session.screen === "lobby" && <PaymentsLobby session={session} />}

      {session.screen === "shop" && <PaymentsShop session={session} />}

      {session.screen === "thankYou" && <PaymentsThankYou session={session} />}
    </div>
  );
}
