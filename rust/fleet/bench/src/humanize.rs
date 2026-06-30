//! Render-only humanizers. Never called on the hot path.

pub fn count(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);

    for (i, ch) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }

    out.chars().rev().collect()
}

pub fn bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let f = n as f64;

    if f < KB {
        format!("{n}B")
    } else if f < MB {
        format!("{:.1}KB", f / KB)
    } else if f < GB {
        format!("{:.1}MB", f / MB)
    } else {
        format!("{:.1}GB", f / GB)
    }
}

pub fn dur_ns(ns: f64) -> String {
    if ns < 1_000.0 {
        format!("{ns:.0}ns")
    } else if ns < 1_000_000.0 {
        format!("{:.1}us", ns / 1_000.0)
    } else if ns < 1_000_000_000.0 {
        format!("{:.1}ms", ns / 1_000_000.0)
    } else {
        format!("{:.1}s", ns / 1_000_000_000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_get_thousands_separators() {
        assert_eq!(count(1_234_567), "1,234,567");
        assert_eq!(count(42), "42");
    }

    #[test]
    fn bytes_scale_binary() {
        assert_eq!(bytes(512), "512B");
        assert_eq!(bytes(49_408), "48.2KB");
        assert_eq!(bytes(5_242_880), "5.0MB");
    }

    #[test]
    fn durations_auto_scale() {
        assert_eq!(dur_ns(500.0), "500ns");
        assert_eq!(dur_ns(1_500.0), "1.5us");
        assert_eq!(dur_ns(2_000_000.0), "2.0ms");
        assert_eq!(dur_ns(3_000_000_000.0), "3.0s");
    }
}
