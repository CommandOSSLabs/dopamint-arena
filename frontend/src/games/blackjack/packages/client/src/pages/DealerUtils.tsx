import React, { useEffect } from "react";
import { OwnedObjectsGrid } from "@/components/general/OwnedObjectsGrid";
import { Transaction } from "@mysten/sui/transactions";
import { BlackJackMoveClient } from "@poc/shared";
import { useCustomWallet } from "@/contexts/CustomWallet";
import { useSuiClient } from "@mysten/dapp-kit";
import { getCoinInput } from "@/lib/utils/getCoinInput";
import useBlackJack from "@/hooks/useBlackJack";

export default function DealerUtils() {
  const suiClient = useSuiClient();
  const { executeTransactionBlockWithoutSponsorship, address } =
    useCustomWallet();

  const { createGameManager, createGame } = useBlackJack();

  const handleCreateGameManager = async () => {
    createGameManager({
      coinType: import.meta.env.VITE_COIN_TYPE as string,
      amount: 0.1 * 10 ** 9,
    });
  };
  const handleCreateGame = async () => {
    // createGame({
    //   amount: 0.01 * 10 ** 9,
    // });
  };

  if (!address) return <div>Not Logged In</div>;

  return (
    <div>
      <button
        className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        onClick={() => handleCreateGameManager}
      >
        Create Game Manager
      </button>
      <button
        className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        onClick={() => handleCreateGame()}
      >
        Create Game
      </button>
    </div>
  );
}
