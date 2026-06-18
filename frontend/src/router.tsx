import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from "@tanstack/react-router";

import { Desktop } from "./desktop/Desktop";

const rootRoute = createRootRoute({ component: Outlet });

/** Home: the arena desktop (draggable game windows + telemetry rail + chat). */
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Desktop,
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

const routeTree = rootRoute.addChildren([
  homeRoute,
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
