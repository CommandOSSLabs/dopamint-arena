import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useRef } from "react";
import type { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";
import { RegularPaymentsShopCartFlyLayer } from "./RegularPaymentsShopCartFlyLayer";
import { RegularPaymentsShopBody } from "./RegularPaymentsShopBody";
import { RegularPaymentsShopHeader } from "./RegularPaymentsShopHeader";
import { useCartFly } from "../../hooks/useCartFly";
import { RegularPaymentsShopCart } from "./RegularPaymentsShopCart";

interface RegularPaymentsShopProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
}

export function RegularPaymentsShop({ session }: RegularPaymentsShopProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cartTargetRef = useRef<HTMLSpanElement>(null);

  const { flies, spawnFlyForProduct, removeFly } = useCartFly({
    containerRef,
    cartTargetRef,
  });

  return (
    <div
      ref={containerRef}
      className={cn("relative flex h-full min-h-0 flex-col")}
    >
      <RegularPaymentsShopCartFlyLayer
        session={session}
        flies={flies}
        spawnFlyForProduct={spawnFlyForProduct}
        onFlyEnd={removeFly}
      />

      <RegularPaymentsShopHeader session={session} />

      <RegularPaymentsShopBody session={session} />

      <RegularPaymentsShopCart
        session={session}
        cartTargetRef={cartTargetRef}
      />
    </div>
  );
}
