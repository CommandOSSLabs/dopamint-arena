#[test_only]
module mtps::mtps_tests {
    use mtps::mtps::{Self, MtpsFaucet, AdminCap, MTPS};
    use sui::test_scenario as ts;
    use sui::coin::Coin;

    // Mirror the module's hard cap so the cap-edge tests can fill it exactly.
    const MAX_SUPPLY: u64 = 10_000_000_000_000_000_000;

    #[test]
    fun public_mint_creates_fresh_supply_for_recipient() {
        let deployer = @0xA;
        let user = @0xB;
        let mut scenario = ts::begin(deployer);
        mtps::test_init(scenario.ctx());

        scenario.next_tx(deployer);
        let mut faucet = scenario.take_shared<MtpsFaucet>();
        mtps::mint(&mut faucet, 500, user, scenario.ctx());
        // Mint again — fresh supply each call, so the faucet never depletes.
        mtps::mint(&mut faucet, 1_000, user, scenario.ctx());
        ts::return_shared(faucet);

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
    fun public_mint_aborts_when_paused() {
        let deployer = @0xA;
        let mut scenario = ts::begin(deployer);
        mtps::test_init(scenario.ctx());
        scenario.next_tx(deployer);
        let mut faucet = scenario.take_shared<MtpsFaucet>();
        let admin = scenario.take_from_sender<AdminCap>();
        mtps::set_can_mint(&admin, &mut faucet, false);
        mtps::mint(&mut faucet, 1, deployer, scenario.ctx()); // aborts: public faucet paused
        scenario.return_to_sender(admin);
        ts::return_shared(faucet);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = mtps::E_SUPPLY_CAP_EXCEEDED)]
    fun mint_aborts_past_supply_cap() {
        let deployer = @0xA;
        let user = @0xB;
        let mut scenario = ts::begin(deployer);
        mtps::test_init(scenario.ctx());
        scenario.next_tx(deployer);
        let mut faucet = scenario.take_shared<MtpsFaucet>();
        let admin = scenario.take_from_sender<AdminCap>();
        // Fill the cap exactly; one more unit must abort instead of bricking at u64::max.
        mtps::admin_mint(&admin, &mut faucet, MAX_SUPPLY, user, scenario.ctx());
        mtps::mint(&mut faucet, 1, user, scenario.ctx()); // aborts: over the cap
        scenario.return_to_sender(admin);
        ts::return_shared(faucet);
        scenario.end();
    }

    #[test]
    fun admin_mint_works_while_public_faucet_paused() {
        let deployer = @0xA;
        let user = @0xB;
        let mut scenario = ts::begin(deployer);
        mtps::test_init(scenario.ctx());
        scenario.next_tx(deployer);
        let mut faucet = scenario.take_shared<MtpsFaucet>();
        let admin = scenario.take_from_sender<AdminCap>();
        mtps::set_can_mint(&admin, &mut faucet, false);
        // Kill switch stops the public faucet but never the admin top-up.
        mtps::admin_mint(&admin, &mut faucet, 1_000, user, scenario.ctx());
        scenario.return_to_sender(admin);
        ts::return_shared(faucet);

        scenario.next_tx(user);
        let c = scenario.take_from_sender<Coin<MTPS>>();
        assert!(c.value() == 1_000, 0);
        scenario.return_to_sender(c);
        scenario.end();
    }

    #[test]
    fun burn_frees_capacity_to_remint() {
        let deployer = @0xA;
        let user = @0xB;
        let mut scenario = ts::begin(deployer);
        mtps::test_init(scenario.ctx());

        // Fill the entire cap via the admin path.
        scenario.next_tx(deployer);
        let mut faucet = scenario.take_shared<MtpsFaucet>();
        let admin = scenario.take_from_sender<AdminCap>();
        mtps::admin_mint(&admin, &mut faucet, MAX_SUPPLY, user, scenario.ctx());
        scenario.return_to_sender(admin);
        ts::return_shared(faucet);

        // Burning all of it frees headroom, so minting succeeds again.
        scenario.next_tx(user);
        let full = scenario.take_from_sender<Coin<MTPS>>();
        let mut faucet = scenario.take_shared<MtpsFaucet>();
        mtps::burn(&mut faucet, full);
        mtps::mint(&mut faucet, 777, user, scenario.ctx());
        ts::return_shared(faucet);

        scenario.next_tx(user);
        let c = scenario.take_from_sender<Coin<MTPS>>();
        assert!(c.value() == 777, 0);
        scenario.return_to_sender(c);
        scenario.end();
    }
}
