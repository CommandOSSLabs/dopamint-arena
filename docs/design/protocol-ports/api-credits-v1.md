# api_credits.v1 Rust Port

## Status

Design.

## Canonical Protocol

- ID: `api_credits.v1`
- TS source: `sui-tunnel-ts/src/protocol/apiCredits.ts`
- Rust target: `rust/protocols/api-credits`

## Protocol Shape

API Credits models prepaid metered service usage. Party A is the client; party B
is the provider. Each call shifts a fixed cost from A to B.

State:

- client remaining balance
- provider accrued balance
- locked total
- call count

Move:

- `{ kind: "call" }`

Only A can make calls. The protocol is terminal when A cannot afford another
call.

## Settlement And Unhappy Path

Every co-signed state is directly settleable. Generic tunnel dispute is
sufficient because the only enforceable unit is an already co-signed call. If a
client disappears, the provider can settle the latest co-signed accrued balance.
If the provider disappears, the client can settle the latest co-signed remaining
balance.

## Tests

- only A can make calls.
- call cost shifts from A to B.
- insufficient credits rejects calls.
- terminal when client balance is below cost.
- `encode_state` matches TS goldens.
- balances always sum to total.
