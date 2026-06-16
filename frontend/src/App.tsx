import { WalletGate } from "./wallet/WalletGate";
import { Desktop } from "./desktop/Desktop";
import { TelemetryProvider } from "./telemetry/TelemetryProvider";

export function App() {
  return (
    <WalletGate>
      <TelemetryProvider>
        <Desktop />
      </TelemetryProvider>
    </WalletGate>
  );
}
