# chat.v1 Rust Port

## Status

Design.

## Canonical Protocol

- ID: `chat.v1`
- TS source: `sui-tunnel-ts/src/protocol/chat.ts`
- Rust target: `rust/protocols/chat`

## Protocol Shape

Chat is an unbounded message transcript with optional tips. The signed state
stores only a rolling transcript digest and balances.

State:

- transcript digest
- message count
- last sender
- balances

Move:

- `{ kind: "msg", text, tip? }`

Messages must be non-empty. Tips are optional non-negative value transfers from
the sender to the other party.

## Encoding Contract

Each message delta is:

```text
blake2b256(party_byte || u64be(len(message_bytes)) || message_bytes)
```

The transcript digest is `rollingDigest(previous_digest, delta)`. `encode_state`
is fixed-size: domain, digest, count, and balances.

## Settlement And Unhappy Path

Chat has no terminal state. Generic settlement is sufficient. A dropped or
malicious peer cannot forge messages or tips because each move is re-derived and
co-signed. Unco-signed messages are not enforceable.

## Tests

- empty messages are rejected.
- digest matches TS fixtures.
- message count increments.
- tips shift balances and conserve total.
- over-balance tips are rejected.
- `encode_state` matches TS goldens.
