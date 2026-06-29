import { homedir } from "node:os";
import { join } from "node:path";
import { FileWalletPoolStore } from "./file-store";

export interface WalletPoolStore {
  read(id: string): Promise<Uint8Array | null>;
  write(id: string, bytes: Uint8Array): Promise<void>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
}

export function defaultStoreDir(): string {
  return join(homedir(), ".wallet-pool");
}

export function defaultStore(dir: string = defaultStoreDir()): WalletPoolStore {
  return new FileWalletPoolStore(dir);
}
