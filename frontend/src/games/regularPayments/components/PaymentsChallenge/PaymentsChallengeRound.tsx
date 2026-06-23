import React, { useImperativeHandle } from "react";
import { PaymentsChallengePuzzleProps, PaymentsChallengeResultProps } from ".";

export interface PaymentsChallengeRoundHandle {
  nextPuzzle: () => void;
  generatePuzzle: (puzzles: PaymentsChallengePuzzleProps[]) => void;
}

interface PaymentsChallengeRoundProps {
  result: PaymentsChallengeResultProps;
  setResult: React.Dispatch<React.SetStateAction<PaymentsChallengeResultProps>>;
}

const PaymentsChallengeRound = React.forwardRef(
  ({ result, setResult }: PaymentsChallengeRoundProps, ref) => {
    const generateAnswers = (
      puzzles: PaymentsChallengePuzzleProps[],
      randomQuestion: Omit<
        NonNullable<PaymentsChallengeResultProps["currentPuzzle"]>,
        "answers"
      >,
    ) => {
      const labels = ["A", "B", "C", "D"] as const;
      let correctValue: string;
      let wrongValues: string[] = [];

      switch (randomQuestion.questionType) {
        case "totalGas": {
          const gas = randomQuestion.tx.totalGas;
          correctValue = String(gas);
          const baseModifier = Math.floor(500 + Math.random() * 1000);
          const sign = Math.random() > 0.5 ? 1 : -1;
          wrongValues = [1, 2, 3].map((multiplier) => {
            const offset = baseModifier * multiplier * sign;
            const calculated = gas + offset;
            return String(
              calculated <= 0 ? Math.abs(calculated) + multiplier : calculated,
            );
          });
          break;
        }
        case "timestamp": {
          const timestamp = randomQuestion.tx.timestamp;
          correctValue = String(timestamp);
          const txDistractors = puzzles
            .filter((tx) => tx.timestamp !== timestamp)
            .sort(() => Math.random() - 0.5)
            .slice(0, 3)
            .map((tx) => String(tx.timestamp));
          const generatedDistractors = Array.from({ length: 3 }, () => {
            const delta =
              (15 + Math.floor(Math.random() * 885)) *
              1000 *
              (Math.random() > 0.5 ? 1 : -1);
            return String(timestamp + delta);
          });
          wrongValues = [...txDistractors, ...generatedDistractors];
          break;
        }
        default:
          return [];
      }

      const uniqueWrongValues = [...new Set(wrongValues)].filter(
        (v) => v !== correctValue,
      );
      const selectedWrongValues = uniqueWrongValues
        .sort(() => Math.random() - 0.5)
        .slice(0, 3);
      return [correctValue, ...selectedWrongValues]
        .sort(() => Math.random() - 0.5)
        .map((value, i) => ({
          label: labels[i],
          value,
          correct: value === correctValue,
        }));
    };

    const generatePuzzle = (puzzles: PaymentsChallengePuzzleProps[]) => {
      const questionTypes = ["totalGas", "timestamp"] as const;
      const availableQuestions = puzzles
        .flatMap((tx, puzzleIndex) =>
          questionTypes.map((questionType) => ({
            tx,
            puzzleIndex,
            questionType,
            key: `${puzzleIndex}-${questionType}`,
          })),
        )
        .filter((question) => !result.usedPuzzles.has(question.key));

      const randomQuestion =
        availableQuestions[
          Math.floor(Math.random() * availableQuestions.length)
        ];
      const randomAnswers = generateAnswers(puzzles, randomQuestion);
      return { randomQuestion, randomAnswers, puzzles };
    };

    const nextPuzzle = ({
      randomAnswers,
      randomQuestion,
    }: ReturnType<typeof generatePuzzle>) => {
      setResult((prev) => {
        const nextUsed = new Set(prev.usedPuzzles);
        nextUsed.add(randomQuestion.key);
        return {
          round: prev.round + 1,
          usedPuzzles: nextUsed,
          currentPuzzle: { ...randomQuestion, answers: randomAnswers },
        };
      });
    };

    useImperativeHandle(ref, () => {
      return {
        nextPuzzle,
        generatePuzzle,
      };
    }, []);

    return (
      <div className="text-xs font-mono uppercase tracking-widest">
        Round:&nbsp;
        <span className="text-arena-muted">{result.round}/10</span>
      </div>
    );
  },
);

export default PaymentsChallengeRound;
