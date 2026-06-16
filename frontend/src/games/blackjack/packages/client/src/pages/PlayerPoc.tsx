import React from "react";
import { OwnedObjectsGrid } from "@/components/general/OwnedObjectsGrid";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  deriveWalletFromPrivateKey,
  createGameActionData,
  createGameInitData,
  deriveRandomU8InRange,
  drewCard,
  getCardSum,
  BlackJackMoveClient,
} from "@poc/shared";
import {
  getPublicKey as getBlsPublicKey,
  sign as blsSign,
  utils as blsUtils,
  verify as blsVerify,
} from "@noble/bls12-381";
import { fromHEX, toHEX } from "@mysten/bcs";
import { Transaction } from "@mysten/sui/transactions";

import { useCustomWallet } from "@/contexts/CustomWallet";
import { useSuiClient } from "@mysten/dapp-kit";
import { SuiClient } from "@mysten/sui/client";

export default function PlayerPoc() {
  // Reconcile dapp-kit's SuiClient type to the @mysten/sui version used by
  // @poc/shared (BlackJackMoveClient) at this boundary.
  const suiClient = useSuiClient() as unknown as SuiClient;
  const { executeTransactionBlockWithoutSponsorship, address } =
    useCustomWallet();
  if (!address) return <div>Not Logged In</div>;
  const playerKey =
    "suiprivkey1qzh3x0mwj0h67v5d7lqulvtc6m2hm603w9qhvgjvnhgehqj6c9hk7adjs0j";
  const blsKey =
    "30458b7f95b92dee040ba1a0f4451ef151e72cc431a7c351c6972b8a1654f1f3";

  // let bytes = blsUtils.hexToBytes(blsKey);
  // console.log(
  //   bytes,
  //   toHEX(bytes),
  //   blsUtils.bytesToHex(bytes),
  //   toHEX(bytes) == blsUtils.bytesToHex(bytes)
  // );

  const signMessageD = async (
    ed25519PrivateKey: string,
    message: Uint8Array
  ) => {
    const keyPair = deriveWalletFromPrivateKey(ed25519PrivateKey);
    return keyPair.sign(message);
  };

  let signMessage = async () => {
    console.log("Player Sign");
    const keyPair = deriveWalletFromPrivateKey(playerKey);

    let gameActionData = createGameActionData({
      game_id:
        "90c5264c9da2b340fdc9fbd15ad3f0a181a57afa7ae55b15a3c5dce6b31f45c8",
      balance: {
        player: 100,
        dealer: 100,
      },
      randomness_seed: "868f",
      bet_amount: 5,
      round: 0,
      step: 0,
      action: 0,
      current_hands: {
        player: [],
        dealer: [],
        deck: Array.from({ length: 52 }, (v, i) => i),
      },
    });

    const ED25519Signature = await keyPair.sign(gameActionData.toBytes());
    const ED25519PublicKey = keyPair.getPublicKey();
    const ED25519Address = ED25519PublicKey.toSuiAddress();
    const ED25519Hex = toHEX(ED25519PublicKey.toRawBytes());
    const ED25519Bytes = ED25519PublicKey.toRawBytes();
    const ED25519SuiBytesHex = toHEX(ED25519PublicKey.toSuiBytes());
    console.log({
      ED25519Address,
      ED25519Bytes,
      ED25519Hex,
      ED25519SuiBytesHex,
    });
    const validSignature = await keyPair
      .getPublicKey()
      .verify(gameActionData.toBytes(), ED25519Signature);
    console.log({
      validSignature,
      ED25519Signature,
    });
    const blsSignature = await blsSign(gameActionData.toBytes(), blsKey);
    const BlsPublicKey = getBlsPublicKey(fromHEX(blsKey));
    const validBlsSignature = await blsVerify(
      blsSignature,
      gameActionData.toBytes(),
      BlsPublicKey
    );
    console.log({
      validBlsSignature,
      ED25519PublicKey: ED25519PublicKey,
      blsPublicKey: toHEX(BlsPublicKey),
      ED25519Signature: toHEX(ED25519Signature),
      blsSignature: toHEX(blsSignature),
      gameInitData: toHEX(gameActionData.toBytes()),
    });

    // console.log(gameInitData.toHex());
    // con sole.log(
    //   "0x90c5264c9da2b340fdc9fbd15ad3f0a181a57afa7ae55b15a3c5dce6b31f45c86400000000000000640000000000000030868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af3105000000000000000000000000000000000000000000000000"
    // );
    // let bytes = gameInitData.toBytes();
    // // 0x0::black_jack::GameInitData {
    // //   game_id: 0x2::object::ID {
    // //     bytes: @0x90c5264c9da2b340fdc9fbd15ad3f0a181a57afa7ae55b15a3c5dce6b31f45c8
    // //   },
    // //   balance: 0x0::black_jack::PartyBalance {
    // //     player: 100,
    // //     dealer: 100
    // //   },
    // //   randomness_seed: 0x868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af31,
    // //   bet_amount: 5,
    // //   round: 0,
    // //   step: 0,
    // //   action: 0
    // // }
    // console.log(
    //   gameInitData.toHex() ==
    //     "90c5264c9da2b340fdc9fbd15ad3f0a181a57afa7ae55b15a3c5dce6b31f45c86400000000000000640000000000000030868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af3105000000000000000000000000000000000000000000000000"
    // );

    // //   public struct partyBalance {
    // //     player: u64,
    // //     dealer: u64,
    // // }

    // // public struct GameInitData {
    // //     game_id: ID,
    // //     balance: partyBalance,
    // //     randomness_seed: vector<u8>,
    // //     bet_amount: u64,
    // //     round: u64,
    // //     step: u64,
    // //     action: u8,
    // // }
    // bcs.struct;
  };

  let signFirstAction = async () => {
    console.log("Player Sign");
    const keyPair = deriveWalletFromPrivateKey(playerKey);
    let default_balance = {
      player: 100,
      dealer: 100,
    };

    let previousGameActionData = createGameActionData({
      game_id:
        "90c5264c9da2b340fdc9fbd15ad3f0a181a57afa7ae55b15a3c5dce6b31f45c8",
      balance: default_balance,
      randomness_seed: "868f",
      bet_amount: 5,
      round: 0,
      step: 0,
      action: 0,
      current_hands: {
        player: [],
        dealer: [],
        deck: Array.from({ length: 52 }, (v, i) => i),
      },
    });

    const ED25519Signature = await keyPair.sign(
      previousGameActionData.toBytes()
    );
    const ED25519PublicKey = await keyPair.getPublicKey();
    const ED25519Address = ED25519PublicKey.toSuiAddress();
    const ED25519Hex = toHEX(ED25519PublicKey.toRawBytes());
    const ED25519Bytes = ED25519PublicKey.toRawBytes();
    const ED25519SuiBytesHex = toHEX(ED25519PublicKey.toSuiBytes());

    const validSignature = await keyPair
      .getPublicKey()
      .verify(previousGameActionData.toBytes(), ED25519Signature);

    const blsSignature = await blsSign(
      previousGameActionData.toBytes(),
      blsKey
    );
    const BlsPublicKey = getBlsPublicKey(fromHEX(blsKey));
    const validBlsSignature = await blsVerify(
      blsSignature,
      previousGameActionData.toBytes(),
      BlsPublicKey
    );

    let seed = toHEX(blsSignature);
    console.log({ seed });
    let current_hands = previousGameActionData.parse().current_hands;
    console.log({ ...current_hands });
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
    let player_sum = getCardSum(current_hands.player);
    let dealer_sum = getCardSum(current_hands.dealer);
    console.log(
      toHEX(Uint8Array.from(previousGameActionData.parse().randomness_seed))
    );
    let gameActionData = createGameActionData({
      game_id: previousGameActionData.parse().game_id,
      balance: default_balance,
      randomness_seed: toHEX(
        Uint8Array.from(previousGameActionData.parse().randomness_seed)
      ),
      bet_amount: Number(previousGameActionData.parse().bet_amount),
      round: Number(previousGameActionData.parse().round),
      step: Number(previousGameActionData.parse().step) + 1,
      action: 1,
      current_hands: current_hands,
    });
    console.log({ current_hands });

    let gameActionDataEd25519Signature = await keyPair.sign(
      gameActionData.toBytes()
    );
    let gameActionDataBlsSignature = await blsSign(
      gameActionData.toBytes(),
      blsKey
    );
    console.log({
      gameActionDataEd25519Signature: toHEX(gameActionDataEd25519Signature),
      gameActionDataBlsSignature: toHEX(gameActionDataBlsSignature),
    });
  };

  let createGameManager = async () => {
    let tx = new Transaction();
    let coinInput = tx.splitCoins(tx.gas, [tx.pure.u64(0.1 * 10 ** 9)]);
    let blackJack = new BlackJackMoveClient({
      blackJackPackageId: import.meta.env.VITE_BLACK_JACK_PACKAGE_ID || "",
      suiClient,
    });
    blackJack.createGameManager({
      tx,
      dealer: address,
      bls_public_key: import.meta.env.VITE_BLS_PUBLIC_KEY || "",
      funding: coinInput,
      coinType: import.meta.env.VITE_COIN_TYPE as string,
    });
    await executeTransactionBlockWithoutSponsorship({
      tx,
      options: {
        showEffects: true,
        showObjectChanges: true,
      },
    });
  };

  return (
    <div>
      <button
        className="mx-2 bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        onClick={() => {
          signMessage();
        }}
      >
        Player Sign
      </button>
      <button
        className="mx-2 bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        onClick={() => {
          signFirstAction();
        }}
      >
        Sign First Action
      </button>
      <button
        className="mx-2 mt-2 bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        onClick={() => {
          createGameManager();
        }}
      >
        Create Game Manager
      </button>
    </div>
  );
}
