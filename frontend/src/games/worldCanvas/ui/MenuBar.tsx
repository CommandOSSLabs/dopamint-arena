/**
 * The Paint app's classic Windows menu bar (File / Edit / View / Colors / Agent /
 * Help). Data-driven: each menu is a list of items — actions, check/radio toggles,
 * section headers, and separators — so wiring a new command is one array entry. A
 * click opens a menu; hovering the bar while one is open switches between them; a
 * click on an item runs it and closes; an outside click closes. Render-only chrome.
 */
import { useState, type ReactNode } from "react";
import {
  W98,
  FONT_W98,
  w98Outset,
} from "./tokens";

export type W98MenuItem =
  | { kind: "action"; label: string; onClick: () => void; disabled?: boolean; accel?: string }
  | { kind: "check"; label: string; checked: boolean; onClick: () => void }
  | { kind: "radio"; label: string; checked: boolean; onClick: () => void }
  | { kind: "header"; label: string }
  | { kind: "sep" };

export interface W98Menu {
  label: string;
  items: W98MenuItem[];
}

export function MenuBar({ menus }: { menus: W98Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "stretch",
        height: 21,
        background: W98.face,
        fontFamily: FONT_W98,
        fontSize: 12,
        color: W98.text,
        zIndex: 30,
        userSelect: "none",
        flex: "0 0 auto",
      }}
    >
      {open !== null && (
        // Outside-click catcher: closes the menu without stealing the first click
        // target's own handler from firing afterward.
        <div
          onPointerDown={() => setOpen(null)}
          style={{ position: "fixed", inset: 0, zIndex: 25 }}
        />
      )}
      {menus.map((menu, i) => {
        const isOpen = open === i;
        return (
          <div key={menu.label} style={{ position: "relative", zIndex: 31 }}>
            <button
              onClick={() => setOpen(isOpen ? null : i)}
              onPointerEnter={() => open !== null && setOpen(i)}
              style={{
                height: "100%",
                padding: "0 9px",
                border: "none",
                cursor: "pointer",
                fontFamily: FONT_W98,
                fontSize: 12,
                color: W98.text,
                background: isOpen ? W98.menuHover : "transparent",
                ...(isOpen ? { color: W98.menuHoverText } : null),
              }}
            >
              {menu.label}
            </button>
            {isOpen && (
              <MenuDropdown items={menu.items} onClose={() => setOpen(null)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function MenuDropdown({
  items,
  onClose,
}: {
  items: W98MenuItem[];
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        minWidth: 184,
        maxHeight: 420,
        overflowY: "auto",
        ...w98Outset,
        padding: 2,
        zIndex: 40,
        boxShadow:
          `inset -1px -1px 0 ${W98.darkShadow}, inset 1px 1px 0 ${W98.hilight}, ` +
          `inset -2px -2px 0 ${W98.shadow}, inset 2px 2px 0 ${W98.faceLight}, ` +
          "3px 3px 6px rgba(0,0,0,0.4)",
      }}
    >
      {items.map((item, i) => (
        <MenuRow key={i} item={item} onClose={onClose} />
      ))}
    </div>
  );
}

function MenuRow({
  item,
  onClose,
}: {
  item: W98MenuItem;
  onClose: () => void;
}) {
  const [hover, setHover] = useState(false);

  if (item.kind === "sep") {
    return (
      <div
        style={{
          height: 0,
          margin: "3px 2px",
          borderTop: `1px solid ${W98.shadow}`,
          borderBottom: `1px solid ${W98.hilight}`,
        }}
      />
    );
  }
  if (item.kind === "header") {
    return (
      <div
        style={{
          padding: "5px 8px 2px 24px",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: W98.textDim,
        }}
      >
        {item.label}
      </div>
    );
  }

  const disabled = item.kind === "action" && item.disabled;
  const mark =
    item.kind === "check" ? (item.checked ? "✓" : "") :
    item.kind === "radio" ? (item.checked ? "●" : "") : "";

  const run = () => {
    if (disabled) return;
    item.onClick();
    onClose();
  };

  return (
    <button
      onClick={run}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        width: "100%",
        padding: "3px 10px 3px 0",
        border: "none",
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
        fontFamily: FONT_W98,
        fontSize: 12,
        background: hover && !disabled ? W98.menuHover : "transparent",
        color: disabled
          ? W98.disabled
          : hover
            ? W98.menuHoverText
            : W98.text,
      }}
    >
      <span
        style={{
          width: 24,
          textAlign: "center",
          fontSize: 11,
          flex: "0 0 auto",
        }}
      >
        {mark}
      </span>
      <span style={{ flex: 1, whiteSpace: "nowrap" }}>{item.label}</span>
      {item.kind === "action" && item.accel && (
        <span
          style={{
            marginLeft: 16,
            fontSize: 11,
            color: hover && !disabled ? W98.menuHoverText : W98.textDim,
          }}
        >
          {item.accel}
        </span>
      )}
    </button>
  );
}

/** A 1px-underlined accelerator-style label (purely decorative flair). */
export function Underlined({ children }: { children: ReactNode }) {
  return <span style={{ textDecoration: "underline" }}>{children}</span>;
}
