import type { CSSProperties } from "react";
import { carColor } from "../crossTheme";

/** Voxel-style CSS sprites — chunky 3D look inside flat square tiles. */

export function CrossChicken({
  party,
  mine,
  hit,
  mini,
}: {
  party: "a" | "b";
  mine?: boolean;
  hit?: boolean;
  mini?: boolean;
}) {
  return (
    <span
      className={[
        "cross-sprite cross-chicken",
        `cross-chicken--${party}`,
        mine ? "cross-chicken--mine" : "",
        hit ? "cross-chicken--hit" : "",
        mini ? "cross-chicken--mini" : "",
      ].join(" ")}
      aria-hidden
    >
      <span className="cross-chicken__shadow" />
      <span className="cross-chicken__body">
        <span className="cross-chicken__face" />
        <span className="cross-chicken__comb" />
        <span className="cross-chicken__beak" />
      </span>
    </span>
  );
}

export function CrossCar({ lane, ordinal }: { lane: number; ordinal: number }) {
  const color = carColor(lane, ordinal);
  return (
    <span className="cross-sprite cross-car" style={{ "--cx-car": color } as CSSProperties} aria-hidden>
      <span className="cross-car__shadow" />
      <span className="cross-car__body">
        <span className="cross-car__roof" />
        <span className="cross-car__window cross-car__window--l" />
        <span className="cross-car__window cross-car__window--r" />
        <span className="cross-car__wheel cross-car__wheel--l" />
        <span className="cross-car__wheel cross-car__wheel--r" />
      </span>
    </span>
  );
}

export function CrossLog() {
  return (
    <span className="cross-sprite cross-log" aria-hidden>
      <span className="cross-log__shadow" />
      <span className="cross-log__body" />
    </span>
  );
}

export function CrossTrain({ segment }: { segment: "head" | "mid" | "tail" }) {
  return (
    <span className={`cross-sprite cross-train cross-train--${segment}`} aria-hidden>
      <span className="cross-train__shadow" />
      <span className="cross-train__body">
        {segment === "head" ? <span className="cross-train__cab" /> : null}
      </span>
    </span>
  );
}

export function CrossTree() {
  return (
    <span className="cross-sprite cross-tree" aria-hidden>
      <span className="cross-tree__shadow" />
      <span className="cross-tree__crown" />
      <span className="cross-tree__trunk" />
    </span>
  );
}
