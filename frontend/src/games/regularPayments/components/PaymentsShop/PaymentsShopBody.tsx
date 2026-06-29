import { cn } from "@/lib/utils";
import { CATEGORIES, productsForCategory } from "../../utils/catalog";
import { formatMtps } from "../../utils";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";

interface PaymentsShopBodyProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
}

export function PaymentsShopBody({ session }: PaymentsShopBodyProps) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 space-y-4 overflow-y-auto",
        "p-[clamp(8px,2.4cqmin,14px)]",
      )}
    >
      {CATEGORIES.map((cat) => (
        <section key={cat.id}>
          <h2
            className={cn(
              "sketch-note mb-2 font-bold uppercase tracking-wide",
              "text-[clamp(11px,2.6cqmin,13px)]",
            )}
          >
            {cat.label}
          </h2>

          <div className="grid grid-cols-4 gap-3">
            {productsForCategory(cat.id).map((product) => (
              <button
                key={product.id}
                data-product-id={product.id}
                onClick={() => {
                  // stop Auto mode when click manually
                  if (session.autoMode) session.toggleAutoMode();

                  session.addToCart(product);
                }}
                disabled={session.busy || product.priceMtps > session.balanceA}
                className={cn(
                  "sketch-panel sketch-stroke flex flex-col items-center p-3 text-center",
                  "transition-transform hover:-translate-y-0.5 hover:rotate-[-0.3deg]",
                  "disabled:pointer-events-none disabled:opacity-45",
                )}
              >
                <span
                  data-product-emoji
                  className="text-[clamp(1.6rem,6cqmin,2rem)] leading-none"
                >
                  {product.emoji}
                </span>

                <span className="text-[clamp(11px,2.8cqmin,14px)] font-bold leading-tight">
                  {product.name}
                </span>

                <span className="sketch-note text-[clamp(10px,2.4cqmin,12px)]">
                  {formatMtps(product.priceMtps)} MTPS
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
