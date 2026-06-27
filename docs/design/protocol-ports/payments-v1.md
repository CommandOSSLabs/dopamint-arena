# payments.v1 Rust Port

## Status

Rust port exists in `rust/protocols/payments`.

## Canonical Protocol

- ID: `payments.v1`
- TS source: `sui-tunnel-ts/src/protocol/payments.ts`
- Rust target: `rust/protocols/payments`

## Protocol Shape

Payments is the baseline bidirectional value-transfer protocol. A move carries
`from` and `amount`; the signer must match `from`; amount must be positive and
covered by the sender balance.

State is fixed-size:

- `balanceA`
- `balanceB`
- `count`

The protocol is intentionally non-terminal. Sessions close explicitly.

## Port Requirements

The current Rust implementation should be treated as a baseline, but it is not
yet byte-identical to the TS move shape because Rust `PayMove` carries only
`amount`, while TS `PaymentMove` carries `{ from, amount }`.

Before using payments as a cross-language parity fixture, decide whether Rust
should:

- keep the simpler fleet-bench shape for internal load testing, or
- add a TS-parity `PaymentsV1` move with `from` validation and JSON shape.

## Settlement And Unhappy Path

Every co-signed payment state is directly settleable. If either peer drops, the
other can settle or dispute using the latest co-signed checkpoint. Unco-signed
payment intents are not enforceable.

## Tests

- transfer moves value and conserves total.
- wrong signer is rejected.
- insufficient funds are rejected.
- `encode_state` matches TS goldens.
- Rust/TS move JSON parity if the TS-parity move is adopted.
