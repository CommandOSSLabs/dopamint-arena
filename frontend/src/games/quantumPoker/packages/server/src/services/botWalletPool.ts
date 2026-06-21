import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import {
  ed25519Address,
  keyPairFromSecret,
  SignatureScheme,
  type KeyPair,
} from "sui-tunnel-ts/core/crypto";
import type { ServerConfig } from "../serverConfig";

export interface BotPartyConfig {
  address: string;
  publicKey: string;
  signatureType: number;
}

export interface BotWallet {
  id: string;
  keyPair: KeyPair;
  address: string;
  leasedTo: string | null;
}

function parseSecret(hex: string): Uint8Array {
  const secret = fromHex(hex);
  if (secret.length !== 32) {
    throw new Error(`bot private key must be 32 bytes, got ${secret.length}`);
  }
  return secret;
}

function devSecret(index: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => (index * 37 + i + 1) & 0xff);
}

export class BotWalletPool {
  private readonly wallets: BotWallet[];

  constructor(wallets: BotWallet[]) {
    this.wallets = wallets;
  }

  static fromConfig(config: ServerConfig): BotWalletPool {
    const secrets =
      config.botPrivateKeys.length > 0
        ? config.botPrivateKeys.map(parseSecret)
        : config.allowDevBotKeys
          ? [devSecret(0), devSecret(1)]
          : [];
    const wallets = secrets.map((secret, index) => {
      const keyPair = keyPairFromSecret(secret);
      return {
        id: `bot-${index}`,
        keyPair,
        address: ed25519Address(keyPair.publicKey),
        leasedTo: null,
      };
    });
    return new BotWalletPool(wallets);
  }

  availableCount(): number {
    return this.wallets.filter((wallet) => wallet.leasedTo === null).length;
  }

  lease(sessionId: string): BotWallet {
    const wallet = this.wallets.find(
      (candidate) => candidate.leasedTo === null,
    );
    if (!wallet) {
      throw new Error("no bot wallets available");
    }
    wallet.leasedTo = sessionId;
    return wallet;
  }

  get(walletId: string): BotWallet | null {
    return this.wallets.find((wallet) => wallet.id === walletId) ?? null;
  }

  release(sessionId: string): void {
    const wallet = this.wallets.find(
      (candidate) => candidate.leasedTo === sessionId,
    );
    if (wallet) wallet.leasedTo = null;
  }

  partyConfig(wallet: BotWallet): BotPartyConfig {
    return {
      address: wallet.address,
      publicKey: toHex(wallet.keyPair.publicKey),
      signatureType: SignatureScheme.ED25519,
    };
  }
}
