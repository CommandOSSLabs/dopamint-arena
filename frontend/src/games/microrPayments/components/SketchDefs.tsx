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

        @keyframes pshopCardEnter {
          from {
            opacity: 0;
            transform: translateY(-68px) scale(0.93);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        .pshop-card-enter {
          animation: pshopCardEnter 680ms cubic-bezier(0.21, 0.95, 0.3, 1) both;
        }

        @keyframes pshopDominoPush {
          0% {
            transform: translate(0, 0);
          }
          30% {
            transform: translate(12px, 6px);
          }
          65% {
            transform: translate(3px, 2px);
          }
          100% {
            transform: translate(0, 0);
          }
        }
        .pshop-domino-push {
          animation: pshopDominoPush 820ms cubic-bezier(0.22, 0.95, 0.3, 1) both;
        }

        @keyframes pshopCardExit {
          to {
            opacity: 0;
            transform: scale(0.955) translateY(9px);
          }
        }
        .pshop-card-exit {
          animation: pshopCardExit 280ms ease forwards;
          pointer-events: none;
        }

        .pshop-linger {
          box-shadow: 0 0 0 1px rgba(47, 158, 68, 0.18);
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
