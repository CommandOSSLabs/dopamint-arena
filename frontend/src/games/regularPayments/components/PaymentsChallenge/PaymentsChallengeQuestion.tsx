import { formatAddress } from "@mysten/sui/utils";
import { PaymentsChallengeResultProps } from ".";

interface PaymentsChallengeQuestionProps {
  currentPuzzle: PaymentsChallengeResultProps["currentPuzzle"];
}

export default function PaymentsChallengeQuestion({
  currentPuzzle,
}: PaymentsChallengeQuestionProps) {
  if (!currentPuzzle) return null;

  const renderQuestion = () => {
    switch (currentPuzzle.questionType) {
      case "totalGas":
        return "What is the total gas used in this digest:";

      case "timestamp":
        return "What is the timestamp of this digest:";

      default:
        return "Unknown question";
    }
  };

  return (
    <div className="text-sm break-all">
      {renderQuestion()}&nbsp;
      <a
        target="_blank"
        href={`https://testnet.suivision.xyz/txblock/${currentPuzzle.tx.digest}`}
        className="font-mono text-xs text-blue-600 hover:underline"
      >
        {formatAddress(currentPuzzle.tx.digest)}
      </a>
    </div>
  );
}
