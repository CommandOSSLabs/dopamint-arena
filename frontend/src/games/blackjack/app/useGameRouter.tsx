import { createContext, useContext, useState, ReactNode } from "react";

export type RoutePath = "/" | "/play" | "/bot" | "/pvp";

interface GameRouterContextType {
  currentRoute: RoutePath;
  navigate: (path: RoutePath) => void;
}

const GameRouterContext = createContext<GameRouterContextType | undefined>(
  undefined,
);

export function GameRouterProvider({ children }: { children: ReactNode }) {
  const [currentRoute, setCurrentRoute] = useState<RoutePath>("/");

  const navigate = (path: RoutePath) => {
    setCurrentRoute(path);
  };

  return (
    <GameRouterContext.Provider value={{ currentRoute, navigate }}>
      {children}
    </GameRouterContext.Provider>
  );
}

export function useGameNavigate() {
  const context = useContext(GameRouterContext);
  if (!context) {
    throw new Error("useGameNavigate must be used within a GameRouterProvider");
  }
  return context.navigate;
}

export function useCurrentRoute() {
  const context = useContext(GameRouterContext);
  if (!context) {
    throw new Error("useCurrentRoute must be used within a GameRouterProvider");
  }
  return context.currentRoute;
}
