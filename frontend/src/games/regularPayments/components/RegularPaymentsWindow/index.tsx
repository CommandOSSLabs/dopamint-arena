import type { GameWindowProps } from "../../../types";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";
import { RegularPaymentsLobby } from "../RegularPaymentsLobby";
import { RegularPaymentsShop } from "../RegularPaymentsShop";
import { RegularPaymentsThankYou } from "../RegularPaymentsThankYou";

export function RegularPaymentsWindow({ windowId }: GameWindowProps) {
  const session = useRegularPaymentsSession(windowId);

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col text-foreground">
      {session.screen === "lobby" && <RegularPaymentsLobby session={session} />}

      {session.screen === "shop" && <RegularPaymentsShop session={session} />}

      {session.screen === "thankYou" && (
        <RegularPaymentsThankYou session={session} />
      )}
    </div>
  );
}
