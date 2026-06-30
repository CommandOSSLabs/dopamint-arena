# Relay & treasury utilities

Standalone scripts for the dev wallet pool and relay benchmarking. (The in-browser
`?agent` fleet runner was removed — server-side bots now live in the rust bot fleet.)

## Scripts

1. **Fund / top up** the wallet pool (reuses `keys.json`, funds only what's missing — secrets
   are gitignored). Key is piped from the keystore, never printed:

   ```bash
   SUI_TREASURY_KEY=$(sui keytool export --key-identity "$(sui client active-address)" --json \
     | jq -r .exportedPrivateKey) N=10 node agent/fundTreasury.mjs
   ```

2. **Relay frame-rate bench** — direct to the ALB:

   ```bash
   MP_WS_URL=ws://<alb>/v1/mp T=25 D=15 PIPELINE=16 node agent/loadtestRelay.mjs
   ```

   Measured from a laptop (WAN-distorted, NOT the relay's capacity): ~95 frames/s synchronous
   (RTT-bound), ~1038 frames/s pipelined (16 in flight). The authoritative number must be
   measured **co-located in us-east-1** — run from an EC2 instance in-region.
