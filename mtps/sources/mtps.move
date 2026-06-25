/// MTPS — the free, faucet-minted stake token for Dopamint Arena games. Stakes are paid in
/// MTPS (gas stays sponsored in SUI), so a 0-SUI player can fund a game for free: the faucet
/// MINTS new MTPS on demand from a shared `TreasuryCap`. Public minting stays open and
/// un-throttled per call so a player can always pull enough to play, but every mint is bounded
/// by a hard `MAX_SUPPLY` — so no single call (even `amount = u64::max`) can drive supply to the
/// u64 ceiling and brick all future mints. The tunnel framework is generic over the coin `T`, so
/// `Coin<MTPS>` stakes need no tunnel change.
///
/// Privileged controls live behind an owned `AdminCap` (held by the deployer): the `can_mint`
/// kill switch and an `admin_mint` that still works while the public faucet is paused. A
/// permissionless `burn` lets live supply recede. Coin metadata is registered via the modern
/// `coin_registry` (the legacy `coin::create_currency` is deprecated). The NFT that previously
/// lived here moved to its own `mtps_nft` package.
module mtps::mtps {
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::coin_registry;
    use std::string;

    /// One-time witness: guarantees a single `TreasuryCap<MTPS>` for this currency.
    public struct MTPS has drop {}

    /// Shared faucet holding the mint authority. Anyone may mint (free testnet token), bounded by
    /// `MAX_SUPPLY`; `can_mint` is the public kill switch (flip via `set_can_mint`, AdminCap-only).
    /// `minted` tracks LIVE supply (mints add, `burn` subtracts) and is the cap's running total.
    public struct MtpsFaucet has key, store {
        id: UID,
        treasury_cap: TreasuryCap<MTPS>,
        minted: u64,
        can_mint: bool,
    }

    /// Deployer-held authority for privileged faucet ops: the `can_mint` kill switch and
    /// `admin_mint`. Owned (not shared), so only its holder can call the gated functions.
    public struct AdminCap has key, store {
        id: UID,
    }

    /// Public minting is paused (`can_mint == false`). Use `admin_mint` to top up regardless.
    const E_MINT_DISABLED: u64 = 0;
    /// This mint would push live supply past `MAX_SUPPLY`.
    const E_SUPPLY_CAP_EXCEEDED: u64 = 1;

    const DECIMALS: u8 = 9;
    /// 10,000 MTPS (9 decimals) per default faucet pull — covers thousands of tiny game stakes.
    const DEFAULT_MINT_AMOUNT: u64 = 10_000_000_000_000;
    /// Hard ceiling on live supply: 10 billion MTPS (10^19 raw). Big enough to never throttle real
    /// play (~10^6 default pulls), yet only ~54% of `u64::max`, so supply can never reach the u64
    /// ceiling and abort all mints. The 9-decimal × u64 hard limit is ~18.4B MTPS.
    const MAX_SUPPLY: u64 = 10_000_000_000_000_000_000;

    fun init(witness: MTPS, ctx: &mut TxContext) {
        // Register metadata via coin_registry (replaces the deprecated `coin::create_currency`).
        // The TreasuryCap is ours to keep (mintable faucet); the OTW path sends the `Currency` to
        // the registry for a one-time post-publish `finalize_registration`.
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

        // Share the faucet so any player can mint their own stake.
        transfer::public_share_object(MtpsFaucet {
            id: object::new(ctx),
            treasury_cap,
            minted: 0,
            can_mint: true,
        });
        // AdminCap to the deployer — gates the kill switch and the admin top-up mint.
        transfer::public_transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
    }

    /// Faucet: MINT `amount` fresh MTPS to `recipient`, bounded by `MAX_SUPPLY`. `public fun` so a
    /// PTB can call it; aborts if public minting is paused or the cap would be exceeded.
    public fun mint(
        faucet: &mut MtpsFaucet,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        assert!(faucet.can_mint, E_MINT_DISABLED);
        mint_capped(faucet, amount, recipient, ctx);
    }

    /// Faucet a fixed default amount to `recipient` (same checks as `mint`).
    public fun mint_default(faucet: &mut MtpsFaucet, recipient: address, ctx: &mut TxContext) {
        mint(faucet, DEFAULT_MINT_AMOUNT, recipient, ctx);
    }

    /// AdminCap top-up: mint `amount` to `recipient` REGARDLESS of `can_mint`, so the deployer can
    /// still fund accounts after pausing the public faucet against abuse. Still bound by `MAX_SUPPLY`.
    public fun admin_mint(
        _: &AdminCap,
        faucet: &mut MtpsFaucet,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        mint_capped(faucet, amount, recipient, ctx);
    }

    /// AdminCap-only kill switch for the public faucet (`mint`/`mint_default`). `admin_mint` is
    /// unaffected.
    public fun set_can_mint(_: &AdminCap, faucet: &mut MtpsFaucet, can_mint: bool) {
        faucet.can_mint = can_mint;
    }

    /// Permissionless burn: destroy `coin` and credit its value back against the supply cap, so
    /// live supply can recede and reclaimed headroom is mintable again.
    public fun burn(faucet: &mut MtpsFaucet, coin: Coin<MTPS>) {
        let amount = coin::burn(&mut faucet.treasury_cap, coin);
        faucet.minted = faucet.minted - amount;
    }

    /// Enforce the supply cap, then mint. Subtraction form (`amount <= MAX_SUPPLY - minted`) can't
    /// overflow because `minted <= MAX_SUPPLY` is an invariant the cap check itself maintains.
    fun mint_capped(faucet: &mut MtpsFaucet, amount: u64, recipient: address, ctx: &mut TxContext) {
        assert!(amount <= MAX_SUPPLY - faucet.minted, E_SUPPLY_CAP_EXCEEDED);
        faucet.minted = faucet.minted + amount;
        coin::mint_and_transfer<MTPS>(&mut faucet.treasury_cap, amount, recipient, ctx);
    }

    #[test_only]
    public fun test_init(ctx: &mut TxContext) {
        init(MTPS {}, ctx);
    }
}
