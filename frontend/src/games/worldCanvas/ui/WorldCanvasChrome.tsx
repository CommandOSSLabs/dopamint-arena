/**
 * Injects the keyframes the World Canvas UI animates against (status-chip pulse,
 * menu rise/glow, twinkle). Fonts are the arena globals (Outfit + JetBrains
 * Mono), so nothing else is loaded. Mount ONCE near the root so both the menu and
 * the live wall can reference the animations across view switches.
 */
export function WorldCanvasChrome() {
  return (
    <style>{`
      @keyframes wcPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
      @keyframes wcRise { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
      @keyframes wcGlow { 0%,100% { text-shadow: 0 0 22px rgba(77,162,255,0.35) } 50% { text-shadow: 0 0 40px rgba(77,162,255,0.6) } }
      @keyframes wcTwinkle { 0%,100% { opacity: 0.15; transform: scale(0.8) } 50% { opacity: 0.9; transform: scale(1.15) } }
    `}</style>
  );
}
