
/// Module: black_jack
module black_jack::signature_utils {
    use black_jack::error::{
        invalid_signature_error,
        invalid_signature_type_error
    };
    use sui::ed25519;
    use sui::bls12381;

    const BLS12381_: u8 = 0;
    public fun BLS12381(): u8 {
        BLS12381_
    }

    const ED25519_: u8 = 1;
    public fun ED25519(): u8 {
        ED25519_
    }
    
    public fun verify_signature(
        signature: &vector<u8>,
        public_key: &vector<u8>,
        data: &vector<u8>,
        signature_type: &u8,
    ) {
        let mut valid = false;
        if (signature_type == BLS12381()) {
            valid = bls12381::bls12381_min_pk_verify(
                signature,
                public_key,
                data
            );
        } else if (signature_type == ED25519()) {
            valid = ed25519::ed25519_verify(
                signature,
                public_key, 
                data,
            );
        };
        assert!(
            valid,
            invalid_signature_error()
        );
    }

    public fun assert_is_valid_signature_type(
        signature_type: u8
    ) {
        assert!(
            is_valid_signature_type(signature_type),
            invalid_signature_type_error()
        );
    }

    public fun is_valid_signature_type(
        signature_type: u8
    ): bool {
        signature_type == BLS12381() ||
        signature_type == ED25519()
    }
}
