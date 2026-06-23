/**
 * Floating, draggable HUD panels for the world wall, styled after the wplace /
 * nianez glass cards: a combined PLAYERS + RECENT ACTIVITY panel and a 🏆
 * LEADERBOARD. Both read the hook's live per-painter tallies and activity ring
 * (stable-identity containers; the parent re-renders them on each paint), so they
 * update as the wall fills. Panels remember where you drag them (sessionStorage).
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { PainterInfo, ActivityEntry } from "../useWorldCanvasOnchain";
import {
  WC,
  glass,
  FONT_DISPLAY,
  FONT_MONO,
  PALETTE,
  shortAddress,
} from "./tokens";

/** Sort painters for ranking: most cells first, ties broken by who painted last. */
function rankPainters(painters: ReadonlyMap<string, PainterInfo>): PainterInfo[] {
  return [...painters.values()].sort(
    (a, b) => b.cells - a.cells || b.lastSeq - a.lastSeq,
  );
}

/** Compact relative time for the activity feed. */
function timeAgo(t: number): string {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 1) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** Global-pixel coordinate of a paint (chunk index × chunk size + in-chunk). */
function globalCoord(e: ActivityEntry): string {
  const gx = Number(e.cx) * 256 + e.x;
  const gy = Number(e.cy) * 256 + e.y;
  return `${gx}, ${gy}`;
}

function loadPos(key: string): { left: number; top: number } | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as { left?: unknown; top?: unknown };
    if (typeof p.left === "number" && typeof p.top === "number") {
      return { left: p.left, top: p.top };
    }
  } catch {
    /* ignore */
  }
  return null;
}

const HEADER_LABEL: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: WC.muted,
  fontFamily: FONT_MONO,
};

function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: WC.muted,
        fontFamily: FONT_MONO,
        padding: "8px 2px",
        opacity: 0.8,
      }}
    >
      {children}
    </div>
  );
}

/** Glass card with a drag handle (the header). Position persists per `storageKey`. */
function DraggablePanel({
  header,
  storageKey,
  defaultAnchor,
  width,
  children,
}: {
  header: ReactNode;
  storageKey: string;
  defaultAnchor: CSSProperties;
  width: number;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(() =>
    loadPos(storageKey),
  );
  const drag = useRef<{
    prLeft: number;
    prTop: number;
    offX: number;
    offY: number;
  } | null>(null);

  useEffect(() => {
    if (!pos) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(pos));
    } catch {
      /* ignore */
    }
  }, [pos, storageKey]);

  const onPointerDown = (e: React.PointerEvent) => {
    const panel = e.currentTarget.parentElement as HTMLElement | null;
    const parent = panel?.offsetParent as HTMLElement | null;
    if (!panel || !parent) return;
    const pr = parent.getBoundingClientRect();
    const br = panel.getBoundingClientRect();
    // Pin wherever the panel renders now (default anchor or a saved spot).
    setPos({ left: br.left - pr.left, top: br.top - pr.top });
    drag.current = {
      prLeft: pr.left,
      prTop: pr.top,
      offX: e.clientX - br.left,
      offY: e.clientY - br.top,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPos({
      left: Math.max(4, e.clientX - d.prLeft - d.offX),
      top: Math.max(4, e.clientY - d.prTop - d.offY),
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const anchor: CSSProperties = pos
    ? { left: pos.left, top: pos.top }
    : defaultAnchor;

  return (
    <div
      style={{
        position: "absolute",
        width,
        ...glass,
        borderRadius: 14,
        color: WC.text,
        fontFamily: FONT_DISPLAY,
        overflow: "hidden",
        zIndex: 6,
        ...anchor,
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          cursor: "grab",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 11px",
          borderBottom: `1px solid ${WC.panelBorder}`,
          userSelect: "none",
          touchAction: "none",
        }}
      >
        {header}
      </div>
      <div style={{ padding: "9px 11px 11px" }}>{children}</div>
    </div>
  );
}

/** PLAYERS roster + RECENT ACTIVITY feed (newest first), draggable. */
export function PlayersActivityPanel({
  painters,
  activity,
  humanAddress,
  revision,
}: {
  painters: ReadonlyMap<string, PainterInfo>;
  activity: ReadonlyArray<ActivityEntry>;
  humanAddress: string;
  revision: number;
}) {
  void revision; // re-read live containers on every parent re-render
  const players = rankPainters(painters);
  const recent = [...activity].slice(-14).reverse();

  return (
    <DraggablePanel
      header={<span style={HEADER_LABEL}>Players</span>}
      storageKey="wc.playersPanel"
      defaultAnchor={{ right: 16, top: 150 }}
      width={252}
    >
      {players.length === 0 ? (
        <Empty>No players yet</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {players.map((p, i) => (
            <div
              key={p.address}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <span
                style={{
                  width: 16,
                  fontSize: 11,
                  fontWeight: 700,
                  color: WC.muted,
                  fontFamily: FONT_MONO,
                  textAlign: "right",
                }}
              >
                {i + 1}
              </span>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: p.tint,
                  boxShadow: `0 0 6px ${p.tint}`,
                  flex: "0 0 auto",
                }}
              />
              <span
                style={{
                  flex: 1,
                  fontSize: 12,
                  fontWeight: p.isAgent ? 600 : 700,
                  color: p.isAgent ? WC.text : WC.accent,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {p.isAgent ? `${p.label} · ${shortAddress(p.address)}` : p.label}
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: WC.text,
                  fontFamily: FONT_MONO,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {p.cells.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          height: 1,
          background: WC.panelBorder,
          margin: "11px 0 9px",
          opacity: 0.6,
        }}
      />
      <span style={HEADER_LABEL}>Recent activity</span>

      {recent.length === 0 ? (
        <Empty>No paints yet</Empty>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            marginTop: 7,
            maxHeight: 168,
            overflowY: "auto",
          }}
        >
          {recent.map((e) => {
            const isYou = e.painter === humanAddress;
            return (
              <div
                key={e.seq}
                style={{ display: "flex", alignItems: "center", gap: 7 }}
              >
                <span
                  style={{
                    width: 11,
                    height: 11,
                    borderRadius: 3,
                    background: PALETTE[e.color] ?? "#fff",
                    border: "1px solid rgba(0,0,0,0.4)",
                    flex: "0 0 auto",
                  }}
                />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: isYou ? WC.accent : WC.text,
                    flex: "0 0 auto",
                  }}
                >
                  {isYou ? "You" : e.label}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontSize: 10.5,
                    color: WC.muted,
                    fontFamily: FONT_MONO,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  ({globalCoord(e)})
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: WC.muted,
                    fontFamily: FONT_MONO,
                    flex: "0 0 auto",
                  }}
                >
                  {timeAgo(e.t)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </DraggablePanel>
  );
}

/** 🏆 LEADERBOARD ranked by cells painted, with a proportional ■ bar, draggable. */
export function LeaderboardPanel({
  painters,
  revision,
}: {
  painters: ReadonlyMap<string, PainterInfo>;
  revision: number;
}) {
  void revision; // re-read live containers on every parent re-render
  const players = rankPainters(painters);
  const total = players.reduce((n, p) => n + p.cells, 0);
  const max = players.length ? Math.max(1, players[0].cells) : 1;

  return (
    <DraggablePanel
      header={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: "0.04em",
              color: WC.text,
            }}
          >
            🏆 Leaderboard
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: WC.ok,
              fontFamily: FONT_MONO,
            }}
          >
            {total.toLocaleString()} ■
          </span>
        </div>
      }
      storageKey="wc.leaderboardPanel"
      defaultAnchor={{ right: 16, bottom: 16 }}
      width={262}
    >
      {players.length === 0 ? (
        <Empty>No paints yet</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {players.map((p, i) => (
            <div
              key={p.address}
              style={{ display: "flex", alignItems: "center", gap: 9 }}
            >
              <span
                style={{
                  width: 18,
                  fontSize: 14,
                  fontWeight: 800,
                  color: i === 0 ? WC.warn : WC.muted,
                  textAlign: "center",
                  fontFamily: FONT_MONO,
                }}
              >
                {i + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: p.isAgent ? 600 : 700,
                      color: p.isAgent ? WC.text : WC.accent,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {p.isAgent
                      ? `${p.label} · ${shortAddress(p.address)}`
                      : p.label}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 800,
                      color: p.tint,
                      fontFamily: FONT_MONO,
                      flex: "0 0 auto",
                    }}
                  >
                    {p.cells.toLocaleString()} ■
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 4,
                    height: 5,
                    borderRadius: 3,
                    background: "rgba(255,255,255,0.08)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round((p.cells / max) * 100)}%`,
                      height: "100%",
                      background: p.tint,
                      borderRadius: 3,
                      transition: "width .25s ease",
                    }}
                  />
                </div>
                <div
                  style={{
                    marginTop: 3,
                    fontSize: 10,
                    color: WC.muted,
                    fontFamily: FONT_MONO,
                  }}
                >
                  {p.cells.toLocaleString()} / {total.toLocaleString()} cells
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </DraggablePanel>
  );
}
