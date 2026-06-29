export const VERSION = "0.1.0";

export type {
  Network,
  CoinType,
  WalletRole,
  WalletEntry,
  PoolBlob,
  SealedMembers,
} from "./types";
export {
  WalletPoolError,
  WrongAccessValueError,
  PoolNotFoundError,
  InsufficientFundsError,
  NetworkMismatchError,
  StoreError,
  AccountDisabledError,
  MasterNotRetrievableError,
} from "./errors";
export { seal, unseal } from "./envelope";
export type { SealedEnvelope, AccessMode } from "./envelope";
export { create } from "./create";
export type { CreateOptions, CreateResult } from "./create";
export { fund } from "./fund";
export type { FundOptions, FundTarget } from "./fund";
export { open, setEnabled, loadPool } from "./pool";
export type { OpenOptions, OpenedPool } from "./pool";
export { list, pick, random, lru, RoundRobin } from "./listing";
export type {
  WalletFilter,
  ListOptions,
  ListedWallet,
  SortKey,
  SortDir,
} from "./listing";
export { viewBalance } from "./balance";
export type { ViewBalanceOptions } from "./balance";
export { exportPool, importPool, deletePool, listPools } from "./manage";
export { defaultStore, defaultStoreDir } from "./store";
export type { WalletPoolStore } from "./store";
export { FileWalletPoolStore } from "./file-store";
export { getClient, BalanceService } from "./rpc";
export type { BalanceClient } from "./rpc";
