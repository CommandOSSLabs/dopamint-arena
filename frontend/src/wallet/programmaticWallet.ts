// A headless Wallet-Standard wallet for agent mode: accounts come from an injected Ed25519
// keypair and all signing is in-page (no popup). Registering it and connecting once makes
// dapp-kit's useSignAndExecuteTransaction route through here unchanged — the agent signs the
// gated deposit / cooperative close with zero UI. Feature shapes match @mysten/wallet-standard
// 0.21 (sui:signTransaction / sui:signAndExecuteTransaction, both v2.0.0).
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import {
  ReadonlyWalletAccount,
  SUI_TESTNET_CHAIN,
  type SuiSignAndExecuteTransactionInput,
  type SuiSignTransactionInput,
} from "@mysten/wallet-standard";

// Structural client surface the wallet needs (avoids importing a named client type — the
// app's own pattern, cf. tunnelTx `SuiReads`). The dapp-kit `useSuiClient()` value satisfies it.
interface ExecClient {
  executeTransactionBlock(input: {
    transactionBlock: Uint8Array;
    signature: string;
    options?: { showRawEffects?: boolean };
  }): Promise<{ digest: string; rawEffects?: number[] | null }>;
  waitForTransaction(input: { digest: string }): Promise<unknown>;
}

// 1×1 transparent svg; the catalog/connect UI never shows for an agent.
const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=" as const;

export class ProgrammaticWallet {
  readonly version = "1.0.0" as const;
  readonly name = "Dopamint Agent";
  readonly icon = ICON;
  readonly chains = [SUI_TESTNET_CHAIN] as const;
  readonly accounts: ReadonlyWalletAccount[];
  readonly features: Record<string, unknown>;

  constructor(keypair: Ed25519Keypair, client: ExecClient) {
    const account = new ReadonlyWalletAccount({
      address: keypair.getPublicKey().toSuiAddress(),
      publicKey: keypair.getPublicKey().toRawBytes(),
      chains: [SUI_TESTNET_CHAIN],
      features: ["sui:signTransaction", "sui:signAndExecuteTransaction"],
    });
    this.accounts = [account];

    const sign = async (input: SuiSignTransactionInput) => {
      const tx = Transaction.from(await input.transaction.toJSON());
      const bytes = await tx.build({ client: client as never });
      const { signature } = await keypair.signTransaction(bytes);
      return { tx, bytes, signature };
    };

    this.features = {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => ({ accounts: this.accounts }),
      },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "sui:signTransaction": {
        version: "2.0.0",
        signTransaction: async (input: SuiSignTransactionInput) => {
          const { bytes, signature } = await sign(input);
          return { bytes: toBase64(bytes), signature };
        },
      },
      "sui:signAndExecuteTransaction": {
        version: "2.0.0",
        signAndExecuteTransaction: async (
          input: SuiSignAndExecuteTransactionInput,
        ) => {
          const { bytes, signature } = await sign(input);
          const res = await client.executeTransactionBlock({
            transactionBlock: bytes,
            signature,
            options: { showRawEffects: true },
          });
          await client.waitForTransaction({ digest: res.digest });
          return {
            digest: res.digest,
            bytes: toBase64(bytes),
            signature,
            effects: toBase64(Uint8Array.from(res.rawEffects ?? [])),
          };
        },
      },
    };
  }
}

/** Build a wallet from a Bech32 `suiprivkey1…` secret (what `keypair.getSecretKey()` emits). */
export function programmaticWalletFromSecret(
  secretKey: string,
  client: ExecClient,
) {
  return new ProgrammaticWallet(
    Ed25519Keypair.fromSecretKey(secretKey),
    client,
  );
}
