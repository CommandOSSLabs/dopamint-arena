#[test_only]
module black_jack::test_coin {
    use sui::coin::{Self};
    public struct TEST_COIN has drop {}
    
    fun init(otw: TEST_COIN, ctx: &mut TxContext) {
        let (treasury_cap, metadata) = coin::create_currency(
            otw, 
            2, 
            b"TEST", 
            b"TEST", 
            b"", 
            option::none(), 
            ctx
        );
        transfer::public_share_object(treasury_cap);
        transfer::public_share_object(metadata);
    }
}
