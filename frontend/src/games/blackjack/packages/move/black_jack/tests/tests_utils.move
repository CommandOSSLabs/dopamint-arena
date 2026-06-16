#[test_only]
module black_jack::test_utils {
    use black_jack::black_jack::{
        Self,
        GameManager,
    };
    use sui::test_scenario;
    use sui::coin::{Coin};
    use black_jack::test_coin::{TEST_COIN};

    public fun assert_balance_equal_to(
        ts: &mut test_scenario::Scenario,
        address: address,
        expected_balance: u64,
    ) {
        let coin = ts.take_from_address<Coin<TEST_COIN>>(address);
        let value = coin.value();
        assert!(value == expected_balance, 0);
        test_scenario::return_to_address<Coin<TEST_COIN>>(address, coin);
    }

    public fun assert_manager_balance_equal_to(
        ts: &mut test_scenario::Scenario,
        expected_balance: u64,
    ) {
        let game_manager: GameManager<TEST_COIN> = ts.take_shared();
        let balance = black_jack::get_fund_value(&game_manager);
        assert!(balance == expected_balance, 0);
        test_scenario::return_shared(game_manager);
    }
}

