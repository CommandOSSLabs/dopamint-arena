#[test_only]
module mtps::mtps_tests {
    use mtps::mtps::{Self, AdminCap, MTPS};
    use sui::test_scenario as ts;
    use sui::coin::Coin;

    #[test]
    fun admin_mint_sends_requested_amount_to_recipient() {
        let backend = @0xA;
        let user = @0xB;
        let mut scenario = ts::begin(backend);
        mtps::test_init(scenario.ctx());

        // The AdminCap (holding the treasury) lands with the deployer/backend.
        scenario.next_tx(backend);
        let mut cap = scenario.take_from_sender<AdminCap>();
        mtps::admin_mint(&mut cap, 1_234, user, scenario.ctx());
        // Mint again — fresh supply each call.
        mtps::admin_mint(&mut cap, 766, user, scenario.ctx());
        scenario.return_to_sender(cap);

        scenario.next_tx(user);
        let c1 = scenario.take_from_sender<Coin<MTPS>>();
        let c2 = scenario.take_from_sender<Coin<MTPS>>();
        assert!(c1.value() + c2.value() == 2_000, 0);
        scenario.return_to_sender(c1);
        scenario.return_to_sender(c2);
        scenario.end();
    }

    #[test]
    fun burn_destroys_minted_supply() {
        let backend = @0xA;
        let mut scenario = ts::begin(backend);
        mtps::test_init(scenario.ctx());

        scenario.next_tx(backend);
        let mut cap = scenario.take_from_sender<AdminCap>();
        mtps::admin_mint(&mut cap, 500, backend, scenario.ctx());
        scenario.return_to_sender(cap);

        scenario.next_tx(backend);
        let coin = scenario.take_from_sender<Coin<MTPS>>();
        let mut cap = scenario.take_from_sender<AdminCap>();
        mtps::burn(&mut cap, coin);
        scenario.return_to_sender(cap);
        scenario.end();
    }
}
