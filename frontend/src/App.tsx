import { WalletGate } from "./wallet/WalletGate";
import { Desktop } from "./desktop/Desktop";

export function App() {
  return (
    <WalletGate>
      <Desktop />
    </WalletGate>
  );
}
