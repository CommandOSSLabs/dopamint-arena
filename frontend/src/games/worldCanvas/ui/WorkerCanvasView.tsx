/**
 * Worker-hosted solo view for World Canvas: renders the auto-play canvas managed by the
 * SoloEngine in the worker. Drop-in for `CanvasView` when `engineEnabled()`.
 */
import { useEffect } from "react";
import { useWorldCanvasSolo, type WorldCanvasSoloSession } from "../useWorldCanvasSolo";

interface Props {
  windowId: string;
  onHome: () => void;
}

export function WorkerCanvasView({ windowId, onHome }: Props) {
  const session = useWorldCanvasSolo(windowId);

  // Auto-start the solo match on mount.
  useEffect(() => {
    if (session.status === "idle") {
      session.start();
    }
  }, [session.status]);

  if (session.status === "idle" || session.status === "matching") {
    return (
      <div className="sketch-welcome">
        <div className="sketch-welcome__card sketch-panel sketch-stroke">
          <span className="sketch-title">Starting bot battle…</span>
        </div>
      </div>
    );
  }

  if (session.status === "error") {
    return (
      <div className="sketch-welcome">
        <div className="sketch-welcome__card sketch-panel sketch-stroke">
          <span className="sketch-eyebrow">Error</span>
          <span className="sketch-title">{session.error}</span>
          <button onClick={() => session.reset()} className="sketch-btn">
            Retry
          </button>
        </div>
      </div>
    );
  }

  // The view from the worker is the WorldCanvasState — render the cell list.
  const view = session.view as { cells?: Array<{ cell: number; color: number }> } | null;
  const cells = view?.cells ?? [];

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(20, 1fr)",
          gap: 1,
          padding: 8,
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
        }}
      >
        {Array.from({ length: 400 }, (_, i) => {
          const painted = cells.find((c) => c.cell === i);
          return (
            <div
              key={i}
              style={{
                backgroundColor: painted
                  ? `hsl(${painted.color * 60}, 70%, 50%)`
                  : "#f5f5f5",
                border: "1px solid #ddd",
                aspectRatio: "1",
              }}
            />
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          display: "flex",
          gap: 4,
        }}
      >
        <button
          onClick={() => session.toggleAuto()}
          className="sketch-btn sketch-btn--ghost"
          title={session.auto ? "Pause" : "Resume"}
        >
          {session.auto ? "⏸" : "▶"}
        </button>
        <button
          onClick={() => session.settleNow()}
          className="sketch-btn sketch-btn--ghost"
          title="Settle now"
        >
          💰
        </button>
      </div>
    </div>
  );
}
