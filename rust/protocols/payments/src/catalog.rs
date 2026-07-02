//! Tunnel Mart catalog prices — must match FE `PRICE_LO` / `PRICE_HI` in
//! `frontend/src/games/regularPayments/utils/catalog.ts` (1 and 2 whole MTPS).

/// Lowest catalog item price (whole MTPS, 0 decimals).
pub const CATALOG_PRICE_LO: u64 = 1;
/// Highest catalog item price (whole MTPS, 0 decimals).
pub const CATALOG_PRICE_HI: u64 = 2;

/// Whether `amount` is an allowed catalog line-item price for shopper → shop moves.
pub fn is_catalog_amount(amount: u64) -> bool {
    amount == CATALOG_PRICE_LO || amount == CATALOG_PRICE_HI
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_catalog_prices_only() {
        assert!(is_catalog_amount(CATALOG_PRICE_LO));
        assert!(is_catalog_amount(CATALOG_PRICE_HI));
        assert!(!is_catalog_amount(0));
        assert!(!is_catalog_amount(3));
        assert!(!is_catalog_amount(450));
    }
}
