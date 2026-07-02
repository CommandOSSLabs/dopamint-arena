import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  PaymentsProtocol,
  type PaymentsState,
  type PaymentMove,
} from "sui-tunnel-ts/protocol/payments";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";
import {
  CATALOG_PRICE_AMOUNTS,
  PRODUCTS,
} from "@/games/regularPayments/utils/catalog";
import {
  DEPOSIT_BUDGET,
  DEPOSIT_B_DUST,
  REGULAR_PAYMENTS_GAME_ID,
} from "@/games/regularPayments/utils/constants";
import { verifyMove } from "@/games/regularPayments/utils/sessionCore";

/** Whether a move is a valid catalog-priced payment the shop (B) may co-sign. Mirrors FE `verifyMove`
 *  and Rust `RegularPayments` / `catalog::is_catalog_amount`. */
export function isCatalogPaymentMove(
  state: PaymentsState,
  move: PaymentMove,
): boolean {
  return verifyMove(state, move, PRODUCTS).valid;
}

/** Catalog allowlist (whole MTPS) — parity with `tunnel-payments/src/catalog.rs`. */
export const REGULAR_PAYMENTS_CATALOG_PRICES = CATALOG_PRICE_AMOUNTS;

/**
 * Shopper bot (seat A) for load / agent simulations.
 * Picks a random catalog item the current budget can afford — same shape as a human add-to-cart step.
 */
class ShopperBot implements GameBot<PaymentsState, PaymentMove> {
  private readonly protocol: PaymentsProtocol;
  private readonly rng: () => number;

  constructor(protocol: PaymentsProtocol, ctx: BotContext) {
    this.protocol = protocol;
    this.rng = ctx.rngForSeat("A");
  }

  plan(state: PaymentsState): PaymentMove | null {
    const affordable = PRODUCTS.filter((p) => p.priceMtps <= state.balanceA);
    if (affordable.length === 0) return null;

    const product = affordable[Math.floor(this.rng() * affordable.length)];
    const move: PaymentMove = { from: "A", amount: product.priceMtps };
    if (!isCatalogPaymentMove(state, move)) return null;
    return move;
  }

  confirm(_state: PaymentsState, _move: PaymentMove): void {}

  abort(): void {}
}

/**
 * Shop POS bot (seat B) on the fleet.
 * Never initiates purchases — only co-signs valid shopper moves relayed from A (see `isCatalogPaymentMove`).
 * Refund moves (B→A) are human-driven on the FE; the fleet bot co-signs when proposed over the relay.
 */
class ShopBot implements GameBot<PaymentsState, PaymentMove> {
  plan(_state: PaymentsState): PaymentMove | null {
    return null;
  }

  confirm(_state: PaymentsState, _move: PaymentMove): void {}

  abort(): void {}
}

export function createRegularPaymentsKit(): GameKit<
  PaymentsState,
  PaymentMove
> {
  const protocol = new PaymentsProtocol();

  return {
    id: REGULAR_PAYMENTS_GAME_ID,
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      seat === "A" ? new ShopperBot(protocol, ctx) : new ShopBot(),
    // Shopper budget at open; seat B dust is an on-chain open param, not this kit's stake field.
    defaultStake: DEPOSIT_BUDGET,
  };
}

/** Seat B activation dust — exported for fleet / arena profile parity with the FE constants. */
export const REGULAR_PAYMENTS_SEAT_B_DUST = DEPOSIT_B_DUST;
