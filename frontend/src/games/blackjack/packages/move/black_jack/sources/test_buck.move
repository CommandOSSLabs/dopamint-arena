module black_jack::test_buck {

    // ----- Use Statements -----

    use sui::coin::{Self, TreasuryCap};
    use sui::url;

    // ----- Structs -----

    public struct TEST_BUCK has drop {
    }

    public struct TEST_BUCK_Manager has key, store {
        id: UID,
        treasury_cap: TreasuryCap<TEST_BUCK>,
        can_mint: bool,
    }
    // ----- Init Functions -----

    fun init(
        test_buck: TEST_BUCK,
        ctx: &mut tx_context::TxContext,
    ) {
        let (mut treasury_cap, coin_metadata) = coin::create_currency<TEST_BUCK>(
            test_buck,
            9,
            b"BUCK",
            b"Bucket USD",
            b"Bucket USD at testnet for testing",
            option::some(url::new_unsafe_from_bytes(b"https://bucket-cdn-eason.s3.us-west-1.amazonaws.com/BUCK.svg")),
            ctx
        );
        transfer::public_freeze_object(coin_metadata);
        coin::mint_and_transfer<TEST_BUCK>(
            &mut treasury_cap,
            10000000000000000000,
            @0x96d9a120058197fce04afcffa264f2f46747881ba78a91beb38f103c60e315ae,
            ctx
        );
        // transfer::public_transfer(treasury_cap, tx_context::sender(ctx));
        let manager = TEST_BUCK_Manager {
            id: object::new(ctx),
            treasury_cap: treasury_cap,
            can_mint: true,
        };
        transfer::public_share_object(manager);
    }

    public fun mint(
        manager: &mut TEST_BUCK_Manager,
        amount: u64,
        recipient: address,
        ctx: &mut tx_context::TxContext,
    ) {
        coin::mint_and_transfer<TEST_BUCK>(
            &mut manager.treasury_cap,
            amount,
            recipient,
            ctx
        );
    }
    
}