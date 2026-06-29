export class WalletPoolError extends Error {}

export class WrongAccessValueError extends WalletPoolError {
  constructor(message = "decryption failed (wrong access value or tampered blob)") {
    super(message);
    this.name = "WrongAccessValueError";
  }
}
export class PoolNotFoundError extends WalletPoolError {
  constructor(id: string) {
    super(`pool not found: ${id}`);
    this.name = "PoolNotFoundError";
  }
}
export class InsufficientFundsError extends WalletPoolError {
  constructor(msg: string) {
    super(msg);
    this.name = "InsufficientFundsError";
  }
}
export class NetworkMismatchError extends WalletPoolError {
  constructor(msg: string) {
    super(msg);
    this.name = "NetworkMismatchError";
  }
}
export class StoreError extends WalletPoolError {
  constructor(msg: string) {
    super(msg);
    this.name = "StoreError";
  }
}
export class AccountDisabledError extends WalletPoolError {
  constructor(addr: string) {
    super(`account disabled: ${addr}`);
    this.name = "AccountDisabledError";
  }
}
export class MasterNotRetrievableError extends WalletPoolError {
  constructor() {
    super("master key is sealed-only; use fund()");
    this.name = "MasterNotRetrievableError";
  }
}
