/// MTPS — the free, faucet-minted stake token for Dopamint Arena games. Stakes are paid in
/// MTPS (gas stays sponsored in SUI), so a 0-SUI player can fund a game for free: the faucet
/// MINTS new MTPS on demand via the `TreasuryCap` (it never draws from a fixed reserve, so it
/// can't "run out"), and the tunnel framework is generic over the coin `T` so `Coin<MTPS>`
/// stakes need no tunnel change. Modeled on quantum-poker's `test_buck`.
#[allow(deprecated_usage)]
module mtps::mtps {
    use sui::coin::{Self, TreasuryCap};

    /// One-time witness: guarantees a single `TreasuryCap<MTPS>` for this currency.
    public struct MTPS has drop {}

    /// Shared faucet holding the mint authority. Anyone may mint (free testnet token); `can_mint`
    /// is a kill switch the deployer can flip.
    public struct MtpsFaucet has key, store {
        id: UID,
        treasury_cap: TreasuryCap<MTPS>,
        can_mint: bool,
    }

    const E_MINT_DISABLED: u64 = 0;
    const DECIMALS: u8 = 9;
    /// 100 MTPS (9 decimals) per default faucet pull — far above any game's tiny stake.
    const DEFAULT_MINT_AMOUNT: u64 = 100_000_000_000;

    fun init(witness: MTPS, ctx: &mut TxContext) {
        let (treasury_cap, coin_metadata) = coin::create_currency<MTPS>(
            witness,
            DECIMALS,
            b"MTPS",
            b"MTPS",
            b"Free testnet stake token for Dopamint Arena games (gas is sponsored).",
            option::none(),
            ctx,
        );
        // Metadata is immutable — no UI reads it, but freezing is the standard hygiene.
        transfer::public_freeze_object(coin_metadata);
        // Share the faucet so any player can mint their own stake.
        transfer::public_share_object(MtpsFaucet {
            id: object::new(ctx),
            treasury_cap,
            can_mint: true,
        });
    }

    /// Faucet: MINT `amount` fresh MTPS to `recipient`. New supply each call (no reserve to
    /// deplete). `public fun` so a PTB can call it; bounded only by the u64 supply ceiling.
    public fun mint(
        faucet: &mut MtpsFaucet,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        assert!(faucet.can_mint, E_MINT_DISABLED);
        coin::mint_and_transfer<MTPS>(&mut faucet.treasury_cap, amount, recipient, ctx);
    }

    /// Faucet a fixed default amount to `recipient`.
    public fun mint_default(
        faucet: &mut MtpsFaucet,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        mint(faucet, DEFAULT_MINT_AMOUNT, recipient, ctx);
    }

    /// Kill switch for the faucet (deployer-only by convention; the shared object is mutable by
    /// anyone, so this is a demo-grade control, not hardened access control).
    public fun set_can_mint(faucet: &mut MtpsFaucet, can_mint: bool, _ctx: &mut TxContext) {
        faucet.can_mint = can_mint;
    }

    #[test_only]
    public fun test_init(ctx: &mut TxContext) {
        init(MTPS {}, ctx);
    }
}
