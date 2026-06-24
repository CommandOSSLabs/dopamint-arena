import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { createParticipant } from 'sui-tunnel-ts/core/keys';
import { buildCreateAndFundLegacy } from 'sui-tunnel-ts/onchain/createAndFund';
import { SignatureScheme } from 'sui-tunnel-ts/core/crypto';

const secret = process.argv[2];
if (!secret) throw new Error('pass suiprivkey');
const kp = Ed25519Keypair.fromSecretKey(secret);
const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet') });
const a = createParticipant('chat-a');
const b = createParticipant('chat-b');
const tx = new Transaction();
const [coinA, coinB] = tx.splitCoins(tx.gas, [tx.pure.u64(100n), tx.pure.u64(100n)]);
buildCreateAndFundLegacy(tx, {
  partyA: { address: a.address, publicKey: a.keyPair.publicKey, signatureType: SignatureScheme.ED25519 },
  partyB: { address: b.address, publicKey: b.keyPair.publicKey, signatureType: SignatureScheme.ED25519 },
  coinA, coinB, timeoutMs: 86_400_000n, penaltyAmount: 0n,
});
tx.setSender(kp.getPublicKey().toSuiAddress());
const bytes = await tx.build({ client });
const { signature } = await kp.signTransaction(bytes);
const res = await client.executeTransactionBlock({ transactionBlock: bytes, signature, options: { showObjectChanges: true } });
console.log('digest', res.digest);
await client.waitForTransaction({ digest: res.digest });
const obj = await client.getTransactionBlock({ digest: res.digest, options: { showObjectChanges: true } });
const tunnel = obj.objectChanges.find((c) => c.type === 'created' && c.objectType.includes('::tunnel::Tunnel'));
console.log('tunnel', tunnel?.objectId);
