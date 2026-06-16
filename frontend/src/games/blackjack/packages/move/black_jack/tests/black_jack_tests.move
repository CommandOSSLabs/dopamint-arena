#[test_only]
#[allow(unused_variable, unused_use)]
module black_jack::black_jack_tests {
    // uncomment this line to import the module
    use black_jack::black_jack::{
        Self, 
        create_party_balance, 
        GameManager,
        get_request_fail_interval,
    };
    use black_jack::tunnel;
    use black_jack::error;
    use black_jack::test_utils::{
        assert_balance_equal_to,
        assert_manager_balance_equal_to
    };
    use black_jack::utils::{
        derive_random_u8_in_range,
        create_vector_range
    };
    use std::debug::{print};
    use std::string::{utf8};
    // use std::bcs;
    use sui::test_scenario::{Self, Scenario};
    use sui::coin::{Self, Coin};
    use sui::clock;
    // use std::vector;
    use black_jack::test_coin::{TEST_COIN};

    const DEALER: address = @0x1;
    const PLAYER: address = @0x2;
    const CLOCK_DEFAULT_TIME: u64 = 1687975971000;
    const BET_AMOUNT: u64 = 5;
    
    // Begin of Test Modular Functions

        use fun test_initialize_game_manager as Scenario.test_initialize_game_manager;

        fun test_initialize_game_manager(
            scenario: &mut Scenario,
            dealer: address
        ) {
            let bls_public_key: vector<u8> = x"b8575116de61bc9d3d9cd12eda5517d0b6151323430eaa0f059a5d44dd387ea47e3a3b290e427dc45b577e183df20ae6";
            let funding = coin::mint_for_testing<TEST_COIN>(1000, scenario.ctx());
            black_jack::create_game_manager(
                    dealer,
                    bls_public_key,
                    funding,
                    scenario.ctx()
            );
        }

        use fun test_create_game as Scenario.test_create_game;

        fun test_create_game(
            scenario: &mut Scenario,
            player: address,
        ): ID {
            scenario.next_tx(player);

            let ed25519_public_key: vector<u8> = x"fbb43a94aa97d1fea6c00244e27501384934f504b5d0c108af2ea0c71ce8d852";
            let randomness_seed: vector<u8> = x"868f";
            let deposit = coin::mint_for_testing<TEST_COIN>(100, scenario.ctx());
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            
            let game_id = black_jack::create_game(
                &mut game_manager,
                deposit,
                BET_AMOUNT,
                ed25519_public_key,
                scenario.ctx()
            );
            test_scenario::return_shared(game_manager);
            game_id
        }

        use fun test_create_player_init_request as Scenario.test_create_player_init_request;

        fun test_create_player_init_request(
            scenario: &mut Scenario,
            dealer: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(dealer);
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            black_jack::dealer_create_player_init_request(
                    &mut game_manager,
                    game_id,
                    clockObj,
                    scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_punish_player_for_not_responding_to_init_request as Scenario.test_punish_player_for_not_responding_to_init_request;

        fun test_punish_player_for_not_responding_to_init_request(
            scenario: &mut Scenario,
            dealer: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(dealer);
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            black_jack::punish_player_for_not_responding_to_init_request(
                &mut game_manager,
                game_id,
                clockObj,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

         use fun test_player_create_dealer_init_request as Scenario.test_player_create_dealer_init_request;

        fun test_player_create_dealer_init_request(
            scenario: &mut Scenario,
            player: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(player);

            let randomness_seed: vector<u8> = x"868f";
            let ed25519_public_key: vector<u8> = x"fbb43a94aa97d1fea6c00244e27501384934f504b5d0c108af2ea0c71ce8d852";

            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();

            
            let partyBalance = black_jack::create_party_balance(100, 100);
            let current_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
                );
            let game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                randomness_seed,
                BET_AMOUNT,
                0,
                0,
                0,
                current_hands
            );
            let game_action_data_signature: vector<u8> = x"99b29ad9214d538008a07a5d515743cda9d9bbd6009a928b72e27be423280dbee654ec2053067a73d54cb9a3f12549125fbb2a040a698931c6b687d8243fc906";
            // Error request not found
            black_jack::player_create_dealer_init_request<TEST_COIN>(
                &mut game_manager,
                game_action_data,
                game_action_data_signature,
                clockObj,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_punish_dealer_for_not_responding_to_next_action_request as Scenario.test_punish_dealer_for_not_responding_to_next_action_request;

        fun test_punish_dealer_for_not_responding_to_next_action_request(
            scenario: &mut Scenario,
            player: address,
            game_id: ID,
            round: u64,
            step: u64,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(player);
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            black_jack::punish_dealer_for_not_responding_to_next_action_request<TEST_COIN>(
                &mut game_manager,
                game_id,
                round,
                step,
                clockObj,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_dealer_respond_dealer_next_action_request_at_init as Scenario.test_dealer_respond_dealer_next_action_request_at_init;

        fun test_dealer_respond_dealer_next_action_request_at_init(
            scenario: &mut Scenario,
            dealer: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(dealer);

            let init_game_action_data_bls_signature = x"908278559b69c77b99983e531a4655ea88696197ed81eae8f50a58d95a233cb206545c3c942f8b0bd864414f1f535bbc0d12f3b1c4cd9cfe3b808d069e1a2aa76c99151f9e3808b83afdf25d7886e18a8ca6fb0b9e39cba5a94dca3d0fd2afce";
            
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            black_jack::dealer_respond_dealer_next_action_request(
                &mut game_manager,
                game_id,
                0,
                0,
                init_game_action_data_bls_signature,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_dealer_create_player_next_action_request_for_round_0_step_1 as Scenario.test_dealer_create_player_next_action_request_for_round_0_step_1;
        fun test_dealer_create_player_next_action_request_for_round_0_step_1(
            scenario: &mut Scenario,
            dealer: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(dealer);
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            let partyBalance = black_jack::create_party_balance(100, 100);
            let previous_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
            );
            let previous_game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                x"868f",
                BET_AMOUNT,
                0,
                0,
                0,
                previous_hands,
            );
            let previous_game_action_data_bls_signature = x"908278559b69c77b99983e531a4655ea88696197ed81eae8f50a58d95a233cb206545c3c942f8b0bd864414f1f535bbc0d12f3b1c4cd9cfe3b808d069e1a2aa76c99151f9e3808b83afdf25d7886e18a8ca6fb0b9e39cba5a94dca3d0fd2afce";
            let previous_game_action_data_ed25519_signature = x"99b29ad9214d538008a07a5d515743cda9d9bbd6009a928b72e27be423280dbee654ec2053067a73d54cb9a3f12549125fbb2a040a698931c6b687d8243fc906";
            black_jack::dealer_create_player_next_action_request(
                &mut game_manager,
                previous_game_action_data,
                previous_game_action_data_ed25519_signature,
                previous_game_action_data_bls_signature,
                clockObj,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_player_create_dealer_next_action_request_for_round_0_step_1 as Scenario.test_player_create_dealer_next_action_request_for_round_0_step_1;
        fun test_player_create_dealer_next_action_request_for_round_0_step_1(
            scenario: &mut Scenario,
            player: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(player);
            let randomness_seed: vector<u8> = x"868f";
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            let partyBalance = black_jack::create_party_balance(100, 100);
            let previous_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
            );
            let previous_game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                randomness_seed,
                BET_AMOUNT,
                0,
                0,
                0,
                previous_hands,
            );
            let previous_game_action_data_bls_signature = x"908278559b69c77b99983e531a4655ea88696197ed81eae8f50a58d95a233cb206545c3c942f8b0bd864414f1f535bbc0d12f3b1c4cd9cfe3b808d069e1a2aa76c99151f9e3808b83afdf25d7886e18a8ca6fb0b9e39cba5a94dca3d0fd2afce";
            
            let mut current_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
            );
            let mut seed = previous_game_action_data_bls_signature;
            seed = black_jack::draw_card_for(false, &mut current_hands, seed);
            seed = black_jack::draw_card_for(true, &mut current_hands, seed);
            black_jack::draw_card_for(true, &mut current_hands, seed);

            let game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                randomness_seed,
                BET_AMOUNT,
                0,
                1,
                1,
                current_hands,
            );
            let game_action_data_ed25519_signature: vector<u8> = x"78ea128bdbb6cec09a041d431a0fe7e3611d9b01ab27658bda724ea0ec1020fb7820fc5731b1a7e1d78ba8eab2ba9a3d07e2280519414eb7c804df875b8d1d04";
            // Error request not found
            black_jack::player_create_dealer_next_action_request<TEST_COIN>(
                &mut game_manager,
                previous_game_action_data,
                previous_game_action_data_bls_signature,
                game_action_data,
                game_action_data_ed25519_signature,
                clockObj,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_dealer_respond_dealer_next_action_request_for_round_0_step_1 as Scenario.test_dealer_respond_dealer_next_action_request_for_round_0_step_1;
        fun test_dealer_respond_dealer_next_action_request_for_round_0_step_1(
            scenario: &mut Scenario,
            dealer: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(dealer);
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            let dealer_bls_signature = x"afa4a3ce171dfea87f6aaf68b30e1a097a256bcabe2a620c8dbca5055d3ea2ec950a44b0daf5046882a57d7a54ae2f7e0980ea7e0f9dac73ade9652a39814865f9fd13ba06df6bf4ca0e15129856843ba561d89d432d2c34a47411c3311a7084";
            black_jack::dealer_respond_dealer_next_action_request(
                &mut game_manager,
                game_id,
                0,
                1,
                dealer_bls_signature,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_dealer_create_player_next_action_request_for_round_0_step_1_with_wrong_bls_signature as Scenario.test_dealer_create_player_next_action_request_for_round_0_step_1_with_wrong_bls_signature;
        fun test_dealer_create_player_next_action_request_for_round_0_step_1_with_wrong_bls_signature(
            scenario: &mut Scenario,
            dealer: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(dealer);
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            let partyBalance = black_jack::create_party_balance(100, 100);
            let previous_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
            );
            let previous_game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                x"868f",
                BET_AMOUNT,
                0,
                0,
                0,
                previous_hands,
            );
            let previous_game_action_data_bls_signature = x"CAFE";
            let previous_game_action_data_ed25519_signature = x"99b29ad9214d538008a07a5d515743cda9d9bbd6009a928b72e27be423280dbee654ec2053067a73d54cb9a3f12549125fbb2a040a698931c6b687d8243fc906";
            black_jack::dealer_create_player_next_action_request(
                &mut game_manager,
                previous_game_action_data,
                previous_game_action_data_ed25519_signature,
                previous_game_action_data_bls_signature,
                clockObj,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_dealer_create_player_next_action_request_for_round_0_step_1_with_wrong_ed25519_signature as Scenario.test_dealer_create_player_next_action_request_for_round_0_step_1_with_wrong_ed25519_signature;
        fun test_dealer_create_player_next_action_request_for_round_0_step_1_with_wrong_ed25519_signature(
            scenario: &mut Scenario,
            dealer: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(dealer);
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            let partyBalance = black_jack::create_party_balance(100, 100);
            let previous_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
            );
            let previous_game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                x"868f",
                BET_AMOUNT,
                0,
                0,
                0,
                previous_hands,
            );
            let previous_game_action_data_bls_signature = x"908278559b69c77b99983e531a4655ea88696197ed81eae8f50a58d95a233cb206545c3c942f8b0bd864414f1f535bbc0d12f3b1c4cd9cfe3b808d069e1a2aa76c99151f9e3808b83afdf25d7886e18a8ca6fb0b9e39cba5a94dca3d0fd2afce";
            let previous_game_action_data_ed25519_signature = x"CAFE";
            black_jack::dealer_create_player_next_action_request(
                &mut game_manager,
                previous_game_action_data,
                previous_game_action_data_ed25519_signature,
                previous_game_action_data_bls_signature,
                clockObj,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_player_create_dealer_next_action_request_for_round_0_step_1_with_wrong_bls_signature as Scenario.test_player_create_dealer_next_action_request_for_round_0_step_1_with_wrong_bls_signature;
        fun test_player_create_dealer_next_action_request_for_round_0_step_1_with_wrong_bls_signature(
            scenario: &mut Scenario,
            player: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(player);
            let randomness_seed: vector<u8> = x"868f";
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            let partyBalance = black_jack::create_party_balance(100, 100);
            let previous_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
            );
            let previous_game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                randomness_seed,
                BET_AMOUNT,
                0,
                0,
                0,
                previous_hands,
            );
            let previous_game_action_data_bls_signature = x"CAFE";
            
            let mut current_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
            );
            let mut seed = previous_game_action_data_bls_signature;
            seed = black_jack::draw_card_for(false, &mut current_hands, seed);
            seed = black_jack::draw_card_for(true, &mut current_hands, seed);
            black_jack::draw_card_for(true, &mut current_hands, seed);

            let game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                randomness_seed,
                BET_AMOUNT,
                0,
                1,
                1,
                current_hands,
            );
            let game_action_data_ed25519_signature: vector<u8> = x"78ea128bdbb6cec09a041d431a0fe7e3611d9b01ab27658bda724ea0ec1020fb7820fc5731b1a7e1d78ba8eab2ba9a3d07e2280519414eb7c804df875b8d1d04";
            black_jack::player_create_dealer_next_action_request<TEST_COIN>(
                &mut game_manager,
                previous_game_action_data,
                previous_game_action_data_bls_signature,
                game_action_data,
                game_action_data_ed25519_signature,
                clockObj,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_player_create_dealer_next_action_request_for_round_0_step_1_with_wrong_ed25519_signature as Scenario.test_player_create_dealer_next_action_request_for_round_0_step_1_with_wrong_ed25519_signature;
        fun test_player_create_dealer_next_action_request_for_round_0_step_1_with_wrong_ed25519_signature(
            scenario: &mut Scenario,
            player: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(player);
            let randomness_seed: vector<u8> = x"868f";
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            let partyBalance = black_jack::create_party_balance(100, 100);
            let previous_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
            );
            let previous_game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                randomness_seed,
                BET_AMOUNT,
                0,
                0,
                0,
                previous_hands,
            );
            let previous_game_action_data_bls_signature = x"908278559b69c77b99983e531a4655ea88696197ed81eae8f50a58d95a233cb206545c3c942f8b0bd864414f1f535bbc0d12f3b1c4cd9cfe3b808d069e1a2aa76c99151f9e3808b83afdf25d7886e18a8ca6fb0b9e39cba5a94dca3d0fd2afce";
            let previous_game_action_data_ed25519_signature = x"CAFE";
            
            let mut current_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
            );
            let mut seed = previous_game_action_data_bls_signature;
            seed = black_jack::draw_card_for(false, &mut current_hands, seed);
            seed = black_jack::draw_card_for(true, &mut current_hands, seed);
            black_jack::draw_card_for(true, &mut current_hands, seed);

            let game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                randomness_seed,
                BET_AMOUNT,
                0,
                1,
                1,
                current_hands,
            );
            let game_action_data_ed25519_signature: vector<u8> = x"CAFE";
            black_jack::player_create_dealer_next_action_request<TEST_COIN>(
                &mut game_manager,
                previous_game_action_data,
                previous_game_action_data_bls_signature,
                game_action_data,
                game_action_data_ed25519_signature,
                clockObj,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_dealer_respond_dealer_next_action_request_for_round_0_step_1_with_wrong_bls_signature as Scenario.test_dealer_respond_dealer_next_action_request_for_round_0_step_1_with_wrong_bls_signature;
        fun test_dealer_respond_dealer_next_action_request_for_round_0_step_1_with_wrong_bls_signature(
            scenario: &mut Scenario,
            dealer: address,
            game_id: ID,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(dealer);
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            let dealer_bls_signature = x"CAFE";
            black_jack::dealer_respond_dealer_next_action_request(
                &mut game_manager,
                game_id,
                0,
                1,
                dealer_bls_signature,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

        use fun test_punish_player_for_not_responding_to_next_action_request as Scenario.test_punish_player_for_not_responding_to_next_action_request;
        fun test_punish_player_for_not_responding_to_next_action_request(
            scenario: &mut Scenario,
            dealer: address,
            game_id: ID,
            round: u64,
            step: u64,
            clockObj: &clock::Clock,
        ) {
            scenario.next_tx(dealer);
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();
            black_jack::punish_player_for_not_responding_to_next_action_request(
                &mut game_manager,
                game_id,
                round,
                step,
                clockObj,
                scenario.ctx(),
            );
            test_scenario::return_shared(game_manager);
        }

    // End of Test Modular Functions
    
    #[test]
    #[expected_failure(abort_code = error::ErrorTimeNotPassYet, location = black_jack)]
    fun test_dealer_create_player_init_request_and_punish_player_before_deadline_fail() {

        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
    

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
        scenario.test_create_player_init_request(DEALER, game_id, &clockObj);

        clockObj.set_for_testing(CLOCK_DEFAULT_TIME + 1);
        scenario.test_punish_player_for_not_responding_to_init_request(DEALER, game_id, &clockObj);
    
        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 0, location = sui::dynamic_field)]
    fun test_dealer_create_multiple_player_init_request_fail() {

        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
        scenario.test_create_player_init_request(DEALER, game_id, &clockObj);

        clockObj.set_for_testing(CLOCK_DEFAULT_TIME + 3);
        scenario.test_create_player_init_request(DEALER, game_id, &clockObj);
        
        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    fun test_dealer_create_player_init_request_and_punish_player_after_deadline() {

        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
        scenario.test_create_player_init_request(DEALER, game_id, &clockObj);

        clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
        scenario.test_punish_player_for_not_responding_to_init_request(DEALER, game_id, &clockObj);

        scenario.next_tx(DEALER);
        assert_balance_equal_to(&mut scenario, PLAYER, 100 - BET_AMOUNT);
        assert_manager_balance_equal_to(&mut scenario, 1000 + BET_AMOUNT);

        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 1, location = sui::dynamic_field)]
    fun test_dealer_create_player_init_request_and_player_response_it_then_dealer_punish_player_after_deadline_fail() {

        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
        scenario.test_create_player_init_request(DEALER, game_id, &clockObj);    


        scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

        clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
        scenario.test_punish_player_for_not_responding_to_init_request(DEALER, game_id, &clockObj);

        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    fun test_dealer_create_player_init_request_and_player_response_it_then_punish_dealer_after_deadline() {

        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
        scenario.test_create_player_init_request(DEALER, game_id, &clockObj);
    
        scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

        clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
        scenario.test_punish_dealer_for_not_responding_to_next_action_request(PLAYER, game_id, 0, 0, &clockObj);

        scenario.next_tx(PLAYER);
        {
            assert_balance_equal_to(&mut scenario, PLAYER, 100 + BET_AMOUNT);
            assert_manager_balance_equal_to(&mut scenario, 1000 - BET_AMOUNT);
        };
        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = error::ErrorTimeNotPassYet, location = black_jack)]
    fun test_player_create_dealer_init_request_then_punish_dealer_before_deadline_fail() {

        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clockObj, CLOCK_DEFAULT_TIME);

        scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

        clock::set_for_testing(&mut clockObj, CLOCK_DEFAULT_TIME + 1);
        scenario.test_punish_dealer_for_not_responding_to_next_action_request(PLAYER, game_id, 0, 0, &clockObj);

        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    fun test_player_create_init_request_then_punish_dealer_after_deadline() {

        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clockObj, CLOCK_DEFAULT_TIME);
        
        scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

        clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
        scenario.test_punish_dealer_for_not_responding_to_next_action_request(PLAYER, game_id, 0, 0, &clockObj);

        scenario.next_tx(PLAYER);
        {
            assert_balance_equal_to(&mut scenario, PLAYER, 100 + BET_AMOUNT);
            assert_manager_balance_equal_to(&mut scenario, 1000 - BET_AMOUNT);
        };
        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 0, location = sui::dynamic_field)]
    fun test_player_create_multiple_dealer_init_request_fail() {

        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        
        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clockObj, CLOCK_DEFAULT_TIME);

        scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

        scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);
        
        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    fun test_dealer_create_init_request_and_player_response_it_then_dealer_response_it() {

        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
        scenario.test_create_player_init_request(DEALER, game_id, &clockObj);
        
        scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

        scenario.test_dealer_respond_dealer_next_action_request_at_init(DEALER, game_id, &clockObj);

        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 1, location = sui::dynamic_field)]
    fun test_dealer_create_init_request_and_player_response_it_then_dealer_response_it_then_player_punish_dealer_after_deadline_fail() {

        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);
        scenario.test_create_player_init_request(DEALER, game_id, &clockObj);
        
        scenario.test_player_create_dealer_init_request(PLAYER, game_id, &clockObj);

        scenario.test_dealer_respond_dealer_next_action_request_at_init(DEALER, game_id, &clockObj);

        clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
        scenario.test_punish_dealer_for_not_responding_to_next_action_request(PLAYER, game_id, 0, 0, &clockObj);

        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    fun test_dealer_create_player_next_action_request_then_player_create_dealer_next_action_request_then_dealer_resolve_it() {
        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);


        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);

        scenario.test_dealer_create_player_next_action_request_for_round_0_step_1(
            DEALER,
            game_id,
            &clockObj,
        );
        
        scenario.test_player_create_dealer_next_action_request_for_round_0_step_1(
            PLAYER,
            game_id,
            &clockObj,
        );

        // test_dealer_respond_dealer_next_action_request_for_round_0_step_1
        scenario.test_dealer_respond_dealer_next_action_request_for_round_0_step_1(
            DEALER,
            game_id,
            &clockObj,
        );
        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = error::ErrorInvalidSignature, location = tunnel)]
    fun test_dealer_create_player_next_action_request_with_wrong_bls_signature() {
        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);

        scenario.test_dealer_create_player_next_action_request_for_round_0_step_1_with_wrong_bls_signature(
            DEALER,
            game_id,
            &clockObj,
        );
        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = error::ErrorInvalidSignature, location = tunnel)]
    fun test_dealer_create_player_next_action_request_with_wrong_ed25519_signature() {
        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);

        scenario.test_dealer_create_player_next_action_request_for_round_0_step_1_with_wrong_ed25519_signature(
            DEALER,
            game_id,
            &clockObj,
        );
        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = error::ErrorInvalidSignature, location = tunnel)]
    fun test_player_create_dealer_next_action_request_with_wrong_bls_signature() {
        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);

        scenario.test_player_create_dealer_next_action_request_for_round_0_step_1_with_wrong_bls_signature(
            PLAYER,
            game_id,
            &clockObj,
        );
        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = error::ErrorInvalidSignature, location = tunnel)]
    fun test_player_create_dealer_next_action_request_with_wrong_ed25519_signature() {
        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);

        scenario.test_player_create_dealer_next_action_request_for_round_0_step_1_with_wrong_ed25519_signature(
            PLAYER,
            game_id,
            &clockObj,
        );
        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = error::ErrorInvalidSignature, location = tunnel)]
    fun test_dealer_respond_dealer_next_action_request_with_wrong_bls_signature() {
        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);

        scenario.test_dealer_create_player_next_action_request_for_round_0_step_1(
            DEALER,
            game_id,
            &clockObj,
        );
        
        scenario.test_player_create_dealer_next_action_request_for_round_0_step_1(
            PLAYER,
            game_id,
            &clockObj,
        );

        scenario.test_dealer_respond_dealer_next_action_request_for_round_0_step_1_with_wrong_bls_signature(
            DEALER,
            game_id,
            &clockObj,
        );
        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    

    #[test]
    fun test_dealer_create_player_next_action_request_then_player_create_dealer_next_action_request_then_punish_dealer() {
        
    }

    #[test]
    fun test_dealer_create_player_next_action_request_then_punish_dealer() {
    }

    #[test]
    fun test_player_create_dealer_next_action_request() {
        let bls_public_key: vector<u8> = x"b8575116de61bc9d3d9cd12eda5517d0b6151323430eaa0f059a5d44dd387ea47e3a3b290e427dc45b577e183df20ae6";
        let ed25519_public_key: vector<u8> = x"fbb43a94aa97d1fea6c00244e27501384934f504b5d0c108af2ea0c71ce8d852";
        let randomness_seed: vector<u8> = x"868f";

        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);
        
        scenario.next_tx(PLAYER);
        {
            let mut game_manager: GameManager<TEST_COIN> = scenario.take_shared();

            let mut clockObj = clock::create_for_testing(scenario.ctx());
            clock::set_for_testing(&mut clockObj, CLOCK_DEFAULT_TIME);
            let partyBalance = black_jack::create_party_balance(100, 100);
            let previous_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
            );
            let previous_game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                randomness_seed,
                BET_AMOUNT,
                0,
                0,
                0,
                previous_hands,
            );
            let previous_game_action_data_bls_signature = x"908278559b69c77b99983e531a4655ea88696197ed81eae8f50a58d95a233cb206545c3c942f8b0bd864414f1f535bbc0d12f3b1c4cd9cfe3b808d069e1a2aa76c99151f9e3808b83afdf25d7886e18a8ca6fb0b9e39cba5a94dca3d0fd2afce";
            
            let mut current_hands = black_jack::create_hands(
                vector::empty(),
                vector::empty(),
                create_vector_range(0, 52)
            );
            let mut seed = previous_game_action_data_bls_signature;
            seed = black_jack::draw_card_for(false, &mut current_hands, seed);
            seed = black_jack::draw_card_for(true, &mut current_hands, seed);
            black_jack::draw_card_for(true, &mut current_hands, seed);

            let game_action_data = black_jack::create_game_action_data(
                game_id,
                partyBalance,
                randomness_seed,
                BET_AMOUNT,
                0,
                1,
                1,
                current_hands,
            );
            let game_action_data_ed25519_signature: vector<u8> = x"78ea128bdbb6cec09a041d431a0fe7e3611d9b01ab27658bda724ea0ec1020fb7820fc5731b1a7e1d78ba8eab2ba9a3d07e2280519414eb7c804df875b8d1d04";
            // Error request not found
            black_jack::player_create_dealer_next_action_request<TEST_COIN>(
                &mut game_manager,
                previous_game_action_data,
                previous_game_action_data_bls_signature,
                game_action_data,
                game_action_data_ed25519_signature,
                &clockObj,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clockObj);
            test_scenario::return_shared(game_manager);
        };
        
        scenario.end();
    }

    #[test]
    fun test_dealer_create_player_next_action_request_and_punish_player_after_deadline() {
        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);

        scenario.test_dealer_create_player_next_action_request_for_round_0_step_1(
            DEALER,
            game_id,
            &clockObj,
        );

        clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
        scenario.test_punish_player_for_not_responding_to_next_action_request(
            DEALER,
            game_id,
            0,
            0,
            &clockObj,
        );

        scenario.next_tx(DEALER);
        assert_balance_equal_to(&mut scenario, PLAYER, 100 - BET_AMOUNT);
        assert_manager_balance_equal_to(&mut scenario, 1000 + BET_AMOUNT);

        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = error::ErrorTimeNotPassYet, location = black_jack)]
    fun test_dealer_create_player_next_action_request_and_punish_player_before_deadline_fail() {
        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);

        scenario.test_dealer_create_player_next_action_request_for_round_0_step_1(
            DEALER,
            game_id,
            &clockObj,
        );

        clockObj.set_for_testing(CLOCK_DEFAULT_TIME + 1);
        scenario.test_punish_player_for_not_responding_to_next_action_request(
            DEALER,
            game_id,
            0,
            0,
            &clockObj,
        );

        clock::destroy_for_testing(clockObj);
        scenario.end();
    }

    #[test]
    fun test_dealer_create_player_next_action_request_then_player_create_dealer_next_action_request_then_punish_dealer_after_deadline() {
        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);

        scenario.test_dealer_create_player_next_action_request_for_round_0_step_1(
            DEALER,
            game_id,
            &clockObj,
        );

        scenario.test_player_create_dealer_next_action_request_for_round_0_step_1(
            PLAYER,
            game_id,
            &clockObj,
        );

        clockObj.set_for_testing(CLOCK_DEFAULT_TIME + get_request_fail_interval() + 1);
        scenario.test_punish_dealer_for_not_responding_to_next_action_request(
            PLAYER,
            game_id,
            0,
            1,
            &clockObj,
        );

        scenario.next_tx(PLAYER);
        assert_balance_equal_to(&mut scenario, PLAYER, 100 + BET_AMOUNT);
        assert_manager_balance_equal_to(&mut scenario, 1000 - BET_AMOUNT);

        clock::destroy_for_testing(clockObj);
        scenario.end();
    }


    #[test]
    #[expected_failure(abort_code = error::ErrorTimeNotPassYet, location = black_jack)]
    fun test_player_create_dealer_next_action_request_then_punish_dealer_before_deadline_fail(){
        let mut scenario = test_scenario::begin(DEALER);
        scenario.test_initialize_game_manager(DEALER);
        let game_id = scenario.test_create_game(PLAYER);

        let mut clockObj = clock::create_for_testing(scenario.ctx());
        clockObj.set_for_testing(CLOCK_DEFAULT_TIME);

        scenario.test_dealer_create_player_next_action_request_for_round_0_step_1(
            DEALER,
            game_id,
            &clockObj,
        );

        scenario.test_player_create_dealer_next_action_request_for_round_0_step_1(
            PLAYER,
            game_id,
            &clockObj,
        );

        clockObj.set_for_testing(CLOCK_DEFAULT_TIME + 1);
        scenario.test_punish_dealer_for_not_responding_to_next_action_request(
            PLAYER,
            game_id,
            0,
            1,
            &clockObj,
        );

        clock::destroy_for_testing(clockObj);
        scenario.end();
    }
}

