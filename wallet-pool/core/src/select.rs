//! Wallet selection helpers.
//!
//! These functions sit on top of [`apply_filter`](crate::filter::apply_filter)
//! and provide common selection strategies: first match, round-robin, and
//! least-recently-used.

use crate::blob::WalletEntry;
use crate::filter::{apply_filter, BalanceMap, Filter, Pagination, Sort, SortField};

/// Return the first entry that satisfies the filter.
pub fn pick<'a>(
    entries: &'a [WalletEntry],
    filter: &Filter,
    balances: &Option<BalanceMap>,
    now_ms: u64,
) -> Option<&'a WalletEntry> {
    apply_filter(
        entries,
        filter,
        balances,
        now_ms,
        None,
        Some(Pagination {
            offset: 0,
            limit: Some(1),
        }),
    )
    .into_iter()
    .next()
}

/// Return the next entry in a round-robin over filtered entries sorted by
/// ordinal, and advance `cursor` to `chosen.ordinal + 1`.
///
/// The cursor is best-effort and single-process; it is not a cross-process
/// lease. Filtering may produce an empty set, in which case `None` is returned
/// and the cursor is left unchanged.
pub fn next<'a>(
    entries: &'a [WalletEntry],
    filter: &Filter,
    balances: &Option<BalanceMap>,
    now_ms: u64,
    cursor: &mut u32,
) -> Option<&'a WalletEntry> {
    let candidates = apply_filter(
        entries,
        filter,
        balances,
        now_ms,
        Some(Sort {
            field: SortField::Ordinal,
            descending: false,
        }),
        None,
    );
    if candidates.is_empty() {
        return None;
    }
    let idx = candidates.partition_point(|e| e.ordinal < *cursor);
    let chosen = candidates.get(idx).copied().unwrap_or(candidates[0]);
    *cursor = chosen.ordinal.wrapping_add(1);
    Some(chosen)
}

/// Return the least-recently-used entry that satisfies the filter.
pub fn lru<'a>(
    entries: &'a [WalletEntry],
    filter: &Filter,
    balances: &Option<BalanceMap>,
    now_ms: u64,
) -> Option<&'a WalletEntry> {
    let mut candidates = apply_filter(entries, filter, balances, now_ms, None, None);
    candidates.sort_by_key(|a| a.last_used_at);
    candidates.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::WalletRole;

    fn entry(ordinal: u32, enabled: bool, last_used_at: u64) -> WalletEntry {
        WalletEntry {
            role: WalletRole::Member,
            address: format!("0x{ordinal}"),
            ordinal,
            label: None,
            created_at: 0,
            enabled,
            use_count: 0,
            last_used_at,
            last_funded_at: None,
            funded_amounts: None,
        }
    }

    #[test]
    fn pick_returns_first_match() {
        let entries = vec![entry(1, false, 0), entry(2, true, 0), entry(3, true, 0)];
        let filter = Filter {
            enabled: Some(true),
            ..Default::default()
        };
        let got = pick(&entries, &filter, &None, 0);
        assert_eq!(got.map(|e| e.ordinal), Some(2));
    }

    #[test]
    fn pick_returns_none_when_no_match() {
        let entries = vec![entry(1, true, 0)];
        let filter = Filter {
            enabled: Some(false),
            ..Default::default()
        };
        assert!(pick(&entries, &filter, &None, 0).is_none());
    }

    #[test]
    fn next_round_robins_by_ordinal_and_wraps() {
        let entries = vec![entry(0, true, 0), entry(1, true, 0), entry(2, true, 0)];
        let filter = Filter::default();
        let mut cursor = 0;

        assert_eq!(
            next(&entries, &filter, &None, 0, &mut cursor).map(|e| e.ordinal),
            Some(0)
        );
        assert_eq!(cursor, 1);

        assert_eq!(
            next(&entries, &filter, &None, 0, &mut cursor).map(|e| e.ordinal),
            Some(1)
        );
        assert_eq!(cursor, 2);

        assert_eq!(
            next(&entries, &filter, &None, 0, &mut cursor).map(|e| e.ordinal),
            Some(2)
        );
        assert_eq!(cursor, 3);

        // Wrap back to the first candidate.
        assert_eq!(
            next(&entries, &filter, &None, 0, &mut cursor).map(|e| e.ordinal),
            Some(0)
        );
        assert_eq!(cursor, 1);
    }

    #[test]
    fn next_skips_filtered_entries() {
        let entries = vec![
            entry(0, false, 0),
            entry(1, true, 0),
            entry(2, false, 0),
            entry(3, true, 0),
        ];
        let filter = Filter {
            enabled: Some(true),
            ..Default::default()
        };
        let mut cursor = 0;

        assert_eq!(
            next(&entries, &filter, &None, 0, &mut cursor).map(|e| e.ordinal),
            Some(1)
        );
        assert_eq!(cursor, 2);

        assert_eq!(
            next(&entries, &filter, &None, 0, &mut cursor).map(|e| e.ordinal),
            Some(3)
        );
        assert_eq!(cursor, 4);

        // Only two enabled entries exist; wrap from ordinal 4 to the start.
        assert_eq!(
            next(&entries, &filter, &None, 0, &mut cursor).map(|e| e.ordinal),
            Some(1)
        );
        assert_eq!(cursor, 2);
    }

    #[test]
    fn next_sorts_input_by_ordinal() {
        let entries = vec![entry(3, true, 0), entry(1, true, 0), entry(2, true, 0)];
        let filter = Filter::default();
        let mut cursor = 0;

        assert_eq!(
            next(&entries, &filter, &None, 0, &mut cursor).map(|e| e.ordinal),
            Some(1)
        );
        assert_eq!(
            next(&entries, &filter, &None, 0, &mut cursor).map(|e| e.ordinal),
            Some(2)
        );
        assert_eq!(
            next(&entries, &filter, &None, 0, &mut cursor).map(|e| e.ordinal),
            Some(3)
        );
    }

    #[test]
    fn lru_returns_oldest_last_used() {
        let entries = vec![
            entry(1, true, 300),
            entry(2, true, 100),
            entry(3, true, 200),
        ];
        let filter = Filter::default();
        let got = lru(&entries, &filter, &None, 0);
        assert_eq!(got.map(|e| e.ordinal), Some(2));
    }

    #[test]
    fn lru_respects_filter() {
        let entries = vec![entry(1, false, 10), entry(2, true, 50), entry(3, true, 20)];
        let filter = Filter {
            enabled: Some(true),
            ..Default::default()
        };
        let got = lru(&entries, &filter, &None, 0);
        assert_eq!(got.map(|e| e.ordinal), Some(3));
    }
}
