
/// Module: tunnel
module black_jack::tunnel {
    use sui::balance::{Self, Balance};
    // use sui::event;
    use black_jack::error::{
        incorrect_balance_error,
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
    
    public fun internal_verify_signature(
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

// Structures

    public struct Tunnel<phantom T> has key, store {
        id: UID,
        deposit: Balance<T>,
        initial_panalty_amount_for_inactive: u64,
        partyA_deposit_amount: u64,
        partyA_public_key: vector<u8>,
        partyA_signature_type: u8,
        partyB_deposit_amount: u64,
        partyB_public_key: vector<u8>,
        partyB_signature_type: u8,
    }

    public fun create_tunnel<T>(
        partyA_deposit: Balance<T>,
        partyB_deposit: Balance<T>,
        partyA_public_key: vector<u8>,
        partyA_signature_type: u8,
        partyB_public_key: vector<u8>,
        partyB_signature_type: u8,
        initial_panalty_amount_for_inactive: u64,
        ctx: &mut TxContext,
    ): Tunnel<T> {
        let partyA_deposit_amount = partyA_deposit.value();
        let partyB_deposit_amount = partyB_deposit.value();
        let mut deposit = balance::zero();
        deposit.join(partyA_deposit);
        deposit.join(partyB_deposit);
        assert!(
            initial_panalty_amount_for_inactive <= partyA_deposit_amount &&
            initial_panalty_amount_for_inactive <= partyB_deposit_amount,
            incorrect_balance_error()
        );
        assert_is_valid_signature_type(partyA_signature_type);
        assert_is_valid_signature_type(partyB_signature_type);
        let tunnel = Tunnel {
            id: object::new(ctx),
            deposit,
            partyA_deposit_amount,
            partyA_public_key,
            partyA_signature_type,
            partyB_deposit_amount,
            partyB_public_key,
            partyB_signature_type,
            initial_panalty_amount_for_inactive,
        };
        tunnel
    }

    public fun verify_signature<T>(
        tunnel: &Tunnel<T>,
        is_partyA: bool,
        signature: &vector<u8>,
        data: &vector<u8>,
    ) {
        let public_key: vector<u8>;
        let signature_type: u8;
        if( is_partyA ){
            public_key = tunnel.partyA_public_key;
            signature_type = tunnel.partyA_signature_type;
        } else {
            public_key = tunnel.partyB_public_key;
            signature_type = tunnel.partyB_signature_type;
        };
        internal_verify_signature(
            signature,
            &public_key,
            data,
            &signature_type
        );
    }

    public fun close_tunnel<T>(
        tunnel: Tunnel<T>,
    ): Balance<T> {
        let Tunnel {
            id,
            deposit,
            partyA_deposit_amount: _,
            partyA_public_key: _,
            partyA_signature_type: _,
            partyB_deposit_amount: _,
            partyB_public_key: _,
            partyB_signature_type: _,
            initial_panalty_amount_for_inactive: _,
        } = tunnel;
        id.delete();
        deposit
    }

    public fun id<T>(
        tunnel: &Tunnel<T>,
    ): ID {
        tunnel.id.to_inner()
    }

    public fun value<T>(
        tunnel: &Tunnel<T>,
    ): u64 {
        tunnel.deposit.value()
    }

    public fun partyA_deposit_amount<T>(
        tunnel: &Tunnel<T>,
    ): u64 {
        tunnel.partyA_deposit_amount
    }

    public fun partyB_deposit_amount<T>(
        tunnel: &Tunnel<T>,
    ): u64 {
        tunnel.partyB_deposit_amount
    }

    public fun partyA_public_key<T>(
        tunnel: &Tunnel<T>,
    ): vector<u8> {
        tunnel.partyA_public_key
    }

    public fun partyB_public_key<T>(
        tunnel: &Tunnel<T>,
    ): vector<u8> {
        tunnel.partyB_public_key
    }

    public fun partyA_signature_type<T>(
        tunnel: &Tunnel<T>,
    ): u8 {
        tunnel.partyA_signature_type
    }

    public fun partyB_signature_type<T>(
        tunnel: &Tunnel<T>,
    ): u8 {
        tunnel.partyB_signature_type
    }

    public fun initial_panalty_amount_for_inactive<T>(
        tunnel: &Tunnel<T>,
    ): u64 {
        tunnel.initial_panalty_amount_for_inactive
    }
}
