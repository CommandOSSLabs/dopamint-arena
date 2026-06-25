import type { CSSProperties, ReactNode } from "react";
import { carColor } from "../crossTheme";

const INK = "#23221f";

function SketchIcon({
  className,
  viewBox,
  children,
}: {
  className?: string;
  viewBox: string;
  children: ReactNode;
}) {
  return (
    <svg
      className={["cross-sketch-svg", className].filter(Boolean).join(" ")}
      viewBox={viewBox}
      aria-hidden
    >
      <g filter="url(#skRough)">{children}</g>
    </svg>
  );
}

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
  const body = party === "a" ? "#fffefb" : "#e7f1fb";
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
      <SketchIcon viewBox="0 0 24 20">
        {mine ? (
          <rect
            x="1.2"
            y="2"
            width="21.6"
            height="16"
            rx="2"
            fill="none"
            stroke="#e8920c"
            strokeWidth="1.4"
            strokeDasharray="3.5 2.5"
          />
        ) : null}
        <ellipse
          cx="12"
          cy="17.2"
          rx="7.2"
          ry="1.4"
          fill="rgba(35,34,31,0.1)"
        />
        <rect
          x="7"
          y="8.5"
          width="10"
          height="7"
          rx="1.2"
          fill={body}
          stroke={INK}
          strokeWidth="1.3"
        />
        <path
          d="M10.5 8.5 V6.8 Q12 5.6 13.5 6.8 V8.5"
          fill="#ffe9e9"
          stroke="#e03131"
          strokeWidth="1.1"
        />
        <circle cx="10.2" cy="11.2" r="0.75" fill={INK} />
        <circle cx="13.8" cy="11.2" r="0.75" fill={INK} />
        <path
          d="M17.2 11.8 L19.4 12.6 L17.2 13.4 Z"
          fill="#ffe9bd"
          stroke="#e8920c"
          strokeWidth="1"
        />
      </SketchIcon>
    </span>
  );
}

export function CrossCar({ lane, ordinal }: { lane: number; ordinal: number }) {
  const color = carColor(lane, ordinal);
  return (
    <span
      className="cross-sprite cross-car"
      style={{ "--cx-car": color } as CSSProperties}
      aria-hidden
    >
      <SketchIcon viewBox="0 0 24 14">
        <ellipse
          cx="12"
          cy="12.8"
          rx="9.5"
          ry="1.2"
          fill="rgba(35,34,31,0.1)"
        />
        <rect
          x="1.5"
          y="7.2"
          width="21"
          height="5.2"
          rx="1"
          fill="var(--cx-car)"
          stroke={INK}
          strokeWidth="1.2"
        />
        <rect
          x="5.2"
          y="3.8"
          width="13.6"
          height="3.8"
          rx="0.8"
          fill="var(--cx-car)"
          stroke={INK}
          strokeWidth="1.1"
        />
        <rect
          x="7.2"
          y="4.8"
          width="3.2"
          height="2"
          rx="0.3"
          fill="#e7f1fb"
          stroke={INK}
          strokeWidth="0.8"
        />
        <rect
          x="13.6"
          y="4.8"
          width="3.2"
          height="2"
          rx="0.3"
          fill="#e7f1fb"
          stroke={INK}
          strokeWidth="0.8"
        />
        <circle
          cx="6.2"
          cy="12.2"
          r="1.5"
          fill="#fffefb"
          stroke={INK}
          strokeWidth="1"
        />
        <circle
          cx="17.8"
          cy="12.2"
          r="1.5"
          fill="#fffefb"
          stroke={INK}
          strokeWidth="1"
        />
      </SketchIcon>
    </span>
  );
}

export function CrossLog() {
  return (
    <span className="cross-sprite cross-log" aria-hidden>
      <SketchIcon viewBox="0 0 24 12">
        <ellipse cx="12" cy="10.5" rx="10" ry="1.1" fill="rgba(35,34,31,0.1)" />
        <rect
          x="1"
          y="4.5"
          width="22"
          height="5"
          rx="2.5"
          fill="#ede4d8"
          stroke={INK}
          strokeWidth="1.2"
        />
        <line
          x1="7.5"
          y1="5"
          x2="7.5"
          y2="9"
          stroke={INK}
          strokeWidth="0.9"
          strokeDasharray="1.2 1.4"
          opacity="0.55"
        />
        <line
          x1="16.5"
          y1="5"
          x2="16.5"
          y2="9"
          stroke={INK}
          strokeWidth="0.9"
          strokeDasharray="1.2 1.4"
          opacity="0.55"
        />
      </SketchIcon>
    </span>
  );
}

export function CrossTrain({ segment }: { segment: "head" | "mid" | "tail" }) {
  const head = segment === "head";
  const tail = segment === "tail";
  return (
    <span
      className={`cross-sprite cross-train cross-train--${segment}`}
      aria-hidden
    >
      <SketchIcon viewBox="0 0 24 13">
        <ellipse
          cx="12"
          cy="11.5"
          rx="10.5"
          ry="1.1"
          fill="rgba(35,34,31,0.1)"
        />
        <rect
          x="1"
          y="5"
          width="22"
          height="5.5"
          rx={head ? 1.5 : tail ? 1.5 : 0.8}
          fill="#e8ecef"
          stroke={INK}
          strokeWidth="1.2"
        />
        {head ? (
          <rect
            x="14"
            y="2.2"
            width="8"
            height="3.2"
            rx="0.6"
            fill="#ffe9bd"
            stroke="#e8920c"
            strokeWidth="1.1"
          />
        ) : null}
        <line
          x1="1"
          y1="7.8"
          x2="23"
          y2="7.8"
          stroke={INK}
          strokeWidth="0.8"
          opacity="0.35"
        />
      </SketchIcon>
    </span>
  );
}

export function CrossTree() {
  return (
    <span className="cross-sprite cross-tree" aria-hidden>
      <SketchIcon viewBox="0 0 20 22">
        <ellipse cx="10" cy="20" rx="5.5" ry="1" fill="rgba(35,34,31,0.1)" />
        <rect
          x="8.6"
          y="14.5"
          width="2.8"
          height="5"
          rx="0.5"
          fill="#e8ddd0"
          stroke={INK}
          strokeWidth="1.1"
        />
        <circle
          cx="10"
          cy="9.5"
          r="6.2"
          fill="#b8e6bc"
          stroke="#2f9e44"
          strokeWidth="1.3"
        />
        <path
          d="M6.2 9.8 Q10 6.8 13.8 9.8"
          fill="none"
          stroke="#2f9e44"
          strokeWidth="0.9"
          strokeLinecap="round"
          opacity="0.7"
        />
      </SketchIcon>
    </span>
  );
}
