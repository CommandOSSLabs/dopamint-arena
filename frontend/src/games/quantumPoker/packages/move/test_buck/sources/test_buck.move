#[allow(deprecated_usage)]
module quantum_poker_test_buck::test_buck {
    use sui::coin::{Self, TreasuryCap};
    use sui::url;

    public struct TEST_BUCK has drop {}

    public struct TEST_BUCK_Manager has key, store {
        id: UID,
        treasury_cap: TreasuryCap<TEST_BUCK>,
        can_mint: bool,
    }

    const E_MINT_DISABLED: u64 = 0;
    const DECIMALS: u8 = 9;
    const INITIAL_MINT_AMOUNT: u64 = 1_000_000_000_000_000_000;
    const DEFAULT_MINT_AMOUNT: u64 = 100_000_000_000;

    fun init(witness: TEST_BUCK, ctx: &mut TxContext) {
        let (mut treasury_cap, coin_metadata) = coin::create_currency<TEST_BUCK>(
            witness,
            DECIMALS,
            b"BUCK",
            b"Bucket USD",
            b"Bucket USD for Quantum Poker testnet gameplay",
            option::some(url::new_unsafe_from_bytes(b"https://bucket-cdn-eason.s3.us-west-1.amazonaws.com/BUCK.svg")),
            ctx,
        );
        transfer::public_freeze_object(coin_metadata);
        coin::mint_and_transfer<TEST_BUCK>(
            &mut treasury_cap,
            INITIAL_MINT_AMOUNT,
            tx_context::sender(ctx),
            ctx,
        );
        transfer::public_share_object(TEST_BUCK_Manager {
            id: object::new(ctx),
            treasury_cap,
            can_mint: true,
        });
    }

    public fun mint(
        manager: &mut TEST_BUCK_Manager,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        assert!(manager.can_mint, E_MINT_DISABLED);
        coin::mint_and_transfer<TEST_BUCK>(&mut manager.treasury_cap, amount, recipient, ctx);
    }

    public fun mint_default(
        manager: &mut TEST_BUCK_Manager,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        mint(manager, DEFAULT_MINT_AMOUNT, recipient, ctx);
    }

    public fun set_can_mint(
        manager: &mut TEST_BUCK_Manager,
        can_mint: bool,
        _ctx: &mut TxContext,
    ) {
        manager.can_mint = can_mint;
    }
}
