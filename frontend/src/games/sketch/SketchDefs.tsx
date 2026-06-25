import type { JSX } from "react";

/** SVG roughen filter — render once per sketch window; borders reference `#skRough`. */
export function SketchDefs({
  filterId = "skRough",
}: {
  filterId?: string;
}): JSX.Element {
  return (
    <svg aria-hidden width="0" height="0" className="sketch-defs">
      <filter id={filterId} x="-6%" y="-6%" width="112%" height="112%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.018"
          numOctaves={2}
          seed={7}
          result="noise"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="noise"
          scale="2.6"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}
