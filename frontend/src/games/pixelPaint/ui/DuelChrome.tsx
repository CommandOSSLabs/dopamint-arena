/**
 * DuelChrome — global side-effect chrome for the Pixel Duel restyle. Render it
 * ONCE near the menu/duel root (mounted by PaintWindow). It injects, scoped to
 * the page but reusable across every duel panel:
 *   - a Google-Fonts @import for Space Grotesk (display) + JetBrains Mono (numbers),
 *   - the `pd*` keyframes the menu/duel animations reference,
 *   - the `.pd-glass` liquid-glass panel class (+ its gradient-hairline ::before),
 *   - a hidden <svg> holding <filter id="pdGlass"> so `url(#pdGlass)` refraction
 *     in `backdrop-filter` (and the `glass`/`.pd-glass` tokens) resolves.
 *
 * Renders no visible box of its own. Mount exactly one instance — the SVG filter
 * id and keyframes are global, so duplicates are redundant (and would duplicate
 * the #pdGlass id). Components opt in via `className="pd-glass"` or the `glass`
 * token from ./tokens.
 */

/** Stylesheet: font import (must stay first), keyframes, then the glass panel. */
const PD_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');

@keyframes pdPop{0%{transform:scale(.92);opacity:0}100%{transform:scale(1);opacity:1}}
@keyframes pdPulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes pdFloat{0%{transform:translateY(6px);opacity:0}100%{transform:translateY(0);opacity:1}}
@keyframes pdTwinkle{0%,100%{opacity:.12;transform:scale(.7)}50%{opacity:.65;transform:scale(1)}}
@keyframes pdRise{0%{opacity:0;transform:translateY(14px) scale(.96)}100%{opacity:1;transform:translateY(0) scale(1)}}
@keyframes pdGlow{0%,100%{text-shadow:0 0 24px rgba(77,162,255,0.35)}50%{text-shadow:0 0 38px rgba(77,162,255,0.6)}}
@keyframes pdSweep{0%{background-position:-200% 0}100%{background-position:200% 0}}

.pd-glass{
  position:relative;
  background:linear-gradient(140deg, rgba(64,80,130,0.40), rgba(16,18,40,0.24));
  backdrop-filter:url(#pdGlass) blur(8px) saturate(180%) brightness(1.08);
  -webkit-backdrop-filter:blur(12px) saturate(180%);
  border:1px solid rgba(255,255,255,0.16);
  box-shadow:0 14px 46px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -14px 34px rgba(90,140,255,0.07);
  border-radius:14px;
}
.pd-glass::before{
  content:'';
  position:absolute;
  inset:0;
  border-radius:inherit;
  padding:1.3px;
  background:linear-gradient(135deg, rgba(255,255,255,0.72), rgba(150,185,255,0.2) 28%, transparent 52%, rgba(255,255,255,0.16) 100%);
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;
  mask-composite:exclude;
  pointer-events:none;
}
`;

export function DuelChrome() {
  return (
    <>
      <style>{PD_CSS}</style>
      {/* Liquid-glass refraction filter referenced by url(#pdGlass). Off-screen,
          non-interactive, and aria-hidden — purely a paint resource. */}
      <svg
        width="0"
        height="0"
        aria-hidden="true"
        style={{ position: "absolute", pointerEvents: "none" }}
      >
        <defs>
          <filter
            id="pdGlass"
            x="-30%"
            y="-30%"
            width="160%"
            height="160%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.013 0.016"
              numOctaves={2}
              seed={11}
              result="n"
            />
            <feGaussianBlur in="n" stdDeviation={1.4} result="nb" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="nb"
              scale={22}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>
    </>
  );
}
