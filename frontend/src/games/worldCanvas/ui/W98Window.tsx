/**
 * A floating, draggable Windows-98 tool window — the beveled-gray shell shared by
 * the Paint app's auxiliary palettes (Agent AI, Stamps) and the Players / Activity
 * and Leaderboard panels. A navy title bar is the drag handle (position persists
 * per `storageKey` in sessionStorage); an optional ✕ close box dismisses it. The
 * body is a raised face panel. Render-only chrome — nothing here touches the wire.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { W98, FONT_W98, w98Outset, w98Title, w98Button } from "./tokens";

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

export function W98Window({
  title,
  icon,
  onClose,
  storageKey,
  defaultAnchor,
  width,
  zIndex = 6,
  bodyStyle,
  children,
}: {
  title: string;
  /** Small glyph shown left of the title (e.g. an emoji), optional. */
  icon?: ReactNode;
  /** When given, a ✕ close box appears in the title bar. */
  onClose?: () => void;
  storageKey: string;
  defaultAnchor: CSSProperties;
  width: number;
  zIndex?: number;
  /** Extra style merged onto the padded body (e.g. max-height + scroll). */
  bodyStyle?: CSSProperties;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(() =>
    loadPos(storageKey),
  );
  const drag = useRef<{ prLeft: number; prTop: number; offX: number; offY: number } | null>(
    null,
  );

  useEffect(() => {
    if (!pos) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(pos));
    } catch {
      /* ignore */
    }
  }, [pos, storageKey]);

  const onPointerDown = (e: React.PointerEvent) => {
    // Pin wherever the window currently renders (default anchor or a saved spot),
    // then track the pointer relative to the positioned ancestor (the canvas area).
    const titleBar = e.currentTarget as HTMLElement;
    const win = titleBar.parentElement as HTMLElement | null;
    const parent = win?.offsetParent as HTMLElement | null;
    if (!win || !parent) return;
    const pr = parent.getBoundingClientRect();
    const br = win.getBoundingClientRect();
    setPos({ left: br.left - pr.left, top: br.top - pr.top });
    drag.current = {
      prLeft: pr.left,
      prTop: pr.top,
      offX: e.clientX - br.left,
      offY: e.clientY - br.top,
    };
    titleBar.setPointerCapture(e.pointerId);
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
        ...w98Outset,
        padding: 3,
        color: W98.text,
        fontFamily: FONT_W98,
        fontSize: 12,
        zIndex,
        ...anchor,
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          ...w98Title,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          height: 20,
          padding: "0 3px 0 5px",
          cursor: "grab",
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            fontWeight: 700,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {icon && <span style={{ fontSize: 12 }}>{icon}</span>}
          {title}
        </span>
        {onClose && (
          <button
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            title="Close"
            aria-label="Close"
            style={{
              ...w98Button(false),
              width: 16,
              height: 14,
              display: "grid",
              placeItems: "center",
              fontSize: 9,
              fontWeight: 900,
              lineHeight: 1,
              color: W98.text,
              cursor: "pointer",
              padding: 0,
            }}
          >
            ✕
          </button>
        )}
      </div>
      <div style={{ padding: "7px 8px 8px", ...bodyStyle }}>{children}</div>
    </div>
  );
}
