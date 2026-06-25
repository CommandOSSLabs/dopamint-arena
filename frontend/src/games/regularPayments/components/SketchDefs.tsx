import type { JSX } from "react";

/** SVG roughen filter — render once per window; borders reference `url(#pshopRough)`. */
export function SketchDefs(): JSX.Element {
  return (
    <svg width="0" height="0" className="absolute size-0">
      <filter id="pshopRough" x="-6%" y="-6%" width="112%" height="112%">
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
