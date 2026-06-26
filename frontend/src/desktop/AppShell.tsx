import {
  Activity,
  Compass,
  Gamepad2,
  MessagesSquare,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";

import { ThemeToggle } from "@/components/ui/theme-toggle";
import { WalletButton } from "@/wallet/WalletButton";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";

/** Which arena section/workspace is shown; carried in the `/` route's `section`
 *  search param (drives the desktop workspace tabs and the phone bottom tabs).
 *  `live` is the merged stats+activity telemetry, shown only on the phone — on
 *  desktop telemetry is the persistent bottom dock. */
export type MobileSection = "games" | "payment" | "chat" | "live";

// Phone bottom tabs. Arena/Payment/Chat/Live select an arena section (a search param
// on `/`); Explorer is a sibling route. Both live in this shell so navigating to the
// explorer never tears the navbar down — the body swaps, the chrome stays.
const MOBILE_NAV: {
  section: MobileSection;
  label: string;
  icon: LucideIcon;
}[] = [
  { section: "games", label: "Arena", icon: Gamepad2 },
  { section: "payment", label: "Payment", icon: Wallet },
  { section: "chat", label: "Chat", icon: MessagesSquare },
  { section: "live", label: "Live", icon: Activity },
];

const tabClass =
  "relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors";

// Top-bar nav tabs mirror the Live Transactions filter tabs (text-foreground/60,
// hover to full, rounded). The active route adds a soft gray border + raised bg.
const navTab =
  "inline-flex items-center gap-1 rounded-md border border-transparent px-2.5 py-1 text-xs font-medium text-foreground/60 transition-colors hover:text-foreground";
const navTabActive = "border-border bg-background text-foreground";

/**
 * Persistent app chrome shared by the arena (`/`) and the explorer (`/explorer`):
 * a top navbar (always) and, on phones, a bottom tab bar. Page bodies render into
 * the `<Outlet/>` so a route change swaps content without remounting the navbar.
 */
export function AppShell() {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const { pathname, search } = useRouterState({ select: (s) => s.location });
  const onArena = pathname === "/";
  const onExplorer = pathname.startsWith("/explorer");
  const section = (search as { section?: MobileSection }).section ?? "games";

  return (
    <div className="relative flex h-full flex-col text-foreground">
      <header className="relative z-10 flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background/70 px-3 py-2.5 backdrop-blur-xl">
        <div className="flex items-center gap-2.5">
          <span className="wal-display text-sm sm:text-base">
            Million<span className="wal-gradient-text">TPS</span>
          </span>
          <nav className="hidden items-center gap-1 lg:flex">
            <Link to="/" className={cn(navTab, onArena && navTabActive)}>
              Arena
            </Link>
            <Link
              to="/explorer"
              className={cn(navTab, onExplorer && navTabActive)}
            >
              <Compass className="size-3.5" />
              Explorer
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-1.5">
          <WalletButton />
          <ThemeToggle />
        </div>
      </header>

      <div className="relative z-[1] min-h-0 flex-1">
        <Outlet />
      </div>

      {!isDesktop && (
        <nav className="z-10 flex shrink-0 items-stretch border-t border-border bg-background/80 backdrop-blur-xl">
          {MOBILE_NAV.map((t) => {
            const Icon = t.icon;
            const active = !onExplorer && section === t.section;
            return (
              <Link
                key={t.section}
                to="/"
                search={t.section === "games" ? {} : { section: t.section }}
                aria-label={t.label}
                className={cn(
                  tabClass,
                  active
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-5" />
                {t.label}
              </Link>
            );
          })}
          <Link
            to="/explorer"
            aria-label="Explorer"
            className={cn(
              tabClass,
              onExplorer
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Compass className="size-5" />
            Explorer
          </Link>
        </nav>
      )}
    </div>
  );
}
