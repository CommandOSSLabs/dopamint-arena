#!/usr/bin/env bash
# Local affinity smoke test: prove the load balancer pins reconnects to the same relay
# instance via the `aff` cookie the relay sets on the /v1/mp handshake.
#
# Brings up redis + relay-a + relay-b + haproxy (see docker-compose.affinity-smoke.yml),
# asserts stickiness, then tears everything down. Requires Docker. Exits non-zero on any
# failed assertion. Kept bash-3.2 compatible (macOS /bin/bash) — no associative arrays.
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE="docker compose -f docker-compose.affinity-smoke.yml"
LB_HEALTH="http://localhost:8088/healthz"
LB_MP="http://localhost:8088/v1/mp"
RUNS=10

cleanup() { $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> building + starting harness (redis + relay-a + relay-b + haproxy)"
$COMPOSE up -d --build

echo "==> waiting for the load balancer to serve a healthy backend"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS "$LB_HEALTH" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "FAIL: load balancer never became ready" >&2; exit 1; }

# Perform a WS upgrade handshake through the LB and print the instance named by the
# `aff` cookie on the 101 response. With an argument, send it as `Cookie: aff=<arg>`
# to exercise stickiness. curl is killed by --max-time after the upgrade; the 101
# headers (incl. Set-Cookie) are already on stdout, so curl's non-zero exit is
# EXPECTED — the `|| true` keeps it from tripping `set -e`/`pipefail`.
handshake_aff() {
  {
    if [ $# -ge 1 ]; then
      curl -s -i --no-buffer --max-time 3 \
        -H "Connection: Upgrade" -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" \
        -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
        -H "Cookie: aff=$1" \
        "$LB_MP" 2>/dev/null || true
    else
      curl -s -i --no-buffer --max-time 3 \
        -H "Connection: Upgrade" -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" \
        -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
        "$LB_MP" 2>/dev/null || true
    fi
  } | LC_ALL=C tr -d '\r' | LC_ALL=C sed -n 's/^[Ss]et-[Cc]ookie: *aff=\([^;]*\).*/\1/p' | head -n1
}
# LC_ALL=C keeps tr/sed byte-oriented: curl prints the post-upgrade binary WS frames after
# the 101 headers, and a UTF-8 locale would make BSD tr abort on "illegal byte sequence".

echo "==> first handshake (no cookie): the LB assigns an instance"
first="$(handshake_aff)"
[ -n "$first" ] || { echo "FAIL: no aff cookie on the handshake (is the relay setting it?)" >&2; exit 1; }
echo "    assigned: $first"

echo "==> $RUNS reconnects carrying aff=$first must all return $first"
mismatch=0
for i in $(seq 1 "$RUNS"); do
  got="$(handshake_aff "$first")"
  if [ "$got" != "$first" ]; then
    echo "    run $i: got '$got', expected '$first'" >&2
    mismatch=$((mismatch + 1))
  fi
done
[ "$mismatch" -eq 0 ] || { echo "FAIL: $mismatch/$RUNS reconnects not pinned to $first — stickiness broken" >&2; exit 1; }
echo "    OK: $RUNS/$RUNS pinned to $first"

echo "==> negative control: $RUNS cookieless handshakes should reach BOTH instances"
distinct="$(for _ in $(seq 1 "$RUNS"); do handshake_aff; done | grep -v '^$' | sort -u)"
n_distinct="$(printf '%s\n' "$distinct" | grep -c .)"
if [ "$n_distinct" -lt 2 ]; then
  echo "FAIL: cookieless traffic only reached: ${distinct:-nothing}; expected both instances" >&2
  echo "      (without this control, the pin above could be luck rather than the cookie)" >&2
  exit 1
fi
echo "    OK: cookieless traffic spread across: $(printf '%s ' $distinct)"

echo "==> PASS: the aff cookie pins reconnects; cookieless traffic load-balances"
