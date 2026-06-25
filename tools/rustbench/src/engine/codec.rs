//! Big-endian integer + address encoding, matching `wire.ts` / `signature.move`.

/// 8-byte big-endian encoding of a u64. Matches `signature::u64_to_be_bytes`.
pub fn u64_to_be_bytes(v: u64) -> [u8; 8] {
    v.to_be_bytes()
}

/// 32-byte left-zero-padded big-endian address/object-id, matching
/// `wire.ts::addressToBytes32` / Move `address.to_bytes()`. Accepts `0x` prefix.
pub fn address_to_bytes32(addr: &str) -> Result<[u8; 32], String> {
    let h = addr.strip_prefix("0x").or_else(|| addr.strip_prefix("0X")).unwrap_or(addr);
    if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("invalid hex address: {addr}"));
    }
    if h.len() > 64 {
        return Err(format!("address longer than 32 bytes: {addr}"));
    }
    let padded = format!("{:0>64}", h);
    let mut out = [0u8; 32];
    hex::decode_to_slice(&padded, &mut out).expect("guards above ensure valid even-length hex");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_left_pads_short_hex() {
        // "0xab" -> 31 zero bytes then 0xab, matching wire.ts addressToBytes32.
        let got = address_to_bytes32("0xab").unwrap();
        let mut want = [0u8; 32];
        want[31] = 0xab;
        assert_eq!(got, want);
    }

    #[test]
    fn address_rejects_too_long() {
        let long = format!("0x{}", "a".repeat(66));
        assert!(address_to_bytes32(&long).is_err());
    }

    #[test]
    fn u64_be_is_big_endian() {
        assert_eq!(u64_to_be_bytes(0x499602d2), [0, 0, 0, 0, 0x49, 0x96, 0x02, 0xd2]);
    }
}
