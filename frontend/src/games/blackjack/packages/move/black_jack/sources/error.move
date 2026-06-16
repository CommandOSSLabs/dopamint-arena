module black_jack::error {
    
    const ErrorNotAuthorized: u64 = 1;
    public fun not_authorized_error(): u64 {
        ErrorNotAuthorized
    }

    const ErrorTimeNotPassYet: u64 = 2;
    public fun time_not_pass_yet_error(): u64 {
        ErrorTimeNotPassYet
    }

    const ErrorIncorrectBalance: u64 = 3;
    public fun incorrect_balance_error(): u64 {
        ErrorIncorrectBalance
    }

    const ErrorInvalidHand: u64 = 4;
    public fun invalid_hand_error(): u64 {
        ErrorInvalidHand
    }

    const ErrorInvalidAction: u64 = 5;
    public fun invalid_action_error(): u64 {
        ErrorInvalidAction
    }

    const ErrorInvalidSignature: u64 = 6;
    public fun invalid_signature_error(): u64 {
        ErrorInvalidSignature
    }

    const ErrorInvalidSignatureType: u64 = 7;
    public fun invalid_signature_type_error(): u64 {
        ErrorInvalidSignatureType
    }

    const ErrorInvalidBalance: u64 = 8;
    public fun invalid_balance_error(): u64 {
        ErrorInvalidBalance
    }
}