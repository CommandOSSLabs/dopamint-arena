/**
 * The cabinet's attract screen: shown when hover freezes the self-playing demo.
 * One glowing `Play vs Bot` CTA and a quiet `Return to Home` (back to the game's
 * title screen). Hierarchy, not symmetry — taking the seat is the headline act;
 * going home is the quiet way out.
 */
export function TakeOverOverlay({
  onPlay,
  onHome,
}: {
  onPlay: () => void;
  onHome: () => void;
}) {
  return (
    <div className="shell-overlay">
      <div className="shell-console">
        <button className="shell-mode-play" onClick={onPlay}>
          <span className="ic">▶</span>
          <span className="txt">
            Play vs Bot<small>take the seat — you vs the bot</small>
          </span>
        </button>
        <button className="shell-link-home" onClick={onHome}>
          Return to Home
        </button>
      </div>
    </div>
  );
}
