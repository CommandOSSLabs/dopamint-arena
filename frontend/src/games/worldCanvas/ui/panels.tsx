/**
 * Floating, draggable Win-98 tool windows for the Paint app: a combined PLAYERS +
 * RECENT ACTIVITY window and a 🏆 LEADERBOARD. Both read the hook's live per-painter
 * tallies and activity ring (stable-identity containers; the parent re-renders them
 * on each paint), so they update as the wall fills. Position persists per window
 * (sessionStorage, via {@link W98Window}); each can be closed from its title bar.
 */
import type {
  PainterInfo,
  ActivityEntry,
  AgentMarker,
} from "../useWorldCanvasOnchain";
import { W98, FONT_MONO, PALETTE, shortAddress } from "./tokens";
import { W98Window } from "./W98Window";

/** A readable foreground blue for the human's own rows on the gray chrome. */
const HUMAN_BLUE = "#0a3a9a";

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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: W98.textDim,
      }}
    >
      {children}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: W98.textDim, padding: "6px 2px" }}>
      {children}
    </div>
  );
}

/** PLAYERS roster + RECENT ACTIVITY feed (newest first). Each LIVE agent row gets a
 *  📍 button that re-centers the camera on where that bot is painting. */
export function PlayersActivityPanel({
  painters,
  activity,
  humanAddress,
  agents,
  onFocusAgent,
  onClose,
  revision,
}: {
  painters: ReadonlyMap<string, PainterInfo>;
  activity: ReadonlyArray<ActivityEntry>;
  humanAddress: string;
  agents: ReadonlyArray<AgentMarker>;
  onFocusAgent: (painter: string) => void;
  onClose: () => void;
  revision: number;
}) {
  void revision; // re-read live containers on every parent re-render
  const players = rankPainters(painters);
  const recent = [...activity].slice(-14).reverse();
  const liveAgents = new Set(agents.map((a) => a.painter));

  return (
    <W98Window
      title="Players"
      icon="👥"
      onClose={onClose}
      storageKey="wc.playersPanel"
      defaultAnchor={{ right: 12, top: 300 }}
      width={244}
    >
      <SectionLabel>Players</SectionLabel>
      {players.length === 0 ? (
        <Empty>No players yet</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 5 }}>
          {players.map((p, i) => (
            <div key={p.address} style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span
                style={{
                  width: 14,
                  fontSize: 11,
                  fontWeight: 700,
                  color: W98.textDim,
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
                  flex: "0 0 auto",
                  boxShadow: `0 0 0 1px ${W98.darkShadow}`,
                }}
              />
              <span
                style={{
                  flex: 1,
                  fontSize: 12,
                  fontWeight: p.isAgent ? 400 : 700,
                  color: p.isAgent ? W98.text : HUMAN_BLUE,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {p.isAgent ? `${p.label} · ${shortAddress(p.address)}` : p.label}
              </span>
              {liveAgents.has(p.address) && (
                <button
                  onClick={() => onFocusAgent(p.address)}
                  title="Recenter the camera on this agent"
                  style={{
                    flex: "0 0 auto",
                    width: 19,
                    height: 16,
                    display: "grid",
                    placeItems: "center",
                    fontSize: 10,
                    cursor: "pointer",
                    background: W98.face,
                    boxShadow: `inset -1px -1px 0 ${W98.darkShadow}, inset 1px 1px 0 ${W98.hilight}`,
                  }}
                >
                  📍
                </button>
              )}
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: W98.text,
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
          height: 0,
          margin: "10px 0 7px",
          borderTop: `1px solid ${W98.shadow}`,
          borderBottom: `1px solid ${W98.hilight}`,
        }}
      />
      <SectionLabel>Recent activity</SectionLabel>

      {recent.length === 0 ? (
        <Empty>No paints yet</Empty>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 3,
            marginTop: 6,
            maxHeight: 168,
            overflowY: "auto",
          }}
        >
          {recent.map((e) => {
            const isYou = e.painter === humanAddress;
            return (
              <div key={e.seq} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    width: 11,
                    height: 11,
                    background: PALETTE[e.color] ?? "#fff",
                    boxShadow: `0 0 0 1px ${W98.darkShadow}`,
                    flex: "0 0 auto",
                  }}
                />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: isYou ? HUMAN_BLUE : W98.text,
                    flex: "0 0 auto",
                  }}
                >
                  {isYou ? "You" : e.label}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontSize: 10.5,
                    color: W98.textDim,
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
                    color: W98.textDim,
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
    </W98Window>
  );
}

/** 🏆 LEADERBOARD ranked by cells painted, with a proportional bar. */
export function LeaderboardPanel({
  painters,
  onClose,
  revision,
}: {
  painters: ReadonlyMap<string, PainterInfo>;
  onClose: () => void;
  revision: number;
}) {
  void revision; // re-read live containers on every parent re-render
  const players = rankPainters(painters);
  const total = players.reduce((n, p) => n + p.cells, 0);
  const max = players.length ? Math.max(1, players[0].cells) : 1;

  return (
    <W98Window
      title={`Leaderboard — ${total.toLocaleString()} cells`}
      icon="🏆"
      onClose={onClose}
      storageKey="wc.leaderboardPanel"
      defaultAnchor={{ right: 12, bottom: 12 }}
      width={252}
    >
      {players.length === 0 ? (
        <Empty>No paints yet</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {players.map((p, i) => (
            <div key={p.address} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 16,
                  fontSize: 13,
                  fontWeight: 800,
                  color: i === 0 ? "#b8860b" : W98.textDim,
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
                      fontWeight: p.isAgent ? 400 : 700,
                      color: p.isAgent ? W98.text : HUMAN_BLUE,
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
                      fontWeight: 800,
                      color: W98.text,
                      fontFamily: FONT_MONO,
                      flex: "0 0 auto",
                    }}
                  >
                    {p.cells.toLocaleString()}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 3,
                    height: 8,
                    background: W98.field,
                    boxShadow: `inset 1px 1px 0 ${W98.shadow}, inset -1px -1px 0 ${W98.hilight}`,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round((p.cells / max) * 100)}%`,
                      height: "100%",
                      background: p.tint,
                      transition: "width .25s ease",
                    }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </W98Window>
  );
}
