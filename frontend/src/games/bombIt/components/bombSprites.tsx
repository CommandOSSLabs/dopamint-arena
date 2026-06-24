import type { CSSProperties } from "react";

export type BombGlyphKind = "player-a" | "player-b" | "bomb" | "crate" | "wall";

const SCENE_FLOATS: Array<{
  kind: BombGlyphKind;
  left: string;
  top: string;
  scale: number;
  rotate: number;
  drift: "a" | "b" | "c";
  opacity?: number;
}> = [
  { kind: "crate", left: "8%", top: "10%", scale: 1.15, rotate: -14, drift: "a", opacity: 0.55 },
  { kind: "bomb", left: "72%", top: "6%", scale: 1.05, rotate: 10, drift: "b" },
  { kind: "player-a", left: "18%", top: "34%", scale: 0.95, rotate: -6, drift: "c", opacity: 0.7 },
  { kind: "wall", left: "52%", top: "22%", scale: 0.9, rotate: 0, drift: "a", opacity: 0.45 },
  { kind: "crate", left: "62%", top: "48%", scale: 1, rotate: 12, drift: "c", opacity: 0.5 },
];

/** Square arena glyphs reused in lobby scene and mode tiles. */
export function BombGlyph({
  kind,
  size = "md",
  pulse,
}: {
  kind: BombGlyphKind;
  size?: "sm" | "md" | "lg";
  pulse?: boolean;
}) {
  return (
    <span
      className={[
        "bomb-glyph",
        `bomb-glyph--${kind}`,
        `bomb-glyph--${size}`,
        pulse ? "bomb-glyph--pulse" : "",
      ].join(" ")}
      aria-hidden
    >
      {kind === "player-a" || kind === "player-b" ? <span className="bomb-glyph__inner" /> : null}
      {kind === "bomb" ? (
        <>
          <span className="bomb-glyph__core" />
          <span className="bomb-glyph__fuse" />
        </>
      ) : null}
      {kind === "crate" ? <span className="bomb-glyph__crate-lines" /> : null}
    </span>
  );
}

/** Ambient floating assets behind the lobby dock. */
export function BombLobbyScene() {
  return (
    <div className="bomb-lobby__scene" aria-hidden>
      <div className="bomb-lobby__arena-hint" />
      {SCENE_FLOATS.map((item, i) => (
        <span
          key={`${item.kind}-${i}`}
          className={`bomb-lobby__float bomb-lobby__float--${item.drift}`}
          style={
            {
              left: item.left,
              top: item.top,
              "--bi-float-scale": item.scale,
              "--bi-float-rot": `${item.rotate}deg`,
              opacity: item.opacity ?? 0.6,
            } as CSSProperties
          }
        >
          <BombGlyph kind={item.kind} size="md" pulse={item.kind === "bomb"} />
        </span>
      ))}
    </div>
  );
}
