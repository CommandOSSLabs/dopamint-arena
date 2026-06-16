
/// Module: black_jack
module black_jack::black_jack {
    use sui::balance::{Self, Balance};
    use black_jack::error::{
        not_authorized_error,
        time_not_pass_yet_error,
        incorrect_balance_error,
        invalid_hand_error,
        invalid_action_error,
        invalid_balance_error,
    };
    use sui::coin::{Self, Coin};
    use sui::clock::{Self, Clock};
    use sui::table::{Self, Table};
    use sui::object_table::{Self, ObjectTable};
    use std::string::{Self, String};
    use sui::bag::{Self, Bag};
    use std::bcs;
    use sui::event;
    use std::type_name;
    use black_jack::utils::{
        derive_random_u8_in_range,
        create_vector_range,
        get_hand_sum,
    };
    use black_jack::tunnel::{
        create_tunnel,
        close_tunnel,
        Tunnel,
        BLS12381,
        ED25519
    };
    use black_jack::test_buck::{
        TEST_BUCK,
    };

    const ACTION_INIT: u8 = 0;
    const ACTION_HIT: u8 = 1;
    const ACTION_STAND: u8 = 2;
    const ACTION_SETTLE: u8 = 3;

    const REQUEST_FAIL_INTERVAL: u64 = 1000 * 60 * 60; // 1 hour
    
    #[test]
    public fun get_request_fail_interval(): u64 {
        REQUEST_FAIL_INTERVAL
    }

// Events

    public struct GameManagerCreatedEvent has copy, drop {
        id: ID,
        coin_type: String,
        dealer: address,
    }

    public struct GameCreatedEvent has copy, drop {
        id: ID,
        coin_type: String,
        game_manager: ID,
        dealer: address,
        player: address,
        deposit_value: u64,
        first_round_bet_amount: u64,
    }

// Structures
    public struct GameManager<phantom T> has key, store {
        id: UID,
        dealer: address,
        bls_public_key: vector<u8>,
        balance: Balance<T>,
        games: ObjectTable<ID, Game<T>>,
        player_key_game_table: Table<vector<u8>, ID>,
        requests: Table<ID, Bag>, // game, round, step, request
    }

    public struct GameRequestBagIndex has copy, drop {
        from_player: bool,
        round: u64,
        step: u64,
    }

    public struct Game<phantom T> has key, store {
        id: UID,
        tunnel: Tunnel<T>,
        player: address,
    }

    public struct PartyBalance has copy, drop, store {
        player: u64,
        dealer: u64,
    }

    public struct Hands has copy, drop, store {
        player: vector<u8>,
        dealer: vector<u8>,
        deck: vector<u8>,
    }
    
    public struct GameActionData has copy, drop, store {
        game_id: ID,
        balance: PartyBalance,
        randomness_seed: vector<u8>,
        bet_amount: u64,
        round: u64,
        step: u64,
        action: u8,
        current_hands: Hands,
    }

// Init

    fun init(ctx: &mut TxContext) {
        let bls_public_key: vector<u8> = x"b8575116de61bc9d3d9cd12eda5517d0b6151323430eaa0f059a5d44dd387ea47e3a3b290e427dc45b577e183df20ae6";
        let dealer = @0x96d9a120058197fce04afcffa264f2f46747881ba78a91beb38f103c60e315ae;
        let funding = coin::zero<TEST_BUCK>(ctx);
        create_game_manager(dealer, bls_public_key, funding, ctx);
    }

// Dealer Management

    public fun create_game_manager<T>(
        dealer: address,
        bls_public_key: vector<u8>,
        funding: Coin<T>,
        ctx: &mut TxContext
    ) {
        let requests = table::new(ctx);
        let game_manager = GameManager {
            id: object::new(ctx),
            dealer: dealer,
            bls_public_key: bls_public_key,
            balance: coin::into_balance(funding),
            games: object_table::new(ctx),
            player_key_game_table: table::new(ctx),
            requests,
        };
        let type_name_ascii = type_name::into_string(type_name::get<T>());
        event::emit(GameManagerCreatedEvent {
            id: object::uid_to_inner(&game_manager.id),
            coin_type: string::from_ascii(type_name_ascii),
            dealer: dealer,
        });
        transfer::public_share_object(game_manager);
    }

    public fun update_bls_public_key<T>(
        game_manager: &mut GameManager<T>,
        new_bls_public_key: vector<u8>,
        ctx: &mut TxContext
    ) {
        assert!(game_manager.dealer == ctx.sender(), 0);
        game_manager.bls_public_key = new_bls_public_key;
    }

    public fun deposit_funds<T>(
        game_manager: &mut GameManager<T>,
        deposit: Coin<T>,
        _ctx: &mut TxContext
    ) {
        let deposit_balance = coin::into_balance(deposit);
        balance::join(&mut game_manager.balance, deposit_balance);
    }

    public fun withdraw_funds<T>(
        game_manager: &mut GameManager<T>,
        withdraw_amount: u64,
        ctx: &mut TxContext
    ): Coin<T> {
        assert!(game_manager.dealer == ctx.sender(), not_authorized_error());
        coin::take(&mut game_manager.balance, withdraw_amount, ctx)
    }

    public fun get_fund_value<T>(
        game_manager: &GameManager<T>
    ): u64 {
        balance::value(&game_manager.balance)
    }

// Player Normal Actions
  // ---- Game Create ----

    public fun create_game<T>(
        game_manager: &mut GameManager<T>,
        deposit: Coin<T>,
        first_round_bet_amount: u64,
        ed25519_public_key: vector<u8>,
        ctx: &mut TxContext
    ): ID {
        let player_deposit = coin::into_balance(deposit);
        let deposit_amount = balance::value(&player_deposit);
        let dealer_deposit = balance::split(&mut game_manager.balance, deposit_amount);
        
        let tunnel = create_tunnel(
            player_deposit, // party A is player
            dealer_deposit,
            ed25519_public_key,
            ED25519(),
            game_manager.bls_public_key,
            BLS12381(),
            first_round_bet_amount,
            ctx
        );

        let player = ctx.sender();

        let game = Game<T> {
            id: object::new(ctx),
            tunnel,
            player,
        };
        let game_id = object::uid_to_inner(&game.id);
        let type_name_ascii = type_name::into_string(type_name::get<T>());
        event::emit(GameCreatedEvent {
            id: game_id,
            coin_type: string::from_ascii(type_name_ascii),
            game_manager: object::uid_to_inner(&game_manager.id),
            dealer: game_manager.dealer,
            player: game.player,
            deposit_value: game.tunnel.value(),
            first_round_bet_amount,
        });
        object_table::add(&mut game_manager.games, game_id, game);
        game_manager.player_key_game_table.add(ed25519_public_key, game_id);
        game_id
    }

    public fun borrow_mut_game<T>(
        game_manager: &mut GameManager<T>,
        game_id: ID
    ): &mut Game<T> {
        object_table::borrow_mut(&mut game_manager.games, game_id)
    }

    public fun borrow_game<T>(
        game_manager: &GameManager<T>,
        game_id: ID
    ): &Game<T> {
        object_table::borrow(&game_manager.games, game_id)
    }

    public fun assert_game_balance_sum_correct<T>(
        game: &Game<T>,
        game_action_data: &GameActionData,
    ) {
        let game_balance = game.tunnel.value();
        let action_data_balance = game_action_data.balance.player + game_action_data.balance.dealer;
        assert!(
            game_balance == action_data_balance,
            incorrect_balance_error()
        );
    }

    public fun create_party_balance(player: u64, dealer: u64): PartyBalance {
        PartyBalance {
            player: player,
            dealer: dealer,
        }
    }

    public fun create_hands(player: vector<u8>, dealer: vector<u8>, deck: vector<u8>): Hands {
        Hands {
            player: player,
            dealer: dealer,
            deck: deck,
        }
    }

    const DEALER: bool = false;
    const PLAYER: bool = true;
    public fun draw_card_for(
        who: bool,
        hands: &mut Hands,
        seed: vector<u8>,
    ): vector<u8> {
        let (card_index, new_seed) = derive_random_u8_in_range(&seed, 0, hands.deck.length() as u8);
        let card = hands.deck.swap_remove(card_index as u64);
        if (who == PLAYER) {
            hands.player.push_back(card);
        } else if (who == DEALER) {
            hands.dealer.push_back(card);
        } else {
            assert!(false, not_authorized_error());
        };
        new_seed
    }

    public fun create_game_action_data(
        game_id: ID,
        balance: PartyBalance,
        randomness_seed: vector<u8>,
        bet_amount: u64,
        round: u64,
        step: u64,
        action: u8,
        current_hands: Hands,
    ): GameActionData {
        GameActionData {
            game_id,
            balance,
            randomness_seed,
            bet_amount,
            round,
            step,
            action,
            current_hands,
        }
    }

    fun create_game_request_bag_index_bcs(
        from_player: bool,
        round: u64,
        step: u64
    ): vector<u8> {
        let game_request_bag_index = GameRequestBagIndex {
            from_player: from_player,
            round: round,
            step: step,
        };
        bcs::to_bytes(&game_request_bag_index)
    }

    fun add_request<T, R: store>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        request_from_player: bool,
        round: u64,
        step: u64,
        request: R,
        ctx: &mut TxContext
    ){
        let index = create_game_request_bag_index_bcs(request_from_player, round, step);
        if (game_manager.requests.contains(game_id)) {
            let bag = game_manager.requests.borrow_mut(game_id);
            bag.add(index, request);
        } else {
            let mut bag = bag::new(ctx);
            bag.add(index, request);
            game_manager.requests.add(game_id, bag);
        }
    }

    fun have_request<T>(
        game_manager: &GameManager<T>,
        game_id: ID,
        request_from_player: bool,
        round: u64,
        step: u64
    ): bool {
        let index = create_game_request_bag_index_bcs(request_from_player, round, step);
        if (game_manager.requests.contains(game_id)) {
            let bag = game_manager.requests.borrow(game_id);
            return bag.contains(index)
        };
        false
    }

    fun remove_request<T, R: store + drop>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        request_from_player: bool,
        round: u64,
        step: u64,
        _ctx: &mut TxContext
    ): R {
        let index = create_game_request_bag_index_bcs(request_from_player, round, step);
        let bag = game_manager.requests.borrow_mut(game_id);
        let request: R = bag.remove(index);
        if (bag.length() == 0) {
            let bag = game_manager.requests.remove(game_id);
            bag.destroy_empty();
        };
        request
    }

    fun try_remove_request<T, R: store + drop>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        request_from_player: bool,
        round: u64,
        step: u64,
        _ctx: &mut TxContext
    ) {
        if (have_request<T>(game_manager, game_id, request_from_player, round, step)) {
            remove_request<T, R>(game_manager, game_id, request_from_player, round, step, _ctx);
        };
    }

    public fun dealer_try_close_request<T, R: store + drop>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        round: u64,
        step: u64,
        ctx: &mut TxContext
    ) {
        assert!(
            game_manager.dealer == ctx.sender(),
            not_authorized_error()
        );
        try_remove_request<T, R>(game_manager, game_id, false, round, step, ctx);
    }

    public fun player_try_close_request<T, R: store + drop>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        round: u64,
        step: u64,
        ctx: &mut TxContext
    ) {
        let game = game_manager.games.borrow_mut(game_id);
        assert!(
            game.player == ctx.sender(),
            not_authorized_error()
        );
        try_remove_request<T, R>(game_manager, game_id, true, round, step, ctx);
    }

    fun assert_sender_is_dealer<T>(
        game_manager: &GameManager<T>,
        ctx: &TxContext
    ) {
        assert!(
            game_manager.dealer == ctx.sender(),
            not_authorized_error()
        );
    }

  // ---- Game End after round r step s finish----

// ---- Game Init ----

  // Case: player don't send init and just leave it there after N
  // Dealer init request
    public struct PlayerInitRequest has store, drop {
        game_id: ID,
        timestamp: u64,
    }

    public fun dealer_create_player_init_request<T>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert_sender_is_dealer(game_manager, ctx);
        let request_player_init = PlayerInitRequest {
            game_id,
            timestamp: clock::timestamp_ms(clock)
        };
        assert!(
            game_manager.games.contains(game_id),
            not_authorized_error()
        );
        add_request(game_manager, game_id, false, 0, 0, request_player_init, ctx);
    }

    public fun dealer_close_player_init_request<T>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        ctx: &mut TxContext
    ) {
        assert_sender_is_dealer(game_manager, ctx);
        try_remove_request<T, PlayerInitRequest>(game_manager, game_id, false, 0, 0, ctx);
    }


    public struct DealerNextActionRequest has store, drop {
        game_id: ID,
        timestamp: u64,
        game_action_data: GameActionData,
    }

    public fun player_close_player_init_request_by_dealer_signature<T>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        dealer_init_data_signature: vector<u8>,
        ctx: &mut TxContext
    ) {
        let dealer_init_request: DealerNextActionRequest = remove_request(game_manager, game_id, true, 0, 0, ctx);
        let game_action_data = dealer_init_request.game_action_data;
        assert!(
            game_action_data.action == ACTION_INIT &&
            game_action_data.step == 0 &&
            game_action_data.round == 0,
            not_authorized_error()
        );

        let game = game_manager.games.borrow(game_id);
        let game_action_data_bcs = bcs::to_bytes(&game_action_data);
        game.tunnel.verify_signature(
            DEALER,
            &dealer_init_data_signature,
            &game_action_data_bcs
        );
    }

    public fun player_create_dealer_init_request<T>(
        game_manager: &mut GameManager<T>,
        game_action_data: GameActionData,
        game_action_data_signature: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let game_id = game_action_data.game_id;
        let game = game_manager.games.borrow(game_id);

        assert!(
            game_action_data.action == ACTION_INIT &&
            game_action_data.step == 0 &&
            game_action_data.round == 0 &&
            game_action_data.bet_amount == game.tunnel.initial_panalty_amount_for_inactive(),
            not_authorized_error()
        );

        assert_game_balance_sum_correct(game, &game_action_data);
        assert!(
            game_action_data.balance.player == game_action_data.balance.dealer,
            incorrect_balance_error()
        );

        assert!(
            game.tunnel.value() / 2 > game_action_data.bet_amount,
            not_authorized_error()
        );

        let game_action_data_bcs = bcs::to_bytes(&game_action_data);
        game.tunnel.verify_signature(
            PLAYER,
            &game_action_data_signature,
            &game_action_data_bcs
        );

        let dealer_next_action_request = DealerNextActionRequest {
            game_id,
            timestamp: clock::timestamp_ms(clock),
            game_action_data,
        };
        try_remove_request<T, PlayerInitRequest>(game_manager, game_id, false, 0, 0, ctx);
        add_request(game_manager, game_id, true, 0, 0, dealer_next_action_request, ctx);
    }

    public fun dealer_respond_dealer_next_action_request<T>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        round: u64,
        step: u64,
        game_action_data_signature: vector<u8>,
        ctx: &mut TxContext
    ) {
        let dealer_init_request: DealerNextActionRequest = remove_request(game_manager, game_id, true, round, step, ctx);

        let game = game_manager.games.borrow(game_id);
        let game_action_data_bcs = bcs::to_bytes(&dealer_init_request.game_action_data);
        game.tunnel.verify_signature(
            DEALER,
            &game_action_data_signature,
            &game_action_data_bcs
        );
    }

    public fun punish_player_for_not_responding_to_init_request<T>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let game = game_manager.games.remove(game_id);
        let player_init_request: PlayerInitRequest = remove_request(game_manager, game_id, false, 0, 0, ctx);
        assert!(
            player_init_request.timestamp + REQUEST_FAIL_INTERVAL < clock::timestamp_ms(clock),
            time_not_pass_yet_error()
        );
        let Game { 
            id, 
            tunnel,
            player
        } = game;
        id.delete();
        let first_round_bet_amount = tunnel.initial_panalty_amount_for_inactive();
        let deposit = close_tunnel(tunnel);
        let player_balance_value = deposit.value() / 2 - first_round_bet_amount;
        let mut game_coin = coin::from_balance(deposit, ctx);
        let player_coin = game_coin.split(player_balance_value, ctx);
        transfer::public_transfer(player_coin, player);
        deposit_funds(game_manager, game_coin, ctx);
    }

    public fun punish_dealer_for_not_responding_to_next_action_request<T>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        round: u64,
        step: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let game = game_manager.games.remove(game_id);
        let dealer_init_request: DealerNextActionRequest = remove_request(game_manager, game_id, true, round, step, ctx);
        assert!(
            dealer_init_request.timestamp + REQUEST_FAIL_INTERVAL < clock::timestamp_ms(clock),
            time_not_pass_yet_error()
        );
        let Game { 
            id, 
            tunnel,
            player
        } = game;
        id.delete();
        let deposit = close_tunnel(tunnel);
        let game_action_data = dealer_init_request.game_action_data;
        let player_balance_value = deposit.value() / 2 + game_action_data.bet_amount;
        let mut game_coin = coin::from_balance(deposit, ctx);
        let player_coin = game_coin.split(player_balance_value, ctx);
        transfer::public_transfer(player_coin, player);
        deposit_funds(game_manager, game_coin, ctx);
    }

// ---- player Action after Init or Continue or Action at round r ----

  // Case: player don't send action and just leave it there after N

    public struct PlayerNextActionRequest has store, drop {
        game_id: ID,
        timestamp: u64,
        game_action_data: GameActionData,
    }

    public fun dealer_create_player_next_action_request<T>(
        game_manager: &mut GameManager<T>,
        game_action_data: GameActionData,
        player_ed25519_signature: vector<u8>,
        dealer_bls_signature: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let game_action_data_bcs = bcs::to_bytes(&game_action_data);
        let game = game_manager.games.borrow(game_action_data.game_id);
        assert_game_balance_sum_correct(game, &game_action_data);
        game.tunnel.verify_signature(
            PLAYER, // true is player
            &player_ed25519_signature,
            &game_action_data_bcs
        );
        game.tunnel.verify_signature(
            DEALER, // false is dealer
            &dealer_bls_signature,
            &game_action_data_bcs
        );
        let player_next_action_request = PlayerNextActionRequest {
            game_id: game_action_data.game_id,
            timestamp: clock::timestamp_ms(clock),
            game_action_data,
        };
        add_request(
            game_manager, 
            game_action_data.game_id, 
            false, 
            game_action_data.round, 
            game_action_data.step,
            player_next_action_request, 
            ctx
        );
    }

    // The purpose of this function is validate the previous step to the current step is legit
    // And then ask the dealer to sign it.
    public fun player_create_dealer_next_action_request<T>(
        game_manager: &mut GameManager<T>,
        previous_game_action_data: GameActionData,
        dealer_bls_signature_for_previous_action_data: vector<u8>,
        game_action_data: GameActionData,
        player_ed25519_signature_for_action_data: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let game_id = game_action_data.game_id;
        let game = game_manager.games.borrow(game_id);
        assert_game_balance_sum_correct(game, &game_action_data);

        let previous_game_action_data_bcs = bcs::to_bytes(&previous_game_action_data);
        let game_action_data_bcs = bcs::to_bytes(&game_action_data);
        game.tunnel.verify_signature(
            DEALER,
            &dealer_bls_signature_for_previous_action_data,
            &previous_game_action_data_bcs
        );
        game.tunnel.verify_signature(
            PLAYER,
            &player_ed25519_signature_for_action_data,
            &game_action_data_bcs
        );
        
        // Validate the game action data is valid from the previous one
        let mut hands = *&previous_game_action_data.current_hands;
        assert!(
            get_hand_sum(&previous_game_action_data.current_hands.player) <= 21 &&
            get_hand_sum(&previous_game_action_data.current_hands.dealer) <= 21,
            invalid_hand_error()
        );
        let mut seed = dealer_bls_signature_for_previous_action_data;        
        if(previous_game_action_data.action == ACTION_INIT){
            // Only can hit or stand after init
            assert!(
                game_action_data.action == ACTION_HIT || 
                game_action_data.action == ACTION_STAND,
                invalid_action_error()
            );
            // assert game action data is valid and consistant with previous one
            assert!(
                previous_game_action_data.round == game_action_data.round &&
                previous_game_action_data.step == 0 &&
                game_action_data.step == 1 &&
                hands.player.length() == 0 &&
                hands.dealer.length() == 0 &&
                hands.deck == create_vector_range(0, 52),
                not_authorized_error()
            );
            seed = draw_card_for(DEALER, &mut hands, seed);
            seed = draw_card_for(PLAYER, &mut hands, seed);
            draw_card_for(PLAYER, &mut hands, seed);
            assert!(
                hands == game_action_data.current_hands,
                invalid_hand_error()
            );
        } else if (previous_game_action_data.action == ACTION_HIT){
            // logic for hit
            draw_card_for(PLAYER, &mut hands, seed);
            assert!(hands == game_action_data.current_hands, invalid_hand_error());
            // if hit or stand after hit, ensure the round and the hand is legit
            if (
                game_action_data.action == ACTION_HIT || 
                game_action_data.action == ACTION_STAND
            ) {
                assert!(
                    previous_game_action_data.round == game_action_data.round &&
                    previous_game_action_data.step + 1 == game_action_data.step,
                    not_authorized_error()
                );
                assert!(
                    get_hand_sum(&game_action_data.current_hands.player) <= 21 &&
                    get_hand_sum(&game_action_data.current_hands.dealer) <= 21,
                    invalid_hand_error()
                );
            } else if (
                game_action_data.action == ACTION_INIT ||
                game_action_data.action == ACTION_SETTLE
            ) {
                // check if player brusted
                assert!(
                    get_hand_sum(&game_action_data.current_hands.player) > 21,
                    invalid_hand_error()
                );
                // check if new balance is update correctly
                let previous_bet_amount = previous_game_action_data.bet_amount;
                let mut new_balance = *&previous_game_action_data.balance;
                new_balance.dealer = new_balance.dealer + previous_bet_amount;
                new_balance.player = new_balance.player - previous_bet_amount;
                assert!(
                    new_balance == game_action_data.balance,
                    invalid_balance_error()
                );
                if (game_action_data.action == ACTION_INIT) {
                    assert!(
                        previous_game_action_data.round + 1 == game_action_data.round &&
                        game_action_data.step == 0 &&
                        new_balance.player >= game_action_data.bet_amount,
                        not_authorized_error()
                    );
                };
            } else {
                assert!(false, invalid_action_error());
            };
            assert!(false, not_authorized_error());
        } else if (previous_game_action_data.action == ACTION_STAND){
            assert!(
                game_action_data.action == ACTION_INIT || 
                game_action_data.action == ACTION_SETTLE,
                invalid_action_error()
            );
            // Logic for stand
            while (get_hand_sum(&game_action_data.current_hands.dealer) < 17) {
                draw_card_for(DEALER, &mut hands, seed);
            };
            // check new balance is legit
            let previous_bet_amount = previous_game_action_data.bet_amount;
            let mut new_balance = *&previous_game_action_data.balance;
            if (get_hand_sum(&game_action_data.current_hands.dealer) > 21 ||
                get_hand_sum(
                    &game_action_data.current_hands.dealer
                ) < get_hand_sum(
                    &game_action_data.current_hands.player
                )
            ) {
                // player win
                new_balance.dealer = new_balance.dealer - previous_bet_amount;
                new_balance.player = new_balance.player + previous_bet_amount;
            } else { 
                // dealer win
                new_balance.dealer = new_balance.dealer + previous_bet_amount;
                new_balance.player = new_balance.player - previous_bet_amount;
            };
            assert!(
                new_balance == game_action_data.balance,
                invalid_balance_error()
            );
            if (game_action_data.action == ACTION_INIT) {
                assert!(
                    previous_game_action_data.round + 1 == game_action_data.round &&
                    game_action_data.step == 0 &&
                    new_balance.player >= game_action_data.bet_amount,
                    not_authorized_error()
                );
            };
        } else {
            assert!(false, not_authorized_error());
        };
        
        let dealer_next_action_request = DealerNextActionRequest {
            game_id,
            timestamp: clock::timestamp_ms(clock),
            game_action_data,
        };
        if (have_request<T>(
            game_manager, 
            game_id, 
            false,
            game_action_data.round,
            game_action_data.round
        )) {
            let player_next_action_reqeust = remove_request<T, PlayerNextActionRequest>(
                game_manager,
                game_id,
                false,
                game_action_data.round,
                game_action_data.round,
                ctx
            );
            assert!(
                player_next_action_reqeust.game_action_data == previous_game_action_data,
                not_authorized_error()
            )
        };
        try_remove_request<T, PlayerNextActionRequest>(
            game_manager,
            game_id,
            false,
            game_action_data.round,
            game_action_data.round,
            ctx
        );
        add_request(
            game_manager,
            game_id,
            true,
            game_action_data.round,
            game_action_data.step,
            dealer_next_action_request,
            ctx
        );
    }

    public fun punish_player_for_not_responding_to_next_action_request<T>(
        game_manager: &mut GameManager<T>,
        game_id: ID,
        round: u64,
        step: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let game = game_manager.games.remove(game_id);
        let player_next_action_request: PlayerNextActionRequest = remove_request(game_manager, game_id, false, round, step, ctx);
        assert!(
            player_next_action_request.timestamp + REQUEST_FAIL_INTERVAL < clock::timestamp_ms(clock),
            time_not_pass_yet_error()
        );
        let Game { 
            id, 
            tunnel,
            player
        } = game;
        id.delete();
        let deposit = close_tunnel(tunnel);
        let game_action_data = player_next_action_request.game_action_data;
        let player_balance_value = deposit.value() / 2 - game_action_data.bet_amount;
        let mut game_coin = coin::from_balance(deposit, ctx);
        let player_coin = game_coin.split(player_balance_value, ctx);
        transfer::public_transfer(player_coin, player);
        deposit_funds(game_manager, game_coin, ctx);
    }
    
    public fun settle_game<T>(
        game_manager: &mut GameManager<T>,
        game_action_data: GameActionData,
        player_ed25519_signature: vector<u8>,
        dealer_bls_signature: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(game_action_data.action == ACTION_SETTLE, invalid_action_error());
        let game_id = game_action_data.game_id;
        let game = game_manager.games.remove(game_id);
        let game_action_data_bcs = bcs::to_bytes(&game_action_data);
        game.tunnel.verify_signature(
            DEALER,
            &dealer_bls_signature,
            &game_action_data_bcs
        );
        game.tunnel.verify_signature(
            PLAYER,
            &player_ed25519_signature,
            &game_action_data_bcs
        );
        let Game { 
            id, 
            tunnel,
            player
        } = game;
        id.delete();
        game_manager.player_key_game_table.remove(tunnel.partyA_public_key());
        let deposit = close_tunnel(
            tunnel
        );
        let mut game_coin = coin::from_balance(deposit, ctx);
        let player_coin = game_coin.split(game_action_data.balance.player, ctx);
        transfer::public_transfer(player_coin, player);
        deposit_funds(game_manager, game_coin, ctx);
    }
}
