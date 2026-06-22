from pathlib import Path

p = Path('src/bench/relayBench.ts')
f = p.read_text()

old = '''  // Stagger the two queue joins slightly: if both hit the backend atomically
  // the Redis Lua pair script can miss one of them.
  const mA = await clientA.quickMatch(game);
  await sleep(50);
  const mB = await clientB.quickMatch(game);'''
new = '''  // Stagger the two queue joins slightly: if both hit the backend atomically
  // the Redis Lua pair script can miss one of them. Start both promises before
  // awaiting so A can wait while B joins -- awaiting A first would deadlock.
  const pA = clientA.quickMatch(game);
  await sleep(50);
  const pB = clientB.quickMatch(game);
  const [mA, mB] = await Promise.all([pA, pB]);'''
assert old in f, 'quickMatch block not found'
f = f.replace(old, new)

old2 = '''  const ephA = core.generateKeyPair();
  const ephB = core.generateKeyPair();
  const tunnelId = `bench-${matchId}-${idx}`;

  // Set up all app-channel listeners up front to avoid races with a fast backend.
  const gotHelloA = new Promise<string>((resolve) =>
    chA.onPeer((msg) => {
      if (msg.t === "hello") resolve(msg.ephemeralPubkey);
    }),
  );
  const gotHelloB = new Promise<string>((resolve) =>
    chB.onPeer((msg) => {
      if (msg.t === "hello") resolve(msg.ephemeralPubkey);
    }),
  );
  const gotStakeA = new Promise<number>((resolve) =>
    chA.onPeer((msg) => {
      if (msg.t === "stake") resolve(msg.amount);
    }),
  );
  const gotStakeB = new Promise<number>((resolve) =>
    chB.onPeer((msg) => {
      if (msg.t === "stake") resolve(msg.amount);
    }),
  );
  const openedA = new Promise<void>((resolve) =>
    chA.onPeer((msg) => {
      if (msg.t === "open" && msg.tunnelId === tunnelId) resolve();
    }),
  );

  // Hello.
  chA.sendPeer({ t: "hello", ephemeralPubkey: core.bytesToHex(ephA.publicKey) });
  chB.sendPeer({ t: "hello", ephemeralPubkey: core.bytesToHex(ephB.publicKey) });'''
new2 = '''  const ephA = core.generateKeyPair();
  const ephB = core.generateKeyPair();
  // The wire format requires a valid Sui address as tunnelId. We are not
  // creating an on-chain tunnel, but the signing/serialization still validates
  // the address format, so derive a deterministic one from the match id.
  const tunnelId = core.ed25519Address(
    core.blake2b256(new TextEncoder().encode(matchId)).slice(0, 32),
  );

  // MpClient.channel only keeps one onPeer callback, so each channel needs a
  // single dispatcher that resolves the right promise per message type.
  let resolveHelloA: (pubkey: string) => void;
  let resolveStakeA: (amount: number) => void;
  let resolveOpenA: () => void;
  let resolveHelloB: (pubkey: string) => void;
  let resolveStakeB: (amount: number) => void;
  const gotHelloA = new Promise<string>((resolve) => (resolveHelloA = resolve));
  const gotStakeA = new Promise<number>((resolve) => (resolveStakeA = resolve));
  const openedA = new Promise<void>((resolve) => (resolveOpenA = resolve));
  const gotHelloB = new Promise<string>((resolve) => (resolveHelloB = resolve));
  const gotStakeB = new Promise<number>((resolve) => (resolveStakeB = resolve));

  chA.onPeer((msg) => {
    if (msg.t === "hello") resolveHelloA!(msg.ephemeralPubkey);
    else if (msg.t === "stake") resolveStakeA!(msg.amount);
    else if (msg.t === "open" && msg.tunnelId === tunnelId) resolveOpenA!();
  });
  chB.onPeer((msg) => {
    if (msg.t === "hello") resolveHelloB!(msg.ephemeralPubkey);
    else if (msg.t === "stake") resolveStakeB!(msg.amount);
  });

  // Hello.
  chA.sendPeer({ t: "hello", ephemeralPubkey: core.toHex(ephA.publicKey) });
  chB.sendPeer({ t: "hello", ephemeralPubkey: core.toHex(ephB.publicKey) });'''
assert old2 in f, 'peer block not found'
f = f.replace(old2, new2)
p.write_text(f)
print('patched')
