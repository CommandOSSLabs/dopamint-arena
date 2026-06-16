import { json } from "../router";
import { serverConfig } from "../serverConfig";
import { saveGameActionData, getGameActionData } from "../prisma";
import { SuiClient } from "@mysten/sui/client";
import { fromHEX, toHEX } from "@mysten/bcs";
import {
  getEd25519PublicKey,
  verifyEd25519Signature,
  BlackJackGame,
  BlackJackMoveClient,
  createGameActionData,
  GameActionData,
  GameActionDataToBytes,
  GameActionDataType,
  generateBlsSignature,
  actionMap,
  drewCard,
  getCardSum,
} from "@poc/shared";
import {
  getPublicKey as getBlsPublicKey,
  sign as blsSign,
  utils as blsUtils,
  verify as blsVerify,
} from "@noble/bls12-381";

export const blackjackSign = async (request: Request) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let suiClient = new SuiClient({
    // url: getFullnodeUrl(
    //   process.env.NEXT_PUBLIC_SUI_NETWORK_NAME || ("devnet" as any)
    // ),
    url: serverConfig.SUI_NETWORK || "",
  });

  const blackJackClient = new BlackJackMoveClient({
    blackJackPackageId: serverConfig.BLACK_JACK_PACKAGE_ID,
    blackJackGameManagerId: serverConfig.BLACK_JACK_GAME_MANAGER_ID,
    suiClient,
  });

  const {
    previousGameActionDataHex,
    previousDealerBlsSignature,
    gameActionDataHex,
    playerEd25519Signature,
    gameObjectCacheString,
    gameObjectCacheBlsSignatureHex,
  } = (await request.json()) as {
    previousGameActionDataHex?: string;
    previousDealerBlsSignature?: string;
    gameActionDataHex: string;
    playerEd25519Signature: string;
    gameObjectCacheString?: string;
    gameObjectCacheBlsSignatureHex?: string;
  };

  if (!gameActionDataHex || !playerEd25519Signature) {
    return json({ error: "Missing parameters" }, 400);
  }

  const gameActionData = GameActionData.fromHex(gameActionDataHex);
  let game: BlackJackGame | undefined;
  let outputGameObjectCacheString, outputGameObjectCacheBlsSignatureHex;

  if (gameObjectCacheString && gameObjectCacheBlsSignatureHex) {
    const validGameObjectSignature = await blsVerify(
      fromHEX(gameObjectCacheBlsSignatureHex),
      new TextEncoder().encode(gameObjectCacheString),
      serverConfig.BLS_PUBLIC_KEY as string
    );
    if (validGameObjectSignature) {
      game = JSON.parse(gameObjectCacheString);
    }
    outputGameObjectCacheString = gameObjectCacheString;
    outputGameObjectCacheBlsSignatureHex = gameObjectCacheBlsSignatureHex;
  }
  if (!game) {
    game = await blackJackClient.getGame({
      gameId: gameActionData.game_id,
    });
    outputGameObjectCacheString = JSON.stringify(game);
    const outputGameObjectCacheBlsSignature = await blsSign(
      new TextEncoder().encode(outputGameObjectCacheString),
      serverConfig.BLS_PRIVATE_KEY as string
    );
    outputGameObjectCacheBlsSignatureHex = toHEX(
      outputGameObjectCacheBlsSignature
    );
  }

  // Retrieve player's public key from the game action data or session (depending on your logic)
  const playerEd25519PublicKey = game.player_ed25519_public_key;

  // Verify the player's signature
  const isSignatureValid = await verifyEd25519Signature(
    playerEd25519PublicKey,
    gameActionDataHex,
    playerEd25519Signature
  );

  if (!isSignatureValid) {
    console.error("Invalid signature");
    return json({ error: "Invalid signature" }, 400);
  }

  let previousGameActiondata;
  let isPreviousGameActionDataValid = false;

  if (previousGameActionDataHex) {
    previousGameActiondata = GameActionData.fromHex(previousGameActionDataHex);

    isPreviousGameActionDataValid = await blsVerify(
      previousDealerBlsSignature!,
      GameActionDataToBytes(previousGameActiondata),
      serverConfig.BLS_PUBLIC_KEY as string
    );

    if (!isPreviousGameActionDataValid) {
      console.error("Invalid previous game action data signature");
      return json(
        { error: "Invalid previous game action data signature" },
        400
      );
    }

    // verify the step from previousGameActionDataHex is the same as the current step - 1
  }

  // verify the gameActionData.game_id is on chain and have the same data

  // check backend that this round and this step is not submitted before
  // if submitted, ensure the data hex is the same
  let gameActionDatas = await getGameActionData({
    gameId: gameActionData.game_id,
    round: BigInt(gameActionData.round),
    step: BigInt(gameActionData.step),
  });
  for (let gameActionDataInDb of gameActionDatas) {
    if (gameActionDataInDb.hex != gameActionDataHex) {
      console.error(
        "Game action data already submitted but you submit a different one"
      );
      return json(
        {
          error:
            "Game action data already submitted but you submit a different one",
        },
        400
      );
    }
  }
  if (previousGameActiondata) {
    let seed: string | Uint8Array = previousDealerBlsSignature!;
    let current_hands = previousGameActiondata.current_hands;

    if (actionMap[previousGameActiondata.action] == "ACTION_INIT") {
      if (
        !["ACTION_STAND", "ACTION_HIT"].includes(
          actionMap[gameActionData.action]
        )
      ) {
        console.error("Invalid action");
        return json({ error: "Invalid action" }, 400);
      }
      seed = drewCard({
        for: "dealer",
        hands: current_hands,
        seed,
      });
      seed = drewCard({
        for: "player",
        hands: current_hands,
        seed,
      });
      seed = drewCard({
        for: "player",
        hands: current_hands,
        seed,
      });
      if (
        JSON.stringify(current_hands) !=
        JSON.stringify(gameActionData.current_hands)
      ) {
        console.error("Invalid game action data hands");
        return json(
          { error: "Invalid game action data hands" },
          400
        );
      }
    } else if (actionMap[previousGameActiondata.action] == "ACTION_HIT") {
      seed = drewCard({
        for: "player",
        hands: current_hands,
        seed,
      });
      if (
        ["ACTION_STAND", "ACTION_HIT"].includes(
          actionMap[gameActionData.action]
        )
      ) {
        if (
          JSON.stringify(current_hands) !=
          JSON.stringify(gameActionData.current_hands)
        ) {
          console.error("Invalid game action data hands");
          return json(
            { error: "Invalid game action data hands" },
            400
          );
        }
        if (
          getCardSum(current_hands.player) > 21 ||
          getCardSum(current_hands.dealer) > 21
        ) {
          return json(
            { error: "Invalid game action data hands" },
            400
          );
        }
      } else if (
        ["ACTION_INIT", "ACTION_SETTLE"].includes(
          actionMap[gameActionData.action]
        )
      ) {
        if (getCardSum(current_hands.player) < 21) {
          console.error("Invalid action");
          return json(
            { error: "Invalid action" },
            400
          );
        }
        let previous_bet_amount = previousGameActiondata.bet_amount;
        let new_balance = { ...previousGameActiondata.balance };
        new_balance.dealer = String(
          Number(new_balance.dealer) + Number(previous_bet_amount)
        );
        new_balance.player = String(
          Number(new_balance.player) - Number(previous_bet_amount)
        );
        if (
          JSON.stringify(new_balance) != JSON.stringify(gameActionData.balance)
        ) {
          console.error("Invalid game action data balance");
          return json(
            { error: "Invalid game action data balance" },
            400
          );
        }
        if (actionMap[gameActionData.action] == "ACTION_INIT") {
          if (
            Number(previousGameActiondata.round) + 1 !=
              Number(gameActionData.round) ||
            gameActionData.step != "0" ||
            Number(new_balance.player) < Number(gameActionData.bet_amount)
          ) {
            return json(
              { error: "Invalid game action data" },
              400
            );
          }
        }
      } else {
        console.error("Invalid action");
        return json({ error: "Invalid action" }, 400);
      }
    } else if (actionMap[previousGameActiondata.action] == "ACTION_STAND") {
      if (
        !["ACTION_INIT", "ACTION_SETTLE"].includes(
          actionMap[gameActionData.action]
        )
      ) {
        return json({ error: "Invalid action" }, 400);
      }
      while (getCardSum(current_hands.dealer) < 17) {
        seed = drewCard({
          for: "dealer",
          hands: current_hands,
          seed,
        });
      }
      let previous_bet_amount = previousGameActiondata.bet_amount;
      let new_balance = { ...previousGameActiondata.balance };
      if (
        getCardSum(current_hands.dealer) > 21 ||
        getCardSum(current_hands.dealer) < getCardSum(current_hands.player)
      ) {
        new_balance.dealer = String(
          Number(new_balance.dealer) - Number(previous_bet_amount)
        );
        new_balance.player = String(
          Number(new_balance.player) + Number(previous_bet_amount)
        );
      } else if (
        getCardSum(current_hands.dealer) > getCardSum(current_hands.player)
      ) {
        new_balance.dealer = String(
          Number(new_balance.dealer) + Number(previous_bet_amount)
        );
        new_balance.player = String(
          Number(new_balance.player) - Number(previous_bet_amount)
        );
      }
      if (
        JSON.stringify(new_balance) != JSON.stringify(gameActionData.balance)
      ) {
        console.error("Invalid game action data balance");
        return json(
          { error: "Invalid game action data balance" },
          400
        );
      }
      if (actionMap[gameActionData.action] == "ACTION_INIT") {
        if (
          Number(previousGameActiondata.round) + 1 !=
            Number(gameActionData.round) ||
          gameActionData.step != "0" ||
          Number(new_balance.player) < Number(gameActionData.bet_amount)
        ) {
          return json(
            { error: "Invalid game action data" },
            400
          );
        }
      }
    }
  } else if (
    actionMap[gameActionData.action] == "ACTION_INIT" &&
    gameActionData.round == "0"
  ) {
    ("Good to go as it is the first round");
  } else {
    console.error("Invalid action");
    return json({ error: "Invalid action" }, 400);
  }

  // Generate the dealer's BLS signature
  const dealerBlsSignature = await generateBlsSignature(
    gameActionDataHex,
    serverConfig.BLS_PRIVATE_KEY || ""
  );

  saveGameActionData(
    gameActionDataHex,
    playerEd25519Signature,
    dealerBlsSignature
  ).then(() => {});

  // Return the dealer's BLS signature
  return json(
    {
      dealerBlsSignature: dealerBlsSignature,
      gameObjectCacheString: outputGameObjectCacheString,
      gameObjectCacheBlsSignatureHex: outputGameObjectCacheBlsSignatureHex,
    },
    200
  );
};
