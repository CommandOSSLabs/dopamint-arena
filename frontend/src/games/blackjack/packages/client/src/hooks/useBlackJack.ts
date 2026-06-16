// app/src/hooks/useBlackJack.ts
import { useEffect, useState } from "react";
import { SuiClient, CoinStruct } from "@mysten/sui/client";
import { Transaction, TransactionObjectInput } from "@mysten/sui/transactions";
import {
  BlackJackGame,
  BlackJackGameManager,
  BlackJackMoveClient,
  GameBalance,
  queryAllEvents,
  queryAllDynamicFields,
  GameActionData,
  createGameActionData,
  actionMap,
  getEd25519PublicKey,
  ed25519SignMessage,
  getCardSum,
  drewCard,
} from "@poc/shared";
import { getCoinInput } from "@/lib/utils/getCoinInput";
import { useCustomWallet } from "@/contexts/CustomWallet";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromHEX, toHEX } from "@mysten/bcs";
import {
  addGameActionData,
  getGameActionData,
  getLatestGameActionData,
  updateGameActionData,
} from "@/lib/utils/indexedDB";
import { randomHex } from "@/lib/utils/randomHex";
import { useSuiClient } from "@mysten/dapp-kit";
import axios from "axios";
import { sign } from "@noble/bls12-381";
import toast from "react-hot-toast";
import { set } from "zod";
import { useBalance } from "@/contexts/BalanceContext";

const useBlackJack = () => {
  // dapp-kit's useSuiClient returns a SuiClient typed against its own (older)
  // bundled @mysten/sui. Reconcile it to the @mysten/sui version used by
  // @poc/shared (same package the client installs directly) at this boundary.
  const suiClient = useSuiClient() as unknown as SuiClient;
  const [isFetchingGame, setIsFetchingGame] = useState<boolean>(true);
  const [packageId, setPackageId] = useState<string>(
    import.meta.env.VITE_BLACK_JACK_PACKAGE_ID || ""
  );
  const [gameManagerId, setGameManagerId] = useState<string>(
    import.meta.env.VITE_BLACK_JACK_GAME_MANAGER_ID || ""
  );
  const [betAmount, setBetAmount] = useState<number>(0);
  const [newBetAmount, setNewBetAmount] = useState<number>(0);

  const [gameManager, setGameManager] = useState<BlackJackGameManager>();
  const [coinType, setCoinType] = useState<string>(
    import.meta.env.VITE_COIN_TYPE || ""
  );
  const [gameId, setGameId] = useState<string>("");
  const [playerBusted, setPlayerBusted] = useState<boolean>(false);
  const [dealerBusted, setDealerBusted] = useState<boolean>(false);
  const [winner, setWinner] = useState<"player" | "dealer" | "tie" | "">("");
  const [gameObjectCacheString, setGameObjectCacheString] =
    useState<string>("");
  const [gameObjectCacheBlsSignatureHex, setGameObjectCacheBlsSignatureHex] =
    useState<string>("");
  const [dealerBlsPublicKey, setDealerBlsPublicKey] = useState<string>("");
  const [playerEd25519PublicKey, setPlayerEd25519PublicKey] =
    useState<string>("");
  let { executeTransactionBlockWithoutSponsorship, address } =
    useCustomWallet();
  let [currentGameInfo, setCurrentGameInfo] = useState<
    | {
        currentGameActionDataHex: string;
        currentDealerBlsSignature: string;
      }
    | undefined
  >(undefined);

  const { userCoins } = useBalance();
  const [playerEd25519PrivateKey, setPlayerEd25519PrivateKey] =
    useState<string>("");
  const [gameDepositAmount, setGameDepositAmount] = useState<number>(0);
  const [balance, setBalance] = useState<GameBalance>({ player: 0, dealer: 0 });
  const [isStand, setIsStand] = useState<boolean>(false);
  const [canContinue, setCanContinue] = useState<boolean>(true);
  const [settleing, setSettleing] = useState<boolean>(false);
  const [isCreatingGame, setIsCreatingGame] = useState<boolean>(false);

  const [playerCards, setPlayerCards] = useState<number[]>([]);
  const [dealerCards, setDealerCards] = useState<number[]>([]);
  const [deckCards, setDeckCards] = useState<number[]>([]);
  const { refreshBalance } = useBalance();
  const [round, setRound] = useState<number>(0);
  const [step, setStep] = useState<number>(0);
  const playerCardsSum = getCardSum(playerCards);
  const dealerCardsSum = getCardSum(dealerCards);

  useEffect(() => {
    const savedBetAmount = parseFloat(
      localStorage.getItem("blackjack_bet_amount") || "0"
    );
    if (savedBetAmount !== betAmount) {
      if (betAmount !== 0) {
        localStorage.setItem("blackjack_bet_amount", betAmount.toString());
      } else {
        setBetAmount(savedBetAmount);
      }
    }
  }, [betAmount]);

  const handleGameInit = async (game: BlackJackGame) => {
    let gameActionDataHex: string = "",
      playerEd25519Signature: string = "",
      dealerBlsSignature: string = "";

    try {
      const latestGameData = await getLatestGameActionData(game.id);
      gameActionDataHex = latestGameData.gameActionDataHex;
      playerEd25519Signature = latestGameData.playerEd25519Signature;
      dealerBlsSignature = latestGameData.dealerBlsSignature;

      if (!gameActionDataHex) {
        throw new Error("gameActionDataHex is not found");
      } else if (!dealerBlsSignature && playerEd25519Signature) {
        const initData = await signAndUpdateGameInitData({
          gameActionDataHex,
          playerEd25519Signature,
          gameId: game.id,
        });
        gameActionDataHex = initData.gameActionDataHex;
        playerEd25519Signature = initData.playerEd25519Signature;
        dealerBlsSignature = initData.dealerBlsSignature;
      }
    } catch (e) {
      const createAndStoreGameInitDataResult = await createAndStoreGameInitData(
        game.id,
        game.deposit / 2,
        game.first_round_bet_amount
      );
      const initData = await signAndUpdateGameInitData(
        createAndStoreGameInitDataResult
      );
      gameActionDataHex = initData.gameActionDataHex;
      playerEd25519Signature = initData.playerEd25519Signature;
      dealerBlsSignature = initData.dealerBlsSignature;
    }

    return { gameActionDataHex, playerEd25519Signature, dealerBlsSignature };
  };

  useEffect(() => {
    const queryGameId = async () => {
      if (
        !isFetchingGame ||
        gameId ||
        !playerEd25519PrivateKey ||
        !gameManagerId
      ) {
        return;
      } else {
        const blackJackClient = new BlackJackMoveClient({
          blackJackPackageId: packageId,
          blackJackGameManagerId: gameManagerId,
          suiClient,
        });
        const ed25519PublicKey = getEd25519PublicKey(playerEd25519PrivateKey);

        let gameId = await blackJackClient.getGameIdByKey({ ed25519PublicKey });
        setGameId(gameId);
        if (!gameId) {
          setIsFetchingGame(false);
          return;
        }

        const game = await blackJackClient.getGame({ gameId });
        setDealerBlsPublicKey(game.dealer_bls_public_key);
        setPlayerEd25519PublicKey(game.player_ed25519_public_key);
        setGameDepositAmount(game.deposit);
        const { gameActionDataHex, dealerBlsSignature } = await handleGameInit(
          game
        );
        setIsFetchingGame(false);
        setCurrentGameInfo({
          currentGameActionDataHex: gameActionDataHex,
          currentDealerBlsSignature: dealerBlsSignature,
        });
      }
    };
    queryGameId();
  }, [gameManagerId, playerEd25519PrivateKey]);

  useEffect(() => {
    if (!currentGameInfo) return;
    const { currentGameActionDataHex, currentDealerBlsSignature } =
      currentGameInfo;
    const gameActionData = GameActionData.fromHex(currentGameActionDataHex);

    setBalance({
      player: parseInt(gameActionData.balance.player),
      dealer: parseInt(gameActionData.balance.dealer),
    });
    setRound(parseInt(gameActionData.round));
    setStep(parseInt(gameActionData.step));

    updateCurrentCards(currentGameActionDataHex, currentDealerBlsSignature);
  }, [currentGameInfo]);

  const calculateBalances = () => {
    let playerBalance = balance?.player;
    let dealerBalance = balance?.dealer;

    if (isStand) {
      if (winner === "player") {
        playerBalance += betAmount;
        dealerBalance -= betAmount;
      } else if (winner === "dealer") {
        playerBalance -= betAmount;
        dealerBalance += betAmount;
      }
    }
    playerBalance = playerBalance / 10 ** 9;
    dealerBalance = dealerBalance / 10 ** 9;
    return { playerBalance, dealerBalance };
  };

  const { playerBalance, dealerBalance } = calculateBalances();

  useEffect(() => {
    let amount = newBetAmount;
    if (playerBalance == 0 || dealerBalance == 0) {
      setCanContinue(false);
    } else {
      setCanContinue(true);
    }
    if (amount > playerBalance * 10 ** 9) {
      amount = playerBalance * 10 ** 9;
    }
    if (amount > dealerBalance * 10 ** 9) {
      amount = dealerBalance * 10 ** 9;
    }
    if (amount != newBetAmount) {
      setNewBetAmount(amount);
    }
  }, [newBetAmount, playerBalance, dealerBalance]);

  const updateCurrentCards = async (
    gameActionDataHex: string,
    dealerBlsSignature: string
  ) => {
    const gameActionData = GameActionData.fromHex(gameActionDataHex);
    let seed = dealerBlsSignature;
    let currentHands = gameActionData.current_hands;
    if (actionMap[gameActionData.action] == "ACTION_INIT") {
      seed = drewCard({
        for: "dealer",
        hands: currentHands,
        seed,
      });
      seed = drewCard({
        for: "player",
        hands: currentHands,
        seed,
      });
      drewCard({
        for: "player",
        hands: currentHands,
        seed,
      });
    } else if (actionMap[gameActionData.action] == "ACTION_HIT") {
      seed = drewCard({
        for: "player",
        hands: currentHands,
        seed,
      });
    } else if (actionMap[gameActionData.action] == "ACTION_STAND") {
      while (getCardSum(currentHands.dealer) < 17) {
        seed = drewCard({
          for: "dealer",
          hands: currentHands,
          seed,
        });
      }
    }
    const playerCards = currentHands.player;
    const dealerCards = currentHands.dealer;
    const deckCards = currentHands.deck;

    setPlayerCards(playerCards);
    setDealerCards(dealerCards);
    setDeckCards(deckCards);

    const playerSum = getCardSum(playerCards);
    const dealerSum = getCardSum(dealerCards);

    let isStand = false;
    if (playerSum > 21) {
      isStand = true;
      setPlayerBusted(true);
      setWinner("dealer");
    } else if (dealerSum > 21) {
      isStand = true;
      setDealerBusted(true);
      setWinner("player");
    } else if (gameActionData.action == 2) {
      isStand = true;
      if (playerSum > dealerSum) {
        setWinner("player");
      } else if (playerSum < dealerSum) {
        setWinner("dealer");
      } else {
        setWinner("tie");
      }
    } else {
      isStand = false;
      setPlayerBusted(false);
      setDealerBusted(false);
      setWinner("");
    }

    console.log("updateCurrentCards - playerSum:", playerSum, "dealerSum:", dealerSum, "action:", gameActionData.action, "isStand:", isStand);

    if (isStand) {
      setNewBetAmount(betAmount);
    }
    setIsStand(isStand);
  };

  useEffect(() => {
    if (playerEd25519PrivateKey) return;
    let key = localStorage.getItem("black_jack_ed25519_key");
    if (!key) {
      let keyPair = new Ed25519Keypair();
      key = keyPair.getSecretKey();
      localStorage.setItem("black_jack_ed25519_key", key);
    }
    setPlayerEd25519PrivateKey(key);
  }, [playerEd25519PrivateKey]);

  useEffect(() => {}, [gameManagerId, address]);

  const updateGameManager = async () => {
    const blackJackClient = new BlackJackMoveClient({
      blackJackPackageId: packageId,
      blackJackGameManagerId: gameManagerId,
      suiClient,
    });
    let gameManager = await blackJackClient.fetchGameManager({});
    setGameManager(gameManager);
  };

  useEffect(() => {
    let runAsync = async () => {
      await updateGameManager();
    };
    runAsync();
  }, [gameManagerId]);

  const depositFunds = async ({
    amount,
    coinType = import.meta.env.VITE_COIN_TYPE || "",
  }: {
    amount: number;
    coinType: string;
  }) => {
    const blackJackClient = new BlackJackMoveClient({
      blackJackPackageId: packageId,
      blackJackGameManagerId: gameManagerId,
      suiClient,
    });
    let tx = new Transaction();
    let coinInput = getCoinInput({
      tx,
      coinType,
      userCoins,
      amount,
    });
    blackJackClient.depositFunds({
      tx,
      deposit: coinInput,
      coinType,
    });
    const result = await executeTransactionBlockWithoutSponsorship({
      tx,
      options: {
        showEvents: true,
      },
    });
    refreshBalance();
    updateGameManager();
    return result;
  };

  const createGameManager = async ({
    coinType,
    amount,
  }: {
    coinType: string;
    amount: number;
  }) => {
    if (!address) return;
    let tx = new Transaction();
    let coinInput = getCoinInput({
      tx,
      coinType,
      userCoins,
      amount,
    });
    const blackJackClient = new BlackJackMoveClient({
      blackJackPackageId: import.meta.env.VITE_BLACK_JACK_PACKAGE_ID || "",
      suiClient,
    });
    blackJackClient.createGameManager({
      tx,
      dealer: address,
      bls_public_key: import.meta.env.VITE_BLS_PUBLIC_KEY || "",
      funding: coinInput,
      coinType,
    });
    const result = await executeTransactionBlockWithoutSponsorship({
      tx,
      options: {
        showEvents: true,
      },
    });
    result!.events!.forEach((event) => {
      if (
        event.type.startsWith(
          `${import.meta.env.VITE_BLACK_JACK_PACKAGE_ID}::black_jack::GameManagerCreatedEvent`
        )
      ) {
        setGameManagerId((event.parsedJson as any).id);
        setCoinType(coinType);
      }
    });
  };

  const createGame = async ({
    amount,
    betAmount,
    coinType,
  }: {
    coinType: string;
    amount: number;
    betAmount: number;
  }) => {
    setIsCreatingGame(true);
    try {
      let tx = new Transaction();
      let coinInput = getCoinInput({
        tx,
        coinType,
        userCoins,
        amount,
      });
      const blackJackClient = new BlackJackMoveClient({
        blackJackPackageId: import.meta.env.VITE_BLACK_JACK_PACKAGE_ID || "",
        suiClient,
      });
      blackJackClient.createGame({
        tx,
        deposit: coinInput,
        firstRoundBetAmount: betAmount,
        blackJackGameManagerId: gameManagerId,
        ed25519PublicKey: getEd25519PublicKey(playerEd25519PrivateKey),
        coinType,
      });
      const result = await executeTransactionBlockWithoutSponsorship({
        tx,
        options: {
          showEvents: true,
        },
      });
      let returnData = { gameId: "" };
      for (let event of result!.events!) {
        if (
          event.type.startsWith(
            `${import.meta.env.VITE_BLACK_JACK_PACKAGE_ID}::black_jack::GameCreatedEvent`
          )
        ) {
          const gameId = (event.parsedJson as any).id;
          setGameId(gameId);
          returnData.gameId = gameId;
          setBetAmount(betAmount);
          setBalance({
            player: amount,
            dealer: amount,
          });
          const { gameActionDataHex, playerEd25519Signature } =
            await createAndStoreGameInitData(gameId, amount, betAmount);
          await signAndUpdateGameInitData({
            gameActionDataHex,
            playerEd25519Signature,
            gameId,
          });
        }
      }
      return returnData;
    } catch (e) {
      throw e;
    } finally {
      setIsCreatingGame(false);
    }
  };

  async function createAndStoreGameInitData(
    gameId: string,
    balanceAmountEach: number,
    betAmount: number
  ) {
    let gameActionData = createGameActionData({
      game_id: gameId,
      balance: {
        player: balanceAmountEach,
        dealer: balanceAmountEach,
      },
      randomness_seed: randomHex(32),
      bet_amount: betAmount,
      round: 0,
      step: 0,
      action: 0,
      current_hands: {
        player: [],
        dealer: [],
        deck: Array.from({ length: 52 }, (v, i) => i),
      },
    });

    let playerEd25519Signature = await ed25519SignMessage(
      playerEd25519PrivateKey,
      gameActionData.toBytes()
    );

    const gameActionDataHex = gameActionData.toHex();

    const result = await addGameActionData({
      game_id: gameId,
      round: 0,
      step: 0,
      gameActionDataHex,
      playerEd25519Signature,
      dealerBlsSignature: "",
    });
    return {
      gameId,
      gameActionDataHex,
      playerEd25519Signature,
    };
  }

  async function sendDealerSignRequest({
    gameActionDataHex,
    playerEd25519Signature,
    previousGameActionDataHex,
    previousDealerBlsSignature,
  }: {
    gameActionDataHex: string;
    playerEd25519Signature: string;
    previousGameActionDataHex?: string;
    previousDealerBlsSignature?: string;
  }) {
    const result = await axios.post(`${import.meta.env.VITE_API_URL}/black_jack/dealer/sign`, {
      gameActionDataHex,
      playerEd25519Signature,
      previousGameActionDataHex,
      previousDealerBlsSignature,
      gameObjectCacheString: gameObjectCacheString || undefined,
      gameObjectCacheBlsSignatureHex:
        gameObjectCacheBlsSignatureHex || undefined,
    });
    console.log(result.data);
    setGameObjectCacheString(result.data.gameObjectCacheString);
    setGameObjectCacheBlsSignatureHex(
      result.data.gameObjectCacheBlsSignatureHex
    );
    return result.data;
  }

  async function signAndUpdateGameInitData({
    gameActionDataHex,
    playerEd25519Signature,
    gameId,
  }: {
    gameActionDataHex: string;
    playerEd25519Signature: string;
    gameId: string;
  }) {
    const { dealerBlsSignature } = await sendDealerSignRequest({
      gameActionDataHex,
      playerEd25519Signature,
    });
    const gameActionData = await updateGameActionData(
      {
        game_id: gameId,
        round: 0,
        step: 0,
      },
      {
        dealerBlsSignature,
      }
    );
    return gameActionData;
  }

  const action = async (action: "HIT" | "STAND" | "CONTINUE" | "SETTLE") => {
    if (!currentGameInfo) return;
    const { currentGameActionDataHex, currentDealerBlsSignature } =
      currentGameInfo;
    const currentGameActionData = GameActionData.fromHex(
      currentGameActionDataHex
    );
    if (action == "HIT") {
      const current_hands = {
        player: playerCards,
        dealer: dealerCards,
        deck: deckCards,
      };
      const nextGameActionData = createGameActionData({
        game_id: gameId,
        balance: balance,
        randomness_seed: toHEX(
          new Uint8Array(currentGameActionData.randomness_seed)
        ),
        bet_amount: betAmount,
        round: round,
        step: step + 1,
        action: 1, // 1 is Hit
        current_hands,
      });
      const playerEd25519Signature = await ed25519SignMessage(
        playerEd25519PrivateKey,
        nextGameActionData.toBytes()
      );
      const { dealerBlsSignature } = await sendDealerSignRequest({
        gameActionDataHex: nextGameActionData.toHex(),
        playerEd25519Signature,
        previousGameActionDataHex: currentGameActionDataHex,
        previousDealerBlsSignature: currentDealerBlsSignature,
      });
      await addGameActionData({
        game_id: gameId,
        round: round,
        step: step + 1,
        gameActionDataHex: nextGameActionData.toHex(),
        playerEd25519Signature,
        dealerBlsSignature,
      });
      setCurrentGameInfo({
        currentGameActionDataHex: nextGameActionData.toHex(),
        currentDealerBlsSignature: dealerBlsSignature,
      });
    } else if (action == "STAND") {
      const current_hands = {
        player: playerCards,
        dealer: dealerCards,
        deck: deckCards,
      };
      const nextGameActionData = createGameActionData({
        game_id: gameId,
        balance: balance,
        randomness_seed: toHEX(
          new Uint8Array(currentGameActionData.randomness_seed)
        ),
        bet_amount: betAmount,
        round: round,
        step: step + 1,
        action: 2, // 2 is Stand
        current_hands,
      });
      const playerEd25519Signature = await ed25519SignMessage(
        playerEd25519PrivateKey,
        nextGameActionData.toBytes()
      );
      const { dealerBlsSignature } = await sendDealerSignRequest({
        gameActionDataHex: nextGameActionData.toHex(),
        playerEd25519Signature,
        previousGameActionDataHex: currentGameActionDataHex,
        previousDealerBlsSignature: currentDealerBlsSignature,
      });
      await addGameActionData({
        game_id: gameId,
        round: round,
        step: step + 1,
        gameActionDataHex: nextGameActionData.toHex(),
        playerEd25519Signature,
        dealerBlsSignature,
      });
      setCurrentGameInfo({
        currentGameActionDataHex: nextGameActionData.toHex(),
        currentDealerBlsSignature: dealerBlsSignature,
      });
      // Logic for stand
    } else if (action == "CONTINUE") {
      // Logic for continue
      let newBalance = balance;
      if (winner == "player") {
        newBalance = {
          player: balance.player + betAmount,
          dealer: balance.dealer - betAmount,
        };
      } else if (winner == "dealer") {
        newBalance = {
          player: balance.player - betAmount,
          dealer: balance.dealer + betAmount,
        };
      }
      const nextGameActionData = createGameActionData({
        game_id: gameId,
        balance: newBalance,
        randomness_seed: toHEX(
          new Uint8Array(currentGameActionData.randomness_seed)
        ),
        bet_amount: (newBetAmount && newBetAmount) || betAmount,
        round: round + 1,
        step: 0,
        action: 0, // 0 is init, create new round
        current_hands: {
          player: [],
          dealer: [],
          deck: Array.from({ length: 52 }, (v, i) => i),
        },
      });
      const playerEd25519Signature = await ed25519SignMessage(
        playerEd25519PrivateKey,
        nextGameActionData.toBytes()
      );
      const { dealerBlsSignature } = await sendDealerSignRequest({
        gameActionDataHex: nextGameActionData.toHex(),
        playerEd25519Signature,
        previousGameActionDataHex: currentGameActionDataHex,
        previousDealerBlsSignature: currentDealerBlsSignature,
      });
      await addGameActionData({
        game_id: gameId,
        round: round + 1,
        step: 0,
        gameActionDataHex: nextGameActionData.toHex(),
        playerEd25519Signature,
        dealerBlsSignature,
      });
      setCurrentGameInfo({
        currentGameActionDataHex: nextGameActionData.toHex(),
        currentDealerBlsSignature: dealerBlsSignature,
      });
      if (newBetAmount) {
        setBetAmount(newBetAmount);
      }
    } else if (action == "SETTLE") {
      setSettleing(true);
      try {
        let outputBalance = { ...balance };
        if (winner == "player") {
          outputBalance.dealer -= betAmount;
          outputBalance.player += betAmount;
        } else if (winner == "dealer") {
          outputBalance.dealer += betAmount;
          outputBalance.player -= betAmount;
        }

        const nextGameActionData = createGameActionData({
          game_id: gameId,
          balance: outputBalance,
          randomness_seed: toHEX(
            new Uint8Array(currentGameActionData.randomness_seed)
          ),
          bet_amount: betAmount,
          round: round,
          step: step + 1,
          action: 3, // 3 is settle
          current_hands: {
            player: playerCards,
            dealer: dealerCards,
            deck: deckCards,
          },
        });
        const playerEd25519Signature = await ed25519SignMessage(
          playerEd25519PrivateKey,
          nextGameActionData.toBytes()
        );
        const { dealerBlsSignature } = await sendDealerSignRequest({
          gameActionDataHex: nextGameActionData.toHex(),
          playerEd25519Signature,
          previousGameActionDataHex: currentGameActionDataHex,
          previousDealerBlsSignature: currentDealerBlsSignature,
        });
        const blackJackClient = new BlackJackMoveClient({
          blackJackPackageId: packageId,
          blackJackGameManagerId: gameManagerId,
          suiClient,
        });
        const tx = new Transaction();
        const currentHands = blackJackClient.create_hands({
          tx,
          player: playerCards,
          dealer: dealerCards,
          deck: deckCards,
        });
        const partyBalance = blackJackClient.create_party_balance({
          tx,
          player: outputBalance.player,
          dealer: outputBalance.dealer,
        });

        const gameActionData = blackJackClient.create_game_action_data({
          tx,
          game_id: gameId,
          balance: partyBalance,
          randomness_seed: toHEX(
            new Uint8Array(nextGameActionData.parse().randomness_seed)
          ),
          bet_amount: betAmount,
          round: round,
          step: step + 1,
          action: 3,
          current_hands: currentHands,
        });

        blackJackClient.settle_game({
          tx,
          gameActionData,
          playerEd25519Signature,
          dealerBlsSignature,
          coinType,
        });

        const res = await executeTransactionBlockWithoutSponsorship({
          tx,
          options: {
            showEvents: true,
          },
        });
        window.location.reload();
      } catch (e: any) {
        setSettleing(false);
        toast.error(e.message);
        throw e;
      }

      // await addGameActionData({
      //   game_id: gameId,
      //   round: round,
      //   step: step + 1,
      //   gameActionDataHex: nextGameActionData.toHex(),
      //   playerEd25519Signature,
      //   dealerBlsSignature: result.data.dealerBlsSignature,
      // });
      // move call to settle the transaction and delete the game
    }
  };

  return {
    action,
    createGameManager,
    createGame,
    gameManagerId,
    gameManager,
    setGameManagerId,
    depositFunds,
    gameId,
    betAmount,
    coinType,
    gameDepositAmount,
    playerBalance,
    dealerBalance,
    isFetchingGame,
    isStand,
    setIsStand,
    playerCards,
    dealerCards,
    deckCards,
    playerCardsSum,
    dealerCardsSum,
    round,
    step,
    playerBusted,
    dealerBusted,
    winner,
    newBetAmount,
    setNewBetAmount,
    canContinue,
    settleing,
    isCreatingGame,
  };
};

export default useBlackJack;
