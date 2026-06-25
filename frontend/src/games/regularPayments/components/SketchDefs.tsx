import type { JSX } from "react";

/** SVG roughen filter — render once per window; borders reference `url(#pshopRough)`. */
export function SketchDefs(): JSX.Element {
  return (
    <>
      <style>{`
        @keyframes pshop-complete-blink {
          0%,
          100% {
            opacity: 1;
            box-shadow: 0 0 0 0 rgba(47, 158, 68, 0);
          }
          50% {
            opacity: 0.82;
            box-shadow: 0 0 0 3px rgba(47, 158, 68, 0.45);
          }
        }
        .pshop-complete-blink {
          animation: pshop-complete-blink 0.75s ease-in-out infinite;
        }
      `}</style>
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
    </>
  );
}
