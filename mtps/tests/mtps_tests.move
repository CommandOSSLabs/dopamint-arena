#[test_only]
module mtps::mtps_tests {
    use mtps::mtps::{Self, MtpsFaucet, MTPS};
    use sui::test_scenario as ts;
    use sui::coin::Coin;

    #[test]
    fun faucet_mints_fresh_coin_to_recipient() {
        let deployer = @0xA;
        let user = @0xB;
        let mut scenario = ts::begin(deployer);
        mtps::test_init(scenario.ctx());

        // The faucet is a shared object after init.
        scenario.next_tx(deployer);
        let mut faucet = scenario.take_shared<MtpsFaucet>();
        mtps::mint(&mut faucet, 500, user, scenario.ctx());
        // Mint again — new supply each call, so the faucet never depletes.
        mtps::mint(&mut faucet, 1_000, user, scenario.ctx());
        ts::return_shared(faucet);

        // The user received two freshly-minted MTPS coins.
        scenario.next_tx(user);
        let c1 = scenario.take_from_sender<Coin<MTPS>>();
        let c2 = scenario.take_from_sender<Coin<MTPS>>();
        assert!(c1.value() + c2.value() == 1_500, 0);
        scenario.return_to_sender(c1);
        scenario.return_to_sender(c2);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = mtps::E_MINT_DISABLED)]
    fun mint_aborts_when_disabled() {
        let deployer = @0xA;
        let mut scenario = ts::begin(deployer);
        mtps::test_init(scenario.ctx());
        scenario.next_tx(deployer);
        let mut faucet = scenario.take_shared<MtpsFaucet>();
        mtps::set_can_mint(&mut faucet, false, scenario.ctx());
        mtps::mint(&mut faucet, 1, deployer, scenario.ctx()); // aborts
        ts::return_shared(faucet);
        scenario.end();
    }
}
