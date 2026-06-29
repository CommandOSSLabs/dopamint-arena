//! Predicate DSL for querying wallet entries.
//!
//! `Filter` is intentionally simple and additive: every set field must match
//! for an entry to be included. `apply_filter` combines matching with optional
//! sorting and pagination.

use crate::blob::{WalletEntry, WalletRole};
use std::collections::HashMap;

/// Live balances for the entry being matched, keyed by coin type.
pub type BalanceMap = HashMap<String, u64>;

#[derive(Default, Clone, Debug)]
pub struct Filter {
    pub role: Option<WalletRole>,
    pub address_exact: Option<String>,
    pub address_prefix: Option<String>,
    pub address_suffix: Option<String>,
    pub ordinal_min: Option<u32>,
    pub ordinal_max: Option<u32>,
    pub label: Option<String>,
    pub enabled: Option<bool>,
    pub coin_type: Option<String>,
    pub balance_min: Option<u64>,
    pub idle_for_ms: Option<u64>,
    pub use_count_min: Option<u64>,
}

#[derive(Default, Clone, Debug)]
pub struct Sort {
    pub field: SortField,
    pub descending: bool,
}

#[derive(Clone, Debug, Default)]
pub enum SortField {
    #[default]
    Ordinal,
    Address,
    LastUsedAt,
}

#[derive(Default, Clone, Debug)]
pub struct Pagination {
    pub offset: usize,
    pub limit: Option<usize>,
}

impl Filter {
    /// Returns true when `entry` satisfies every set predicate.
    ///
    /// `balances` is the live balance map for the entry being checked;
    /// `now_ms` is the current time in milliseconds for `idle_for_ms` checks.
    pub fn matches(&self, entry: &WalletEntry, balances: &Option<BalanceMap>, now_ms: u64) -> bool {
        if let Some(role) = self.role {
            if entry.role != role {
                return false;
            }
        }
        if let Some(ref exact) = self.address_exact {
            if &entry.address != exact {
                return false;
            }
        }
        if let Some(ref prefix) = self.address_prefix {
            if !entry.address.starts_with(prefix) {
                return false;
            }
        }
        if let Some(ref suffix) = self.address_suffix {
            if !entry.address.ends_with(suffix) {
                return false;
            }
        }
        if let Some(min) = self.ordinal_min {
            if entry.ordinal < min {
                return false;
            }
        }
        if let Some(max) = self.ordinal_max {
            if entry.ordinal > max {
                return false;
            }
        }
        if let Some(ref label) = self.label {
            if entry
                .label
                .as_ref()
                .map_or(true, |l| !l.to_lowercase().contains(&label.to_lowercase()))
            {
                return false;
            }
        }
        if let Some(enabled) = self.enabled {
            if entry.enabled != enabled {
                return false;
            }
        }
        if let Some(ref coin) = self.coin_type {
            let required = self.balance_min.unwrap_or(1);
            match balances {
                Some(bals) => {
                    if bals.get(coin).copied().unwrap_or(0) < required {
                        return false;
                    }
                }
                None => return false,
            }
        } else if self.balance_min.is_some() {
            // balance_min without coin_type is undefined; ignore.
        }
        if let Some(idle_ms) = self.idle_for_ms {
            if now_ms.saturating_sub(entry.last_used_at) < idle_ms {
                return false;
            }
        }
        if let Some(min) = self.use_count_min {
            if entry.use_count < min {
                return false;
            }
        }
        true
    }
}

/// Filter, optionally sort, and paginate a slice of wallet entries.
pub fn apply_filter<'a>(
    entries: &'a [WalletEntry],
    filter: &Filter,
    balances: &Option<BalanceMap>,
    now_ms: u64,
    sort: Option<Sort>,
    pagination: Option<Pagination>,
) -> Vec<&'a WalletEntry> {
    let mut out: Vec<_> = entries
        .iter()
        .filter(|e| filter.matches(e, balances, now_ms))
        .collect();

    if let Some(sort) = sort {
        out.sort_by(|a, b| {
            let ord = match sort.field {
                SortField::Ordinal => a.ordinal.cmp(&b.ordinal),
                SortField::Address => a.address.cmp(&b.address),
                SortField::LastUsedAt => a.last_used_at.cmp(&b.last_used_at),
            };
            if sort.descending {
                ord.reverse()
            } else {
                ord
            }
        });
    }

    if let Some(p) = pagination {
        let start = p.offset.min(out.len());
        let end = p
            .limit
            .map(|limit| start.saturating_add(limit).min(out.len()))
            .unwrap_or(out.len());
        out = out[start..end].to_vec();
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::WalletRole;

    fn entry(
        ordinal: u32,
        enabled: bool,
        address: &str,
        use_count: u64,
        last_used_at: u64,
        label: Option<&str>,
    ) -> WalletEntry {
        WalletEntry {
            role: WalletRole::Member,
            address: address.into(),
            ordinal,
            label: label.map(|s| s.into()),
            created_at: 0,
            enabled,
            use_count,
            last_used_at,
            last_funded_at: None,
            funded_amounts: None,
        }
    }

    #[test]
    fn filter_by_enabled() {
        let entries = vec![
            entry(1, true, "0xaaa", 0, 0, None),
            entry(2, false, "0xbbb", 0, 0, None),
        ];
        let f = Filter {
            enabled: Some(true),
            ..Default::default()
        };
        let got = apply_filter(&entries, &f, &None, 0, None, None);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].ordinal, 1);
    }

    #[test]
    fn filter_by_address_prefix_and_suffix() {
        let entries = vec![
            entry(1, true, "0xabcdef", 0, 0, None),
            entry(2, true, "0xabc123", 0, 0, None),
            entry(3, true, "0xxyzdef", 0, 0, None),
        ];
        let f = Filter {
            address_prefix: Some("0xabc".into()),
            address_suffix: Some("def".into()),
            ..Default::default()
        };
        let got = apply_filter(&entries, &f, &None, 0, None, None);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].ordinal, 1);
    }

    #[test]
    fn filter_by_ordinal_range() {
        let entries = vec![
            entry(1, true, "0x1", 0, 0, None),
            entry(5, true, "0x5", 0, 0, None),
            entry(10, true, "0x10", 0, 0, None),
        ];
        let f = Filter {
            ordinal_min: Some(3),
            ordinal_max: Some(7),
            ..Default::default()
        };
        let got = apply_filter(&entries, &f, &None, 0, None, None);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].ordinal, 5);
    }

    #[test]
    fn filter_by_coin_balance() {
        let entries = vec![
            entry(1, true, "0x1", 0, 0, None),
            entry(2, true, "0x2", 0, 0, None),
        ];
        let balances = Some(HashMap::from([
            ("0x2::sui::SUI".into(), 1_000_000_000),
            ("0xbc::usdc::USDC".into(), 500),
        ]));
        let f = Filter {
            coin_type: Some("0x2::sui::SUI".into()),
            balance_min: Some(1_000),
            ..Default::default()
        };
        let got = apply_filter(&entries, &f, &balances, 0, None, None);
        assert_eq!(got.len(), 2);

        let f = Filter {
            coin_type: Some("0x2::sui::SUI".into()),
            balance_min: Some(2_000_000_000),
            ..Default::default()
        };
        let got = apply_filter(&entries, &f, &balances, 0, None, None);
        assert!(got.is_empty());

        let f = Filter {
            coin_type: Some("0xmissing::coin::COIN".into()),
            ..Default::default()
        };
        let got = apply_filter(&entries, &f, &balances, 0, None, None);
        assert!(got.is_empty());
    }

    #[test]
    fn filter_by_idle_for_ms() {
        let entries = vec![
            entry(1, true, "0x1", 0, 100, None),
            entry(2, true, "0x2", 0, 500, None),
        ];
        let f = Filter {
            idle_for_ms: Some(300),
            ..Default::default()
        };
        let got = apply_filter(&entries, &f, &None, 600, None, None);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].ordinal, 1);
    }

    #[test]
    fn filter_by_use_count_min() {
        let entries = vec![
            entry(1, true, "0x1", 3, 0, None),
            entry(2, true, "0x2", 7, 0, None),
        ];
        let f = Filter {
            use_count_min: Some(5),
            ..Default::default()
        };
        let got = apply_filter(&entries, &f, &None, 0, None, None);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].ordinal, 2);
    }

    #[test]
    fn sort_and_pagination() {
        let entries = vec![
            entry(3, true, "0x3", 0, 300, None),
            entry(1, true, "0x1", 0, 100, None),
            entry(2, true, "0x2", 0, 200, None),
        ];
        let sort = Sort {
            field: SortField::Ordinal,
            descending: false,
        };
        let got = apply_filter(
            &entries,
            &Default::default(),
            &None,
            0,
            Some(sort),
            Some(Pagination {
                offset: 1,
                limit: Some(1),
            }),
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].ordinal, 2);

        let sort = Sort {
            field: SortField::LastUsedAt,
            descending: true,
        };
        let got = apply_filter(&entries, &Default::default(), &None, 0, Some(sort), None);
        assert_eq!(got[0].ordinal, 3);
        assert_eq!(got[1].ordinal, 2);
        assert_eq!(got[2].ordinal, 1);
    }

    #[test]
    fn filter_by_label() {
        let entries = vec![
            entry(1, true, "0x1", 0, 0, Some("treasury")),
            entry(2, true, "0x2", 0, 0, Some("Treasury Hot")),
            entry(3, true, "0x3", 0, 0, None),
        ];
        let f = Filter {
            label: Some("treasury".into()),
            ..Default::default()
        };
        let got = apply_filter(&entries, &f, &None, 0, None, None);
        assert_eq!(got.len(), 2);
    }
}
