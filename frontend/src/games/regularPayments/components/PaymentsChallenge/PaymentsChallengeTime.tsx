import { useEffect, useState } from "react";
import { DefaultTimeoutTunnel } from "../../utils/config";

interface PaymentsChallengeTimeProps {
  created_at: number;
  onTimeEnd: () => void;
}

export default function PaymentsChallengeTime({
  created_at,
  onTimeEnd,
}: PaymentsChallengeTimeProps) {
  const [gameTime, setGameTime] = useState<string>();

  // Game time
  useEffect(() => {
    const updateTimer = () => {
      const now = Date.now();
      const timeLeft = created_at + DefaultTimeoutTunnel - now;

      // Close game here
      if (timeLeft <= 0) {
        setGameTime("00:00");
        clearInterval(subscribe);
        onTimeEnd();
        return;
      }

      // Convert remaining milliseconds to Minutes and Seconds
      const minutes = Math.floor(timeLeft / 1000 / 60);
      const seconds = Math.floor((timeLeft / 1000) % 60);

      // Format with leading zeros (e.g., 04:09)
      setGameTime(
        `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
      );
    };

    // first call for no shift-layout
    updateTimer();

    // loop for update UI
    const subscribe = setInterval(updateTimer, 1000);

    return () => {
      clearInterval(subscribe);
    };
  }, []);

  return (
    <span className="text-white text-sm font-mono">{gameTime || "..."}</span>
  );
}
