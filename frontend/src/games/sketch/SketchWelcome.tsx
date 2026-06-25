import type { ReactNode } from "react";
import { SketchDefs } from "./SketchDefs";

/** Dotted paper shell with a centered card — same layout as Quantum Poker's mode menu. */
export function SketchWelcome({ children }: { children: ReactNode }) {
  return (
    <div className="sketch sketch-welcome">
      <SketchDefs />
      {children}
    </div>
  );
}

export function SketchWelcomeCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={["sketch-welcome__card sketch-panel sketch-stroke", className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
