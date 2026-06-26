/// MTPS — the free stake token for Dopamint Arena games. Stakes are paid in MTPS (gas stays
/// sponsored in SUI), so a 0-SUI player can fund a game for free.
///
/// Minting is NOT permissionless: the backend faucet holds the `AdminCap` and mints each player
/// exactly the amount they need (an off-chain HTTP faucet — see the backend). Because there is no
/// public mint path, there is no griefing/abuse vector and no u64-ceiling brick risk, so the token
/// needs no supply cap, per-call cap, or kill switch — the only authority is who holds the cap.
/// Coin metadata is registered via the modern `coin_registry`. The collectible NFT lives in its
/// own `mtps_nft` package.
module mtps::mtps {
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::coin_registry;
    use std::string;

    /// One-time witness: guarantees a single `TreasuryCap<MTPS>` for this currency.
    public struct MTPS has drop {}

    /// The mint authority. Holding it is the sole permission to mint or burn MTPS; the backend
    /// faucet custodies it. It wraps the `TreasuryCap`, so there is no shared faucet object and no
    /// public mint — minting only happens in a tx signed by the cap's owner.
    public struct AdminCap has key {
        id: UID,
        treasury_cap: TreasuryCap<MTPS>,
    }

    const DECIMALS: u8 = 9;

    fun init(witness: MTPS, ctx: &mut TxContext) {
        // Register metadata via coin_registry (replaces the deprecated `coin::create_currency`).
        // The OTW path sends the `Currency` to the registry for a one-time post-publish
        // `finalize_registration`; we keep the `TreasuryCap` inside the AdminCap.
        let (initializer, treasury_cap) = coin_registry::new_currency_with_otw(
            witness,
            DECIMALS,
            string::utf8(b"MTPS"),
            string::utf8(b"MTPS"),
            string::utf8(b"Free testnet stake token for Dopamint Arena games (gas is sponsored)."),
            string::utf8(b""),
            ctx,
        );
        // Metadata is immutable (no UI reads it; standard hygiene) — drop the MetadataCap.
        initializer.finalize_and_delete_metadata_cap(ctx);

        // The AdminCap (with the treasury) goes to the deployer; the backend faucet custodies it.
        transfer::transfer(AdminCap { id: object::new(ctx), treasury_cap }, ctx.sender());
    }

    /// Mint `amount` MTPS to `recipient`. Authorized solely by holding the `AdminCap`; the backend
    /// faucet calls this to fund each player exactly what they need for a game.
    public fun admin_mint(
        cap: &mut AdminCap,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        coin::mint_and_transfer<MTPS>(&mut cap.treasury_cap, amount, recipient, ctx);
    }

    /// Burn MTPS back out of supply (AdminCap-only).
    public fun burn(cap: &mut AdminCap, coin: Coin<MTPS>) {
        coin::burn(&mut cap.treasury_cap, coin);
    }

    #[test_only]
    public fun test_init(ctx: &mut TxContext) {
        init(MTPS {}, ctx);
    }
}
