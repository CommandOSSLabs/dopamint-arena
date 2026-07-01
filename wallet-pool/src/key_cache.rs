use moka::policy::EvictionPolicy;
use std::hash::Hash;
use std::time::Duration;

/// A small, generic in-process cache backed by `moka::sync::Cache`.
///
/// Keys and values must be cloneable, hashable/equatable, and safe to send
/// across threads because the underlying cache is shared and concurrent.
#[derive(Clone)]
pub struct KeyCache<K, V> {
    inner: moka::sync::Cache<K, V>,
}

impl<K, V> KeyCache<K, V>
where
    K: Hash + Eq + Send + Sync + Clone + 'static,
    V: Clone + Send + Sync + 'static,
{
    /// Build a cache that holds up to `max_capacity` entries and evicts
    /// entries after they have been live for `ttl`.
    pub fn new(max_capacity: u64, ttl: Duration) -> Self {
        Self {
            inner: moka::sync::Cache::builder()
                .max_capacity(max_capacity)
                .eviction_policy(EvictionPolicy::lru())
                .time_to_live(ttl)
                .build(),
        }
    }

    /// Return a clone of the value stored under `key`, if any.
    pub fn get(&self, key: &K) -> Option<V> {
        self.inner.get(key)
    }

    /// Insert `value` under `key`, replacing any existing value.
    pub fn set(&self, key: K, value: V) {
        self.inner.insert(key, value);
    }

    /// Drop every entry from the cache.
    pub fn clear(&self) {
        self.inner.invalidate_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn cache_stores_and_retrieves() {
        let cache = KeyCache::<&'static str, i32>::new(10, Duration::from_secs(60));
        cache.set("a", 1);
        assert_eq!(cache.get(&"a"), Some(1));
    }

    #[test]
    fn cache_evicts_lru() {
        let cache = KeyCache::<&'static str, i32>::new(2, Duration::from_secs(60));
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);

        // Moka evictions are asynchronous; flush pending tasks before asserting.
        cache.inner.run_pending_tasks();

        assert!(cache.get(&"a").is_none(), "oldest key should be evicted");
        assert_eq!(cache.get(&"b"), Some(2));
        assert_eq!(cache.get(&"c"), Some(3));
    }

    #[test]
    fn cache_entries_expire_by_ttl() {
        let cache = KeyCache::<&'static str, i32>::new(10, Duration::from_millis(100));
        cache.set("a", 1);
        assert_eq!(cache.get(&"a"), Some(1));

        sleep(Duration::from_millis(250));
        assert_eq!(cache.get(&"a"), None);
    }

    #[test]
    fn cache_clear_removes_all_entries() {
        let cache = KeyCache::<&'static str, i32>::new(10, Duration::from_secs(60));
        cache.set("a", 1);
        cache.set("b", 2);
        cache.clear();
        assert_eq!(cache.get(&"a"), None);
        assert_eq!(cache.get(&"b"), None);
    }
}
