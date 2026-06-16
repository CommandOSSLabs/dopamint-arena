import type { TelemetrySnapshot } from "./panels/types";

/**
 * Static stand-in for the live telemetry feed. Numbers are illustrative only —
 * they exist so the shell renders something demo-shaped before the real engine
 * is wired. Replace this with a live TelemetrySnapshot source, not by editing
 * panels.
 */
export const PLACEHOLDER_SNAPSHOT: TelemetrySnapshot = {
  rate: {
    updates: 1_482_390,
    signatures: 2_964_780,
    verifications: 2_964_780,
    bytes: 187_402_112,
    tunnelsOpened: 1000,
    tunnelsClosed: 312,
    disputes: 0,
    settlements: 312,
    errors: 47,
    elapsedSec: 62.5,
    updatesPerSec: 23_718,
    signaturesPerSec: 47_436,
    verificationsPerSec: 47_436,
    bytesPerSec: 2_998_433,
    tunnelsActive: 688,
  },
  botsRunning: 15,
  totalBalance: 12_456.78,
  successRate: 99.68,
  tpsSeries: [
    12, 18, 14, 22, 19, 25, 21, 27, 24, 23, 28, 26, 22, 24, 23, 25, 27, 24, 26,
    24,
  ],
  txns: [
    { time: "14:23:51", bot: "Bot #2", type: "Poker Win", status: "Success", amount: "+$37.50" },
    { time: "14:23:51", bot: "Bot #1", type: "Blackjack Win", status: "Success", amount: "+$25.00" },
    { time: "14:23:50", bot: "Bot #7", type: "Payment", status: "Success", amount: "+$3.00" },
    { time: "14:23:49", bot: "Bot #4", type: "TicTacToe Win", status: "Success", amount: "+$1.10" },
    { time: "14:23:49", bot: "Bot #11", type: "Deposit", status: "Success", amount: "+$100.00" },
    { time: "14:23:48", bot: "Bot #9", type: "Coin Flip", status: "Success", amount: "+$2.00" },
    { time: "14:23:47", bot: "Bot #3", type: "Chess Win", status: "Success", amount: "+$5.20" },
    { time: "14:23:46", bot: "Bot #12", type: "Dice", status: "Failed", amount: "-$75.00" },
    { time: "14:23:45", bot: "Bot #5", type: "Payment", status: "Success", amount: "+$60.00" },
    { time: "14:23:44", bot: "Bot #8", type: "Slots", status: "Success", amount: "+$6.00" },
  ],
  deposits: [
    { time: "14:23:52", method: "USDT (TRC20)", amount: "+$200.00", status: "Success" },
    { time: "14:23:49", method: "USDC (ERC20)", amount: "+$100.00", status: "Success" },
    { time: "14:23:45", method: "BTC", amount: "+$150.00", status: "Success" },
    { time: "14:23:42", method: "USDT (TRC20)", amount: "+$50.00", status: "Success" },
  ],
};
