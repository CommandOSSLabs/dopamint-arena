import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from "@tanstack/react-router";

import { AppShell, type MobileSection } from "./desktop/AppShell";
import { ArenaView } from "./desktop/Desktop";

const rootRoute = createRootRoute({ component: Outlet });

/** Persistent navbar shell shared by the arena and the explorer so the chrome survives route changes. */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: AppShell,
});

/** Home: the arena (draggable game windows + telemetry rail). The phone section is a `section` search param. */
const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  component: ArenaView,
  validateSearch: (
    search: Record<string, unknown>,
  ): { section?: MobileSection } => {
    const s = search.section;
    return s === "games" || s === "payment" || s === "chat" || s === "live"
      ? { section: s }
      : {};
  },
});

/**
 * Component showcase. Deliberately outside the wallet gate, and code-split into
 * its own chunk so the dev-only page never ships in the main app bundle.
 */
const designSystemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/design-system",
  component: lazyRouteComponent(
    () => import("./designSystem/DesignSystemPage"),
    "DesignSystemPage",
  ),
});

/** Live demo of the GridLayout component — draggable/resizable game windows. */
const playgroundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/playground",
  component: lazyRouteComponent(
    () => import("./playground/PlaygroundPage"),
    "PlaygroundPage",
  ),
});

/** Public settlement explorer — paginated list, address filter, live SSE prepend. */
const explorerRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/explorer",
  component: lazyRouteComponent(
    () => import("./explorer/ExplorerPage"),
    "ExplorerPage",
  ),
});

const explorerDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/explorer/$digest",
  component: lazyRouteComponent(
    () => import("./explorer/ExplorerDetailPage"),
    "ExplorerDetailPage",
  ),
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([homeRoute, explorerRoute, explorerDetailRoute]),
  designSystemRoute,
  playgroundRoute,
]);

export const router = createRouter({ routeTree });

// Register the router instance so `<Link>` / `useNavigate` are typed to our routes.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
