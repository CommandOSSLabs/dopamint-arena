#[test_only]
module dopamint::dopamint_tests {
    use dopamint::dopamint::{Self, DopamintFaucet, DOPAMINT};
    use sui::test_scenario as ts;
    use sui::coin::Coin;

    #[test]
    fun faucet_mints_fresh_coin_to_recipient() {
        let deployer = @0xA;
        let user = @0xB;
        let mut scenario = ts::begin(deployer);
        dopamint::test_init(scenario.ctx());

        // The faucet is a shared object after init.
        scenario.next_tx(deployer);
        let mut faucet = scenario.take_shared<DopamintFaucet>();
        dopamint::mint(&mut faucet, 500, user, scenario.ctx());
        // Mint again — new supply each call, so the faucet never depletes.
        dopamint::mint(&mut faucet, 1_000, user, scenario.ctx());
        ts::return_shared(faucet);

        // The user received two freshly-minted DOPAMINT coins.
        scenario.next_tx(user);
        let c1 = scenario.take_from_sender<Coin<DOPAMINT>>();
        let c2 = scenario.take_from_sender<Coin<DOPAMINT>>();
        assert!(c1.value() + c2.value() == 1_500, 0);
        scenario.return_to_sender(c1);
        scenario.return_to_sender(c2);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = dopamint::E_MINT_DISABLED)]
    fun mint_aborts_when_disabled() {
        let deployer = @0xA;
        let mut scenario = ts::begin(deployer);
        dopamint::test_init(scenario.ctx());
        scenario.next_tx(deployer);
        let mut faucet = scenario.take_shared<DopamintFaucet>();
        dopamint::set_can_mint(&mut faucet, false, scenario.ctx());
        dopamint::mint(&mut faucet, 1, deployer, scenario.ctx()); // aborts
        ts::return_shared(faucet);
        scenario.end();
    }
}
