// lib/BlackJackMoveClient.ts
import { bcs, toHEX, fromHEX } from "@mysten/bcs";
import { SuiClient, CoinStruct } from "@mysten/sui/client";
import { TransactionObjectInput, Transaction } from "@mysten/sui/transactions";
import {
  queryAllDynamicFields,
  queryAllEvents,
} from "./utils/queryAllEvents";

export interface BlackJackGameManager {
  id: string;
  dealer: string;
  bls_public_key: string;
  balance: number;
}

export interface GameBalance {
  player: number;
  dealer: number;
}

export interface BlackJackGame {
  id: string;
  deposit: number;
  first_round_bet_amount: number;
  player: string;
  player_ed25519_public_key: string;
  dealer_bls_public_key: string;
}

export class BlackJackMoveClient {
  private playerPrivateKey: string = "";
  private playerPublicKey: string = "";

  private dealerPrivateKey: string = "";
  private dealerPublicKey: string = "";

  private blackJackPackageId: string;
  private blackJackGameManagerId: string;
  private blackJackGameId: string;
  private suiClient: SuiClient;

  constructor({
    blackJackPackageId,
    blackJackGameManagerId,
    blackJackGameId,
    suiClient,
  }: {
    blackJackPackageId?: string;
    blackJackGameManagerId?: string;
    blackJackGameId?: string;
    suiClient: SuiClient;
  }) {
    this.blackJackPackageId = blackJackPackageId || "";
    this.blackJackGameManagerId = blackJackGameManagerId || "";
    this.blackJackGameId = blackJackGameId || "";
    this.suiClient = suiClient;
  }

  async getGameIdByKey({
    gameManagerId = this.blackJackGameManagerId,
    ed25519PublicKey,
  }: {
    gameManagerId?: string;
    ed25519PublicKey: string;
  }) {
    const gameManager = await this.suiClient.getObject({
      id: gameManagerId,
      options: {
        showContent: true,
      },
    });
    let player_key_game_table_id = (gameManager.data?.content as any).fields
      .player_key_game_table.fields.id.id;
    let player_key_game_table_content =
      await this.suiClient.getDynamicFieldObject({
        parentId: player_key_game_table_id,
        name: {
          type: "vector<u8>",
          value: Array.from(fromHEX(ed25519PublicKey)),
        },
      });
    let gameId = (player_key_game_table_content as any).data?.content.fields
      .value;
    return gameId;
  }

  async getGame({
    gameId = this.blackJackGameId,
  }: {
    gameId?: string;
  }): Promise<BlackJackGame> {
    const game = await this.suiClient.getObject({
      id: gameId,
      options: {
        showContent: true,
      },
    });
    const fields = (game.data as any).content.fields;
    const tunnel = (game.data as any).content.fields.tunnel.fields;
    return {
      id: fields.id.id,
      deposit: tunnel.deposit as number,
      first_round_bet_amount:
        tunnel.initial_panalty_amount_for_inactive as number,
      player: fields.player,
      player_ed25519_public_key: toHEX(tunnel.partyA_public_key),
      dealer_bls_public_key: toHEX(tunnel.partyB_public_key),
    };
  }

  async fetchGameManager({
    blackJackGameManagerId,
  }: {
    blackJackGameManagerId?: string;
  }): Promise<BlackJackGameManager> {
    const gameManagerObject = await this.suiClient.getObject({
      id: blackJackGameManagerId || this.blackJackGameManagerId,
      options: {
        showContent: true,
      },
    });
    const fields = (gameManagerObject.data as any).content.fields;
    return {
      id: fields.id.id,
      dealer: fields.dealer,
      bls_public_key: toHEX(fields.bls_public_key),
      balance: fields.balance as number,
    };
  }

  async findGameManagers({}: {}) {
    const gameManagerCreatedEvents = await queryAllEvents({
      suiClient: this.suiClient,
      query: {
        MoveEventType: `${this.blackJackPackageId}::black_jack::GameManagerCreatedEvent`,
      },
    });
    const gameMangerIds = gameManagerCreatedEvents.map((event) => {
      return (event.parsedJson as any).id;
    });
    const gameManagerObjects = await this.suiClient.multiGetObjects({
      ids: gameMangerIds,
      options: {
        showContent: true,
      },
    });
    const gameManagers = await gameManagerObjects.map(
      async (gameManagerObject) => {
        const fields = (gameManagerObject.data as any).content.fields;
        console.log("G", fields.games.fields.id.id);
        const games = await queryAllDynamicFields({
          suiClient: this.suiClient,
          parentId: fields.games.fields.id.id,
        });
        console.log({ games });
        return {
          id: fields.id.id,
          dealer: fields.dealer,
          bls_public_key: toHEX(fields.bls_public_key),
          balance: fields.balance,
          games,
        };
      }
    );
  }

  createGameManager({
    tx,
    dealer,
    bls_public_key,
    funding,
    coinType,
  }: {
    tx: Transaction;
    dealer: string;
    bls_public_key: string;
    funding: TransactionObjectInput;
    coinType: string;
  }) {
    tx.moveCall({
      target: `${this.blackJackPackageId}::black_jack::create_game_manager`,
      typeArguments: [coinType],
      arguments: [
        tx.pure.address(dealer),
        tx.pure(bcs.vector(bcs.u8()).serialize(fromHEX(bls_public_key))),
        tx.object(funding),
      ],
    });
  }

  createGame({
    tx,
    deposit,
    firstRoundBetAmount,
    ed25519PublicKey,
    blackJackGameManagerId,
    coinType,
  }: {
    tx: Transaction;
    deposit: TransactionObjectInput;
    firstRoundBetAmount: number;
    ed25519PublicKey: string;
    blackJackGameManagerId: string;
    coinType: string;
  }) {
    tx.moveCall({
      target: `${this.blackJackPackageId}::black_jack::create_game`,
      typeArguments: [coinType],
      arguments: [
        tx.object(blackJackGameManagerId),
        tx.object(deposit),
        tx.pure.u64(firstRoundBetAmount),
        tx.pure(bcs.vector(bcs.u8()).serialize(fromHEX(ed25519PublicKey))),
      ],
    });
  }

  depositFunds({
    tx,
    gameManagerId,
    deposit,
    coinType,
  }: {
    tx: Transaction;
    gameManagerId?: string;
    deposit: TransactionObjectInput;
    coinType: string;
  }) {
    tx.moveCall({
      target: `${this.blackJackPackageId}::black_jack::deposit_funds`,
      typeArguments: [coinType],
      arguments: [
        tx.object(gameManagerId || this.blackJackGameManagerId),
        tx.object(deposit),
      ],
    });
  }

  withdrawFunds({
    tx,
    gameManagerId,
    withdrawAmount,
    coinType,
  }: {
    tx: Transaction;
    gameManagerId: string;
    withdrawAmount: number;
    coinType: string;
  }) {
    tx.moveCall({
      target: `${this.blackJackPackageId}::black_jack::withdraw_funds`,
      typeArguments: [coinType],
      arguments: [tx.object(gameManagerId), tx.pure.u64(withdrawAmount)],
    });
  }

  settle_game({
    tx,
    gameManagerId = this.blackJackGameManagerId,
    gameActionData,
    playerEd25519Signature,
    dealerBlsSignature,
    coinType,
  }: {
    tx: Transaction;
    gameManagerId?: string;
    gameActionData: TransactionObjectInput;
    playerEd25519Signature: string;
    dealerBlsSignature: string;
    coinType: string;
  }) {
    tx.moveCall({
      target: `${this.blackJackPackageId}::black_jack::settle_game`,
      typeArguments: [coinType],
      arguments: [
        tx.object(gameManagerId),
        tx.object(gameActionData),
        tx.pure(
          bcs.vector(bcs.u8()).serialize(fromHEX(playerEd25519Signature))
        ),
        tx.pure(bcs.vector(bcs.u8()).serialize(fromHEX(dealerBlsSignature))),
      ],
    });
  }

  create_game_action_data({
    tx,
    game_id,
    balance,
    randomness_seed,
    bet_amount,
    round,
    step,
    action,
    current_hands,
  }: {
    tx: Transaction;
    game_id: string;
    balance: TransactionObjectInput;
    randomness_seed: string;
    bet_amount: number;
    round: number;
    step: number;
    action: number;
    current_hands: TransactionObjectInput;
  }) {
    return tx.moveCall({
      target: `${this.blackJackPackageId}::black_jack::create_game_action_data`,
      arguments: [
        tx.pure.id(game_id),
        tx.object(balance),
        tx.pure(bcs.vector(bcs.u8()).serialize(fromHEX(randomness_seed))),
        tx.pure.u64(bet_amount),
        tx.pure.u64(round),
        tx.pure.u64(step),
        tx.pure.u8(action),
        tx.object(current_hands),
      ],
    });
  }

  create_close_tunnel_request({
    tx,
    tunnel_id,
    partyA_withdraw_amount,
    partyB_withdraw_amount,
  }: {
    tx: Transaction;
    tunnel_id: string;
    partyA_withdraw_amount: number;
    partyB_withdraw_amount: number;
  }) {
    return tx.moveCall({
      target: `${this.blackJackPackageId}::tunnel::create_close_tunnel_request`,
      arguments: [
        tx.pure.id(tunnel_id),
        tx.pure.u64(partyA_withdraw_amount),
        tx.pure.u64(partyB_withdraw_amount),
      ],
    });
  }

  create_party_balance({
    tx,
    player,
    dealer,
  }: {
    tx: Transaction;
    player: number;
    dealer: number;
  }) {
    return tx.moveCall({
      target: `${this.blackJackPackageId}::black_jack::create_party_balance`,
      arguments: [tx.pure.u64(player), tx.pure.u64(dealer)],
    });
  }

  create_hands({
    tx,
    player,
    dealer,
    deck,
  }: {
    tx: Transaction;
    player: number[];
    dealer: number[];
    deck: number[];
  }) {
    return tx.moveCall({
      target: `${this.blackJackPackageId}::black_jack::create_hands`,
      arguments: [
        tx.pure(bcs.vector(bcs.u8()).serialize(player)),
        tx.pure(bcs.vector(bcs.u8()).serialize(dealer)),
        tx.pure(bcs.vector(bcs.u8()).serialize(deck)),
      ],
    });
  }
}

// Move Codes

// /// Module: black_jack
// module black_jack::black_jack {
//   use sui::balance::{Self, Balance};
//   use black_jack::error::{
//       not_authorized_error,
//       time_not_pass_yet_error,
//       incorrect_balance_error,
//       invalid_hand_error,
//       invalid_action_error,
//   };
//   use sui::coin::{Self, Coin};
//   use sui::clock::{Self, Clock};
//   use sui::table::{Self, Table};
//   use sui::object_table::{Self, ObjectTable};
//   use std::string::{Self, String};
//   use sui::bag::{Self, Bag};
//   use sui::ed25519;
//   use sui::bls12381;
//   use std::bcs;
//   use sui::event;
//   use std::type_name;
//   // use std::debug::{print};
//   use black_jack::utils::{
//       derive_random_u8_in_range,
//       create_vector_range,
//       get_card_sum,
//   };

//   const ACTION_INIT: u8 = 0;
//   const ACTION_HIT: u8 = 1;
//   const ACTION_STAND: u8 = 2;
//   const ACTION_SETTLE: u8 = 3;

//   const REQUEST_FAIL_INTERVAL: u64 = 1000 * 60 * 60; // 1 hour

//   #[test]
//   public fun get_request_fail_interval(): u64 {
//       REQUEST_FAIL_INTERVAL
//   }

// // Events

//   public struct GameManagerCreatedEvent has copy, drop {
//       id: ID,
//       coin_type: String,
//       dealer: address,
//   }

//   public struct GameCreatedEvent has copy, drop {
//       id: ID,
//       coin_type: String,
//       game_manager: ID,
//       dealer: address,
//       player: address,
//       deposit_value: u64,
//       first_round_bet_amount: u64,
//   }

// // Structures
//   public struct GameManager<phantom T> has key, store {
//       id: UID,
//       dealer: address,
//       bls_public_key: vector<u8>,
//       balance: Balance<T>,
//       games: ObjectTable<ID, Game<T>>,
//       player_key_game_table: Table<address, ID>,
//       requests: Table<ID, Bag>, // game, round, step, request
//   }

//   public struct GameRequestBagIndex has copy, drop {
//       from_player: bool,
//       round: u64,
//       step: u64,
//   }

//   public struct Game<phantom T> has key, store {
//       id: UID,
//       deposit: Balance<T>,
//       first_round_bet_amount: u64,
//       player: address,
//       player_ed25519_public_key: vector<u8>,
//   }

//   public struct PartyBalance has copy, drop, store {
//       player: u64,
//       dealer: u64,
//   }

//   public struct Hands has copy, drop, store {
//       player: vector<u8>,
//       dealer: vector<u8>,
//       deck: vector<u8>,
//   }

//   public struct GameActionData has copy, drop, store {
//       game_id: ID,
//       balance: PartyBalance,
//       randomness_seed: vector<u8>,
//       bet_amount: u64,
//       round: u64,
//       step: u64,
//       action: u8,
//       current_hands: Hands,
//   }

// // Init

//   fun init(ctx: &mut TxContext) {
//       let bls_public_key: vector<u8> = x"b8575116de61bc9d3d9cd12eda5517d0b6151323430eaa0f059a5d44dd387ea47e3a3b290e427dc45b577e183df20ae6";
//       let dealer = @0x96d9a120058197fce04afcffa264f2f46747881ba78a91beb38f103c60e315ae;
//       let funding = coin::zero<0x2::sui::SUI>(ctx);
//       create_game_manager(dealer, bls_public_key, funding, ctx);
//   }

// // Dealer Management

//   public fun create_game_manager<T>(
//       dealer: address,
//       bls_public_key: vector<u8>,
//       funding: Coin<T>,
//       ctx: &mut TxContext
//   ) {
//       let requests = table::new(ctx);
//       let game_manager = GameManager {
//           id: object::new(ctx),
//           dealer: dealer,
//           bls_public_key: bls_public_key,
//           balance: coin::into_balance(funding),
//           games: object_table::new(ctx),
//           player_key_game_table: table::new(ctx),
//           requests,
//       };
//       let type_name_ascii = type_name::into_string(type_name::get<T>());
//       event::emit(GameManagerCreatedEvent {
//           id: object::uid_to_inner(&game_manager.id),
//           coin_type: string::from_ascii(type_name_ascii),
//           dealer: dealer,
//       });
//       transfer::public_share_object(game_manager);
//   }

//   public fun update_bls_public_key<T>(
//       game_manager: &mut GameManager<T>,
//       new_bls_public_key: vector<u8>,
//       ctx: &mut TxContext
//   ) {
//       assert!(game_manager.dealer == ctx.sender(), 0);
//       game_manager.bls_public_key = new_bls_public_key;
//   }

//   public fun deposit_funds<T>(
//       game_manager: &mut GameManager<T>,
//       deposit: Coin<T>,
//       _ctx: &mut TxContext
//   ) {
//       let deposit_balance = coin::into_balance(deposit);
//       balance::join(&mut game_manager.balance, deposit_balance);
//   }

//   public fun withdraw_funds<T>(
//       game_manager: &mut GameManager<T>,
//       withdraw_amount: u64,
//       ctx: &mut TxContext
//   ): Coin<T> {
//       assert!(game_manager.dealer == ctx.sender(), not_authorized_error());
//       coin::take(&mut game_manager.balance, withdraw_amount, ctx)
//   }

//   public fun get_fund_value<T>(
//       game_manager: &GameManager<T>
//   ): u64 {
//       balance::value(&game_manager.balance)
//   }

// // Player Normal Actions
// // ---- Game Create ----

//   public fun create_game<T>(
//       game_manager: &mut GameManager<T>,
//       deposit: Coin<T>,
//       first_round_bet_amount: u64,
//       ed25519_public_key: vector<u8>,
//       ctx: &mut TxContext
//   ): ID {
//       let mut deposit_balance = coin::into_balance(deposit);
//       let deposit_amount = balance::value(&deposit_balance);
//       let dealer_deposit_balance = balance::split(&mut game_manager.balance, deposit_amount);
//       balance::join(&mut deposit_balance, dealer_deposit_balance);

//       let player = ctx.sender();
//       let game = Game<T> {
//           id: object::new(ctx),
//           deposit: deposit_balance,
//           first_round_bet_amount,
//           player,
//           player_ed25519_public_key: ed25519_public_key,
//       };
//       let game_id = object::uid_to_inner(&game.id);
//       let type_name_ascii = type_name::into_string(type_name::get<T>());
//       event::emit(GameCreatedEvent {
//           id: game_id,
//           coin_type: string::from_ascii(type_name_ascii),
//           game_manager: object::uid_to_inner(&game_manager.id),
//           dealer: game_manager.dealer,
//           player: game.player,
//           deposit_value: game.deposit.value(),
//           first_round_bet_amount,
//       });
//       object_table::add(&mut game_manager.games, game_id, game);
//       if(!game_manager.player_key_game_table.contains(player)){
//           game_manager.player_key_game_table.add(player, game_id);
//       };
//       // table::add(&mut game_manager.player_key_game_table, player, game_id);
//       game_id
//   }

//   public fun borrow_mut_game<T>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID
//   ): &mut Game<T> {
//       object_table::borrow_mut(&mut game_manager.games, game_id)
//   }

//   public fun borrow_game<T>(
//       game_manager: &GameManager<T>,
//       game_id: ID
//   ): &Game<T> {
//       object_table::borrow(&game_manager.games, game_id)
//   }

//   public fun assert_game_balance_sum_correct<T>(
//       game: &Game<T>,
//       game_action_data: &GameActionData,
//   ) {
//       let game_balance = balance::value(&game.deposit);
//       let action_data_balance = game_action_data.balance.player + game_action_data.balance.dealer;
//       assert!(
//           game_balance == action_data_balance,
//           incorrect_balance_error()
//       );
//   }

//   public fun create_party_balance(player: u64, dealer: u64): PartyBalance {
//       PartyBalance {
//           player: player,
//           dealer: dealer,
//       }
//   }

//   public fun create_hands(player: vector<u8>, dealer: vector<u8>, deck: vector<u8>): Hands {
//       Hands {
//           player: player,
//           dealer: dealer,
//           deck: deck,
//       }
//   }

//   const DEALER: u64 = 0;
//   const PLAYER: u64 = 1;
//   public fun draw_card_for(
//       who: u64,
//       hands: &mut Hands,
//       seed: vector<u8>,
//   ): vector<u8> {
//       let (card_index, new_seed) = derive_random_u8_in_range(&seed, 0, hands.deck.length() as u8);
//       let card = hands.deck.swap_remove(card_index as u64);
//       if (who == PLAYER) {
//           hands.player.push_back(card);
//       } else if (who == DEALER) {
//           hands.dealer.push_back(card);
//       } else {
//           assert!(false, not_authorized_error());
//       };
//       new_seed
//   }

//   public fun create_game_action_data(
//       game_id: ID,
//       balance: PartyBalance,
//       randomness_seed: vector<u8>,
//       bet_amount: u64,
//       round: u64,
//       step: u64,
//       action: u8,
//       current_hands: Hands,
//   ): GameActionData {
//       GameActionData {
//           game_id,
//           balance,
//           randomness_seed,
//           bet_amount,
//           round,
//           step,
//           action,
//           current_hands,
//       }
//   }

//   fun create_game_request_bag_index_bcs(
//       from_player: bool,
//       round: u64,
//       step: u64
//   ): vector<u8> {
//       let game_request_bag_index = GameRequestBagIndex {
//           from_player: from_player,
//           round: round,
//           step: step,
//       };
//       bcs::to_bytes(&game_request_bag_index)
//   }

//   fun add_request<T, R: store>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID,
//       request_from_player: bool,
//       round: u64,
//       step: u64,
//       request: R,
//       ctx: &mut TxContext
//   ){
//       let index = create_game_request_bag_index_bcs(request_from_player, round, step);
//       if (game_manager.requests.contains(game_id)) {
//           let bag = game_manager.requests.borrow_mut(game_id);
//           bag.add(index, request);
//       } else {
//           let mut bag = bag::new(ctx);
//           bag.add(index, request);
//           game_manager.requests.add(game_id, bag);
//       }
//   }

//   fun have_request<T>(
//       game_manager: &GameManager<T>,
//       game_id: ID,
//       request_from_player: bool,
//       round: u64,
//       step: u64
//   ): bool {
//       let index = create_game_request_bag_index_bcs(request_from_player, round, step);
//       if (game_manager.requests.contains(game_id)) {
//           let bag = game_manager.requests.borrow(game_id);
//           return bag.contains(index)
//       };
//       false
//   }

//   fun remove_request<T, R: store + drop>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID,
//       request_from_player: bool,
//       round: u64,
//       step: u64,
//       _ctx: &mut TxContext
//   ): R {
//       let index = create_game_request_bag_index_bcs(request_from_player, round, step);
//       let bag = game_manager.requests.borrow_mut(game_id);
//       let request: R = bag.remove(index);
//       if (bag.length() == 0) {
//           let bag = game_manager.requests.remove(game_id);
//           bag.destroy_empty();
//       };
//       request
//   }

//   fun try_remove_request<T, R: store + drop>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID,
//       request_from_player: bool,
//       round: u64,
//       step: u64,
//       _ctx: &mut TxContext
//   ) {
//       if (have_request<T>(game_manager, game_id, request_from_player, round, step)) {
//           remove_request<T, R>(game_manager, game_id, request_from_player, round, step, _ctx);
//       };
//   }

//   public fun dealer_try_close_request<T, R: store + drop>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID,
//       round: u64,
//       step: u64,
//       ctx: &mut TxContext
//   ) {
//       assert!(
//           game_manager.dealer == ctx.sender(),
//           not_authorized_error()
//       );
//       try_remove_request<T, R>(game_manager, game_id, false, round, step, ctx);
//   }

//   public fun player_try_close_request<T, R: store + drop>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID,
//       round: u64,
//       step: u64,
//       ctx: &mut TxContext
//   ) {
//       let game = game_manager.games.borrow_mut(game_id);
//       assert!(
//           game.player == ctx.sender(),
//           not_authorized_error()
//       );
//       try_remove_request<T, R>(game_manager, game_id, true, round, step, ctx);
//   }

//   fun assert_sender_is_dealer<T>(
//       game_manager: &GameManager<T>,
//       ctx: &TxContext
//   ) {
//       assert!(
//           game_manager.dealer == ctx.sender(),
//           not_authorized_error()
//       );
//   }

// // ---- Game End after round r step s finish----

// // ---- Game Init ----

// // Case: player don't send init and just leave it there after N
// // Dealer init request
//   public struct PlayerInitRequest has store, drop {
//       game_id: ID,
//       timestamp: u64,
//   }

//   public fun dealer_create_player_init_request<T>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID,
//       clock: &Clock,
//       ctx: &mut TxContext
//   ) {
//       assert_sender_is_dealer(game_manager, ctx);
//       let request_player_init = PlayerInitRequest {
//           game_id,
//           timestamp: clock::timestamp_ms(clock)
//       };
//       assert!(
//           game_manager.games.contains(game_id),
//           not_authorized_error()
//       );
//       add_request(game_manager, game_id, false, 0, 0, request_player_init, ctx);
//   }

//   public fun dealer_close_player_init_request<T>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID,
//       ctx: &mut TxContext
//   ) {
//       assert_sender_is_dealer(game_manager, ctx);
//       try_remove_request<T, PlayerInitRequest>(game_manager, game_id, false, 0, 0, ctx);
//   }

//   public struct DealerNextActionRequest has store, drop {
//       game_id: ID,
//       timestamp: u64,
//       game_action_data: GameActionData,
//   }

//   public fun player_close_player_init_request_by_dealer_signature<T>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID,
//       dealer_init_data_signature: vector<u8>,
//       ctx: &mut TxContext
//   ) {
//       let dealer_init_request: DealerNextActionRequest = remove_request(game_manager, game_id, true, 0, 0, ctx);
//       let game_action_data = dealer_init_request.game_action_data;
//       assert!(
//           game_action_data.action == ACTION_INIT &&
//           game_action_data.step == 0 &&
//           game_action_data.round == 0,
//           not_authorized_error()
//       );
//       let game_action_data_bcs = bcs::to_bytes(&game_action_data);
//       let bls_verify = bls12381::bls12381_min_pk_verify(
//           &dealer_init_data_signature,
//           &game_manager.bls_public_key,
//           &game_action_data_bcs
//       );
//       assert!(
//           bls_verify,
//           not_authorized_error()
//       );
//   }

//   public fun player_create_dealer_init_request<T>(
//       game_manager: &mut GameManager<T>,
//       game_action_data: GameActionData,
//       game_action_data_signature: vector<u8>,
//       clock: &Clock,
//       ctx: &mut TxContext
//   ) {
//       let game_id = game_action_data.game_id;
//       let game = game_manager.games.borrow(game_id);

//       assert!(
//           game_action_data.action == ACTION_INIT &&
//           game_action_data.step == 0 &&
//           game_action_data.round == 0 &&
//           game_action_data.bet_amount == game.first_round_bet_amount,
//           not_authorized_error()
//       );

//       assert_game_balance_sum_correct(game, &game_action_data);
//       assert!(
//           game_action_data.balance.player == game_action_data.balance.dealer,
//           incorrect_balance_error()
//       );

//       assert!(
//           game.deposit.value() / 2 > game_action_data.bet_amount,
//           not_authorized_error()
//       );
//       let game_action_data_bcs = bcs::to_bytes(&game_action_data);
//       let ed25519_verify = ed25519::ed25519_verify(
//           &game_action_data_signature,
//           &game.player_ed25519_public_key,
//           &game_action_data_bcs,
//       );
//       assert!(
//           ed25519_verify,
//           not_authorized_error()
//       );
//       let dealer_next_action_request = DealerNextActionRequest {
//           game_id,
//           timestamp: clock::timestamp_ms(clock),
//           game_action_data,
//       };
//       try_remove_request<T, PlayerInitRequest>(game_manager, game_id, false, 0, 0, ctx);
//       add_request(game_manager, game_id, true, 0, 0, dealer_next_action_request, ctx);
//   }

//   public fun dealer_respond_dealer_next_action_request<T>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID,
//       game_action_data_signature: vector<u8>,
//       ctx: &mut TxContext
//   ) {
//       let dealer_init_request: DealerNextActionRequest = remove_request(game_manager, game_id, true, 0, 0, ctx);
//       assert!(
//           dealer_init_request.game_action_data.action == ACTION_INIT,
//           not_authorized_error()
//       );
//       let valid_signature = bls12381::bls12381_min_pk_verify(
//           &game_action_data_signature,
//           &game_manager.bls_public_key,
//           &bcs::to_bytes(&dealer_init_request.game_action_data)
//       );
//       assert!(
//           valid_signature,
//           not_authorized_error()
//       );
//   }

//   public fun punish_player_for_not_responding_to_init_request<T>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID,
//       clock: &Clock,
//       ctx: &mut TxContext
//   ) {
//       let game = game_manager.games.remove(game_id);
//       let player_init_request: PlayerInitRequest = remove_request(game_manager, game_id, false, 0, 0, ctx);
//       assert!(
//           player_init_request.timestamp + REQUEST_FAIL_INTERVAL < clock::timestamp_ms(clock),
//           time_not_pass_yet_error()
//       );
//       let Game {
//           id,
//           deposit,
//           first_round_bet_amount,
//           player,
//           player_ed25519_public_key: _,
//       } = game;
//       id.delete();
//       let player_balance_value = deposit.value() / 3;
//       let mut game_coin = coin::from_balance(deposit, ctx);
//       let player_coin = game_coin.split(player_balance_value, ctx);
//       transfer::public_transfer(player_coin, player);
//       deposit_funds(game_manager, game_coin, ctx);
//   }

//   public fun punish_dealer_for_not_responding_to_init_request<T>(
//       game_manager: &mut GameManager<T>,
//       game_id: ID,
//       clock: &Clock,
//       ctx: &mut TxContext
//   ) {
//       let game = game_manager.games.remove(game_id);
//       let dealer_init_request: DealerNextActionRequest = remove_request(game_manager, game_id, true, 0, 0, ctx);
//       assert!(
//           dealer_init_request.timestamp + REQUEST_FAIL_INTERVAL < clock::timestamp_ms(clock),
//           time_not_pass_yet_error()
//       );
//       let Game {
//           id,
//           deposit,
//           first_round_bet_amount,
//           player,
//           player_ed25519_public_key: _,
//       } = game;
//       id.delete();
//       let game_action_data = dealer_init_request.game_action_data;
//       let player_balance_value = deposit.value() / 2 + game_action_data.bet_amount;
//       let mut game_coin = coin::from_balance(deposit, ctx);
//       let player_coin = game_coin.split(player_balance_value, ctx);
//       transfer::public_transfer(player_coin, player);
//       deposit_funds(game_manager, game_coin, ctx);
//   }

// // ---- player Action after Init or Continue or Action at round r ----

// // Case: player don't send action and just leave it there after N

//   public struct PlayerNextActionRequest has store, drop {
//       game_id: ID,
//       timestamp: u64,
//   }

//   public fun dealer_create_player_next_action_request<T>(
//       game_manager: &mut GameManager<T>,
//       game_action_data: GameActionData,
//       player_ed25519_signature: vector<u8>,
//       dealer_bls_signature: vector<u8>,
//       clock: &Clock,
//       ctx: &mut TxContext
//   ) {
//       let game_action_data_bcs = bcs::to_bytes(&game_action_data);
//       let game = game_manager.games.borrow(game_action_data.game_id);
//       assert_game_balance_sum_correct(game, &game_action_data);
//       let ed25519_verify = ed25519::ed25519_verify(
//           &player_ed25519_signature,
//           &game.player_ed25519_public_key,
//           &game_action_data_bcs,
//       );
//       let bls_verify = bls12381::bls12381_min_pk_verify(
//           &dealer_bls_signature,
//           &game_manager.bls_public_key,
//           &game_action_data_bcs
//       );
//       assert!(ed25519_verify && bls_verify, not_authorized_error());
//       let player_next_action_request = PlayerNextActionRequest {
//           game_id: game_action_data.game_id,
//           timestamp: clock::timestamp_ms(clock),
//       };
//       add_request(
//           game_manager,
//           game_action_data.game_id,
//           false,
//           game_action_data.round,
//           game_action_data.step,
//           player_next_action_request,
//           ctx
//       );
//   }

//   public fun player_create_dealer_action_request<T>(
//       game_manager: &mut GameManager<T>,
//       previous_game_action_data: GameActionData,
//       dealer_bls_signature_for_previous_action_data: vector<u8>,
//       game_action_data: GameActionData,
//       player_ed25519_signature_for_action_data: vector<u8>,
//       clock: &Clock,
//       ctx: &mut TxContext
//   ) {
//       let game_id = game_action_data.game_id;
//       let game = game_manager.games.borrow(game_id);
//       assert_game_balance_sum_correct(game, &game_action_data);

//       let previous_game_action_data_bcs = bcs::to_bytes(&previous_game_action_data);
//       let bls_verify = bls12381::bls12381_min_pk_verify(
//           &dealer_bls_signature_for_previous_action_data,
//           &game_manager.bls_public_key,
//           &previous_game_action_data_bcs
//       );
//       let game_action_data_bcs = bcs::to_bytes(&game_action_data);
//       let ed25519_verify = ed25519::ed25519_verify(
//           &player_ed25519_signature_for_action_data,
//           &game.player_ed25519_public_key,
//           &game_action_data_bcs,
//       );
//       assert!(bls_verify && ed25519_verify, not_authorized_error());

//       // Validate the game action data is valid from the previous one
//       let mut hands = *&previous_game_action_data.current_hands;
//       let mut seed = dealer_bls_signature_for_previous_action_data;
//       if(previous_game_action_data.action == ACTION_INIT){
//           // assert current action is consistant with previous one
//           assert!(
//               game_action_data.action == ACTION_HIT ||
//               game_action_data.action == ACTION_STAND,
//               invalid_action_error()
//           );
//           // assert game action data is valid and consistant with previous one
//           assert!(
//               previous_game_action_data.round == game_action_data.round &&
//               previous_game_action_data.step == 0 &&
//               game_action_data.step == 1 &&
//               hands.player.length() == 0 &&
//               hands.dealer.length() == 0 &&
//               hands.deck == create_vector_range(0, 52),
//               not_authorized_error()
//           );
//           seed = draw_card_for(DEALER, &mut hands, seed);
//           seed = draw_card_for(PLAYER, &mut hands, seed);
//           draw_card_for(PLAYER, &mut hands, seed);
//           assert!(
//               hands == game_action_data.current_hands,
//               invalid_hand_error()
//           );
//       } else {
//           assert!(false, not_authorized_error());
//       };
//       let dealer_next_action_request = DealerNextActionRequest {
//           game_id,
//           timestamp: clock::timestamp_ms(clock),
//           game_action_data,
//       };
//       try_remove_request<T, PlayerInitRequest>(
//           game_manager,
//           game_id,
//           false,
//           game_action_data.round,
//           game_action_data.round,
//           ctx
//       );
//       add_request(
//           game_manager,
//           game_id,
//           true,
//           game_action_data.round,
//           game_action_data.step,
//           dealer_next_action_request,
//           ctx
//       );
//   }

// // Case: dealer don't respond player's action

// // ---- player Action at step s ----

// // Case: player don't send action and just leave it there after N

// // Case: dealer don't respond player's action

// // ---- Settle ----

// // Case: player don't send action of continue or finish and just leave it there during settle

// // Case: dealer don't respond player's settle

// // ---- Game Continue after round r step s finish----

// // Case: dealer don't reply for game continue request

// // ---- Game Settle after round r step s finish----

// // Case: dealer don't reply for game end request

//   public fun settle_game<T>(
//       game_manager: &mut GameManager<T>,
//       game_action_data: GameActionData,
//       player_ed25519_signature: vector<u8>,
//       dealer_bls_signature: vector<u8>,
//       ctx: &mut TxContext,
//   ) {
//       assert!(
//           game_action_data.action == ACTION_SETTLE,
//           invalid_action_error()
//       );
//       let game_id = game_action_data.game_id;
//       let game = game_manager.games.borrow(game_id);
//       assert_game_balance_sum_correct(game, &game_action_data);
//       let game_action_data_bcs = bcs::to_bytes(&game_action_data);
//       let ed25519_verify = ed25519::ed25519_verify(
//           &player_ed25519_signature,
//           &game.player_ed25519_public_key,
//           &game_action_data_bcs,
//       );
//       let bls_verify = bls12381::bls12381_min_pk_verify(
//           &dealer_bls_signature,
//           &game_manager.bls_public_key,
//           &game_action_data_bcs
//       );
//       assert!(ed25519_verify && bls_verify, not_authorized_error());
//       let game = game_manager.games.remove(game_id);
//       let Game {
//           id,
//           deposit,
//           first_round_bet_amount,
//           player,
//           player_ed25519_public_key: _,
//       } = game;
//       id.delete();
//       let mut game_coin = coin::from_balance(deposit, ctx);
//       let player_coin = game_coin.split(game_action_data.balance.player, ctx);
//       transfer::public_transfer(player_coin, player);
//       deposit_funds(game_manager, game_coin, ctx);
//   }
// }

// #[test_only]
// #[allow(unused_variable, unused_use)]
// module black_jack::black_jack_tests {
//     // uncomment this line to import the module
//     use black_jack::black_jack::{
//         Self,
//         create_party_balance,
//         GameManager,
//         get_request_fail_interval,
//     };
//     use black_jack::error;
//     use black_jack::test_utils::{
//         assert_balance_equal_to,
//         assert_manager_balance_equal_to
//     };
//     use black_jack::utils::{
//         derive_random_u8_in_range,
//         create_vector_range
//     };
//     use std::debug::{print};
//     use std::string::{utf8};
//     // use std::bcs;
//     use sui::test_scenario::{Self, Scenario};
//     use sui::coin::{Self, Coin};
//     use sui::clock;
//     // use std::vector;
//     use black_jack::test_coin::{TEST_COIN};

//     const DEALER: address = @0x1;
//     const PLAYER: address = @0x2;
//     const CLOCK_DEFAULT_TIME: u64 = 1687975971000;
//     const BET_AMOUNT: u64 = 5;

//     // Begin of Test Modular Functions

//         use fun test_initialize_game_manager as Scenario.test_initialize_game_manager;

//         fun test_initialize_game_manager(
//             scenario: &mut Scenario,
//             dealer: address
//         ) {
//             let bls_public_key: vector<u8> = x"b8575116de61bc9d3d9cd12eda5517d0b6151323430eaa0f059a5d44dd387ea47e3a3b290e427dc45b577e183df20ae6";
//             let funding = coin::mint_for_testing<TEST_COIN>(1000, scenario.ctx());
//             black_jack::create_game_manager(
//                     dealer,
//                     bls_public_key,
//                     funding,
//                     scenario.ctx()
//             );
//         }

//         use fun test_create_game as Scenario.test_create_game;

//         fun test_create_game(
//             scenario: &mut Scenario,
//             player: address,
//         ): ID {
//             scenario.next_tx(player);

//             let ed25519_public_key: vector<u8> = x"fbb43a94aa97d1fea6c00244e27501384934f504b5d0c108af2ea0c71ce8d852";
//             let randomness_seed: vector<u8> = x"868f";
//             let deposit = coin::mint_for_testing<TEST_COIN>(100, scenario.ctx());
//             let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();

//             let game_id = black_jack::create_game(
//                 &mut game_manager,
//                 deposit,
//                 BET_AMOUNT,
//                 ed25519_public_key,
//                 scenario.ctx()
//             );
//             test_scenario::return_shared(game_manager);
//             game_id
//         }

//         use fun test_create_player_init_request as Scenario.test_create_player_init_request;

//         fun test_create_player_init_request(
//             scenario: &mut Scenario,
//             dealer: address,
//             game_id: ID,
//             clockObj: &clock::Clock,
//         ) {
//             scenario.next_tx(dealer);
//             let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
//             black_jack::dealer_create_player_init_request(
//                     &mut game_manager,
//                     game_id,
//                     clockObj,
//                     scenario.ctx(),
//             );
//             test_scenario::return_shared(game_manager);
//         }

//         use fun test_punish_player_for_not_responding_to_init_request as Scenario.test_punish_player_for_not_responding_to_init_request;

//         fun test_punish_player_for_not_responding_to_init_request(
//             scenario: &mut Scenario,
//             dealer: address,
//             game_id: ID,
//             clockObj: &clock::Clock,
//         ) {
//             scenario.next_tx(dealer);
//             let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
//             black_jack::punish_player_for_not_responding_to_init_request(
//                 &mut game_manager,
//                 game_id,
//                 clockObj,
//                 scenario.ctx(),
//             );
//             test_scenario::return_shared(game_manager);
//         }

//          use fun test_player_create_dealer_init_request as Scenario.test_player_create_dealer_init_request;

//         fun test_player_create_dealer_init_request(
//             scenario: &mut Scenario,
//             player: address,
//             game_id: ID,
//             clockObj: &clock::Clock,
//         ) {
//             scenario.next_tx(player);

//             let randomness_seed: vector<u8> = x"868f";
//             let ed25519_public_key: vector<u8> = x"fbb43a94aa97d1fea6c00244e27501384934f504b5d0c108af2ea0c71ce8d852";

//             let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();

//             let partyBalance = black_jack::create_party_balance(100, 100);
//             let current_hands = black_jack::create_hands(
//                 vector::empty(),
//                 vector::empty(),
//                 create_vector_range(0, 52)
//                 );
//             let game_action_data = black_jack::create_game_action_data(
//                 game_id,
//                 partyBalance,
//                 randomness_seed,
//                 BET_AMOUNT,
//                 0,
//                 0,
//                 0,
//                 current_hands
//             );
//             let game_action_data_signature: vector<u8> = x"001ab78e6a3d021f181dccae38cab17c8c12fbe18cfbfdf51cb5731b61a1604a05fbe1ad2bf7274a1a18ac59307aac854483a59611bcb429282cbb57b0902808";
//             // Error request not found
//             black_jack::player_create_dealer_init_request<TEST_COIN>(
//                 &mut game_manager,
//                 game_action_data,
//                 game_action_data_signature,
//                 clockObj,
//                 scenario.ctx(),
//             );
//             test_scenario::return_shared(game_manager);
//         }

//         use fun test_punish_dealer_for_not_responding_to_init_request as Scenario.test_punish_dealer_for_not_responding_to_init_request;

//         fun test_punish_dealer_for_not_responding_to_init_request(
//             scenario: &mut Scenario,
//             player: address,
//             game_id: ID,
//             clockObj: &clock::Clock,
//         ) {
//             scenario.next_tx(player);
//             let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
//             black_jack::punish_dealer_for_not_responding_to_init_request<TEST_COIN>(
//                 &mut game_manager,
//                 game_id,
//                 clockObj,
//                 scenario.ctx(),
//             );
//             test_scenario::return_shared(game_manager);
//         }

//         use fun test_dealer_respond_dealer_next_action_request as Scenario.test_dealer_respond_dealer_next_action_request;

//         fun test_dealer_respond_dealer_next_action_request(
//             scenario: &mut Scenario,
//             dealer: address,
//             game_id: ID,
//             clockObj: &clock::Clock,
//         ) {
//             scenario.next_tx(dealer);

//             let init_game_action_data_bls_signature = x"b50c94ae0cfb95626f503aba6a3c6f598874492c9887b40e996cfef21c297a5733799e91c17d3902f9cdcc4dd0d6653608c3de5167a1c3c21b3f1d0de6690060d61ade3bfbdc03f0f3327b7d20dba59f0958f736b91e9472c1a3fc0bbc51596d";

//             let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
//             black_jack::dealer_respond_dealer_next_action_request(
//                 &mut game_manager,
//                 game_id,
//                 init_game_action_data_bls_signature,
//                 scenario.ctx(),
//             );
//             test_scenario::return_shared(game_manager);
//         }

//     // End of Test Modular Functions

//     #[test]
//     #[expected_failure(abort_code = error::ErrorTimeNotPassYet, location = black_jack)]
//     fun test_dealer_create_player_init_request_and_punish_player_before_deadline_fail() {

//         let mut scenario = test_scenario::begin(DEALER);
//         scenario.test_initialize_game_manager(DEALER);
//         let game_id = scenario.test_create_game(PLAYER);

//         let mut clockObj = clock::create_for_testing(scenario.ctx());
//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
//         scenario.test_create_player_init_request(DEALER, game_id, &clockObj);

//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME + 1);
//         scenario.test_punish_player_for_not_responding_to_init_request(DEALER, game_id, &clockObj);

//         clock::destroy_for_testing(clockObj);
//         scenario.end();
//     }

//     #[test]
//     #[expected_failure(abort_code = 0, location = sui::dynamic_field)]
//     fun test_dealer_create_multiple_player_init_request_fail() {

//         let mut scenario = test_scenario::begin(DEALER);
//         scenario.test_initialize_game_manager(DEALER);
//         let game_id = scenario.test_create_game(PLAYER);

//         let mut clockObj = clock::create_for_testing(scenario.ctx());
//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
//         scenario.test_create_player_init_request(DEALER, game_id, &clockObj);

//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME + 3);
//         scenario.test_create_player_init_request(DEALER, game_id, &clockObj);

//         clock::destroy_for_testing(clockObj);
//         scenario.end();
//     }

//     #[test]
//     fun test_dealer_create_player_init_request_and_punish_player_after_deadline() {

//         let mut scenario = test_scenario::begin(DEALER);
//         scenario.test_initialize_game_manager(DEALER);
//         let game_id = scenario.test_create_game(PLAYER);

//         let mut clockObj = clock::create_for_testing(scenario.ctx());
//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
//         scenario.test_create_player_init_request(DEALER, game_id, &clockObj);

//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
//         scenario.test_punish_player_for_not_responding_to_init_request(DEALER, game_id, &clockObj);

//         scenario.next_tx(DEALER);
//         assert_balance_equal_to(&mut scenario, PLAYER, 100 * 2/3);
//         assert_manager_balance_equal_to(&mut scenario, 1000 + (100 - 100 * 2/3));

//         clock::destroy_for_testing(clockObj);
//         scenario.end();
//     }

//     #[test]
//     #[expected_failure(abort_code = 1, location = sui::dynamic_field)]
//     fun test_dealer_create_player_init_request_and_player_response_it_then_dealer_punish_player_after_deadline_fail() {

//         let mut scenario = test_scenario::begin(DEALER);
//         scenario.test_initialize_game_manager(DEALER);
//         let game_id = scenario.test_create_game(PLAYER);

//         let mut clockObj = clock::create_for_testing(scenario.ctx());
//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
//         scenario.test_create_player_init_request(DEALER, game_id, &clockObj);

//         scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
//         scenario.test_punish_player_for_not_responding_to_init_request(DEALER, game_id, &clockObj);

//         clock::destroy_for_testing(clockObj);
//         scenario.end();
//     }

//     #[test]
//     fun test_dealer_create_player_init_request_and_player_response_it_then_punish_dealer_after_deadline() {

//         let mut scenario = test_scenario::begin(DEALER);
//         scenario.test_initialize_game_manager(DEALER);
//         let game_id = scenario.test_create_game(PLAYER);

//         let mut clockObj = clock::create_for_testing(scenario.ctx());
//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
//         scenario.test_create_player_init_request(DEALER, game_id, &clockObj);

//         scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
//         scenario.test_punish_dealer_for_not_responding_to_init_request(PLAYER, game_id, &clockObj);

//         scenario.next_tx(PLAYER);
//         {
//             assert_balance_equal_to(&mut scenario, PLAYER, 100 + BET_AMOUNT);
//             assert_manager_balance_equal_to(&mut scenario, 1000 - BET_AMOUNT);
//         };
//         clock::destroy_for_testing(clockObj);
//         scenario.end();
//     }

//     #[test]
//     #[expected_failure(abort_code = error::ErrorTimeNotPassYet, location = black_jack)]
//     fun test_player_create_dealer_init_request_then_punish_dealer_before_deadline_fail() {

//         let mut scenario = test_scenario::begin(DEALER);
//         scenario.test_initialize_game_manager(DEALER);
//         let game_id = scenario.test_create_game(PLAYER);

//         let mut clockObj = clock::create_for_testing(scenario.ctx());
//         clock::set_for_testing(&mut clockObj, CLOCK_DEFAULT_TIME);

//         scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

//         clock::set_for_testing(&mut clockObj, CLOCK_DEFAULT_TIME + 1);
//         scenario.test_punish_dealer_for_not_responding_to_init_request(PLAYER, game_id, &clockObj);

//         clock::destroy_for_testing(clockObj);
//         scenario.end();
//     }

//     #[test]
//     fun test_player_create_init_request_then_punish_dealer_after_deadline() {

//         let mut scenario = test_scenario::begin(DEALER);
//         scenario.test_initialize_game_manager(DEALER);
//         let game_id = scenario.test_create_game(PLAYER);

//         let mut clockObj = clock::create_for_testing(scenario.ctx());
//         clock::set_for_testing(&mut clockObj, CLOCK_DEFAULT_TIME);

//         scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
//         scenario.test_punish_dealer_for_not_responding_to_init_request(PLAYER, game_id, &clockObj);

//         scenario.next_tx(PLAYER);
//         {
//             assert_balance_equal_to(&mut scenario, PLAYER, 100 + BET_AMOUNT);
//             assert_manager_balance_equal_to(&mut scenario, 1000 - BET_AMOUNT);
//         };
//         clock::destroy_for_testing(clockObj);
//         scenario.end();
//     }

//     #[test]
//     #[expected_failure(abort_code = 0, location = sui::dynamic_field)]
//     fun test_player_create_multiple_dealer_init_request_fail() {

//         let mut scenario = test_scenario::begin(DEALER);
//         scenario.test_initialize_game_manager(DEALER);
//         let game_id = scenario.test_create_game(PLAYER);

//         let mut clockObj = clock::create_for_testing(scenario.ctx());
//         clock::set_for_testing(&mut clockObj, CLOCK_DEFAULT_TIME);

//         scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

//         scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

//         clock::destroy_for_testing(clockObj);
//         scenario.end();
//     }

//     #[test]
//     fun test_dealer_create_init_request_and_player_response_it_then_dealer_response_it() {

//         let mut scenario = test_scenario::begin(DEALER);
//         scenario.test_initialize_game_manager(DEALER);
//         let game_id = scenario.test_create_game(PLAYER);

//         let mut clockObj = clock::create_for_testing(scenario.ctx());
//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
//         scenario.test_create_player_init_request(DEALER, game_id, &clockObj);

//         scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

//         scenario.test_dealer_respond_dealer_next_action_request(DEALER, game_id, &clockObj);

//         clock::destroy_for_testing(clockObj);
//         scenario.end();
//     }

//     #[test]
//     #[expected_failure(abort_code = 1, location = sui::dynamic_field)]
//     fun test_dealer_create_init_request_and_player_response_it_then_dealer_response_it_then_player_punish_dealer_after_deadline_fail() {

//         let mut scenario = test_scenario::begin(DEALER);
//         scenario.test_initialize_game_manager(DEALER);
//         let game_id = scenario.test_create_game(PLAYER);

//         let mut clockObj = clock::create_for_testing(scenario.ctx());
//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
//         scenario.test_create_player_init_request(DEALER, game_id, &clockObj);

//         scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

//         scenario.test_dealer_respond_dealer_next_action_request(DEALER, game_id, &clockObj);

//         clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
//         scenario.test_punish_dealer_for_not_responding_to_init_request(PLAYER, game_id, &clockObj);

//         clock::destroy_for_testing(clockObj);
//         scenario.end();
//     }

//     #[test]
//     fun test_player_create_action_request() {
//         let bls_public_key: vector<u8> = x"b8575116de61bc9d3d9cd12eda5517d0b6151323430eaa0f059a5d44dd387ea47e3a3b290e427dc45b577e183df20ae6";
//         let ed25519_public_key: vector<u8> = x"fbb43a94aa97d1fea6c00244e27501384934f504b5d0c108af2ea0c71ce8d852";
//         let randomness_seed: vector<u8> = x"868f";

//         let mut scenario = test_scenario::begin(DEALER);
//         scenario.test_initialize_game_manager(DEALER);
//         let game_id = scenario.test_create_game(PLAYER);

//         scenario.next_tx(PLAYER);
//         {
//             let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();

//             let mut clockObj = clock::create_for_testing(scenario.ctx());
//             clock::set_for_testing(&mut clockObj, CLOCK_DEFAULT_TIME);
//             let partyBalance = black_jack::create_party_balance(100, 100);
//             let previous_hands = black_jack::create_hands(
//                 vector::empty(),
//                 vector::empty(),
//                 create_vector_range(0, 52)
//             );
//             let previous_game_action_data = black_jack::create_game_action_data(
//                 game_id,
//                 partyBalance,
//                 randomness_seed,
//                 BET_AMOUNT,
//                 0,
//                 0,
//                 0,
//                 previous_hands,
//             );
//             let previous_game_action_data_bls_signature = x"b50c94ae0cfb95626f503aba6a3c6f598874492c9887b40e996cfef21c297a5733799e91c17d3902f9cdcc4dd0d6653608c3de5167a1c3c21b3f1d0de6690060d61ade3bfbdc03f0f3327b7d20dba59f0958f736b91e9472c1a3fc0bbc51596d";

//             let mut current_hands = black_jack::create_hands(
//                 vector::empty(),
//                 vector::empty(),
//                 create_vector_range(0, 52)
//             );
//             let mut seed = x"b50c94ae0cfb95626f503aba6a3c6f598874492c9887b40e996cfef21c297a5733799e91c17d3902f9cdcc4dd0d6653608c3de5167a1c3c21b3f1d0de6690060d61ade3bfbdc03f0f3327b7d20dba59f0958f736b91e9472c1a3fc0bbc51596d";
//             seed = black_jack::draw_card_for(0, &mut current_hands, seed);
//             seed = black_jack::draw_card_for(1, &mut current_hands, seed);
//             black_jack::draw_card_for(1, &mut current_hands, seed);

//             let game_action_data = black_jack::create_game_action_data(
//                 game_id,
//                 partyBalance,
//                 randomness_seed,
//                 BET_AMOUNT,
//                 0,
//                 1,
//                 1,
//                 current_hands,
//             );
//             let game_action_data_ed25519_signature: vector<u8> = x"d79720e63b99bf91dd0abdebca398c9d64e709b4bfa7f87ae5991e4df3ad5182e9284185a71092a7374035f1637f0e9edff802a5001a2ecb4bcd0868df086f03";
//             // Error request not found
//             black_jack::player_create_dealer_action_request<TEST_COIN>(
//                 &mut game_manager,
//                 previous_game_action_data,
//                 previous_game_action_data_bls_signature,
//                 game_action_data,
//                 game_action_data_ed25519_signature,
//                 &clockObj,
//                 scenario.ctx(),
//             );
//             clock::destroy_for_testing(clockObj);
//             test_scenario::return_shared(game_manager);
//         };

//         scenario.end();
//     }
// }
