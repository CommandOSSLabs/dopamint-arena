# Regular Payments — Coding Patterns & Principles

> **Status:** Active  
> **Date:** 2026-06-28  
> **Last updated:** 2026-07-01
> **Scope:** Coding standards for the `regularPayments` package (and general frontend apps).

These rules govern all Regular Payments implementation to maintain a clean architecture and a consistent aesthetic.

**Visual source of truth:** the Walrus Memory design system — live showcase at `/design-system`,
token tables in `frontend/src/designSystem/tokens.ts`, global utilities in `frontend/src/styles/index.css`.

---

## 1. Props & State Management (Pass Objects)

Pass state objects or context bags directly into components rather than spreading them out into many individual props. This keeps component signatures clean and prevents "prop drilling" boilerplate.

**Good:**
```tsx
<RegularPaymentsShop session={session} />
```

**Bad:**
```tsx
<RegularPaymentsShop
  category={session.category}
  onCategory={session.setCategory}
  cart={session.cart}
  cartTotal={session.cartTotal}
  itemCount={session.itemCount}
  // ... too many props
/>
```

---

## 2. Package Layout

Follow a strict order of concern when organizing logic:

```
frontend/src/games/regularPayments/
├── index.ts                 # register({ id: "regular-payments", ... })
├── types/
│   └── index.ts             # Screen, Product, CartLine, SessionPhase, ...
├── utils/
│   ├── catalog.ts
│   ├── constants.ts
│   ├── sessionCore.ts
│   └── index.ts             # re-exports (formatMtps, etc.)
├── hooks/
│   ├── useRegularPaymentsSession.ts
│   └── useCartFly.ts
└── components/
    ├── RegularPaymentsWindow/
    │   └── index.tsx   # screen router; text-foreground shell
    ├── RegularPaymentsLobby/
    │   └── index.tsx
    ├── RegularPaymentsShop/
    │   ├── index.tsx     # composes header + body + cart + fly layer
    │   ├── RegularPaymentsShopHeader.tsx
    │   ├── RegularPaymentsShopBody.tsx
    │   ├── RegularPaymentsShopCart.tsx
    │   └── RegularPaymentsShopCartFlyLayer.tsx
    └── RegularPaymentsThankYou/
        └── index.tsx
```

**Order of concern:** `utils` → `hooks` → `components` → `types` (types may be imported everywhere).

---

## 3. Styling & Design System

Match the **Walrus Memory** design system used across the arena shell. Reference the live
component gallery at `/design-system` and token tables in `frontend/src/designSystem/tokens.ts`.

### 3.1 Component decisions
- **No per-game `.css` files** unless strictly necessary (e.g. a one-off keyframe Tailwind cannot express).
- **shadcn/ui primitives** from `@/components/ui/*` for interactive controls — `Button`, `Progress`, `Card`, etc.
- **Icons:** `lucide-react` at small sizes (`size-3` / `size-4`).
- **Theme:** semantic shadcn tokens + `.wal-*` helpers only — no per-game CSS or custom theme wrappers.

### 3.2 Tokens & helper classes

Global tokens and utilities live in `frontend/src/styles/index.css`:

| Layer | Use |
|-------|-----|
| **Semantic (shadcn)** | `text-foreground`, `text-muted-foreground`, `bg-card`, `border-border`, `text-destructive` |
| **Brand accents** | `var(--wal-violet)`, `var(--wal-mint)`, `var(--wal-lilac)`, … — see `tokens.ts` |
| **Typography helpers** | `.wal-display` (Outfit headings), `.wal-mono` (JetBrains tabular), `.wal-eyebrow` (mono label), `.wal-gradient-text` |
| **Surface chrome** | `.wal-glow` (soft lilac shadow on hero cards) |

Accent colors inline only when a semantic token is not enough — e.g. success icon wash with
`color-mix(in oklab, var(--wal-mint) 18%, transparent)`.

### 3.3 Layout patterns (floating window)

Regular Payments runs inside a resizable arena window — prefer **container-query units** (`cqmin`)
for type and padding so the UI scales with the window, not the viewport.

**Window shell** (`RegularPaymentsWindow`): flex column, `text-foreground`, no extra theme wrapper.

**Hero / receipt cards** (lobby, thank-you): glassy panel —
`rounded-[20px] border border-border bg-card/75 backdrop-blur-xl`, optional `wal-glow`.

**Product grid** (`RegularPaymentsShopBody`): `rounded-xl border border-border bg-card` tiles;
`hover:bg-secondary/80`; disabled via `opacity-45 pointer-events-none`.

**Shop chrome** (header, cart): `border-border` dividers, `bg-card/80` on the cart footer.

### 3.4 Tailwind + `cn()`
Merge layout utilities and conditional modifiers with `cn()` from `@/lib/utils`.

**Good:**
```tsx
className={cn(
  "flex flex-col rounded-xl border border-border bg-card p-3",
  "transition-colors hover:bg-secondary/80",
  disabled && "pointer-events-none opacity-45",
)}
```

**Bad:**
```tsx
className={`flex flex-col rounded-xl ${disabled ? "opacity-45" : ""}`}
```

---

## 4. TypeScript Patterns

### 4.1 Prefer `interface` over `type`
Use **`interface`** for every object shape and component props bag.

**Good:**
```typescript
export interface Product {
  id: string;
  name: string;
}

interface ProductCardProps {
  product: Product;
}
```

### 4.2 When to use `type`
Use `type` only for unions, literal unions, or utility compositions that interfaces cannot express.
```typescript
export type Screen = "lobby" | "shop" | "thankYou";
export type ProductCategory = "fresh" | "snacks" | "drinks";
```
