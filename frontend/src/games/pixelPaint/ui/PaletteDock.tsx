import { useState } from "react";
import { PALETTE, colorHex } from "../palette";
import { DUEL, glass } from "./tokens";
import { CooldownRing } from "./CooldownRing";
import type { Cooldown } from "./cooldown";

/**
 * Bottom-center palette dock (NIANEZ clone): a collapsed current-color chip that
 * expands into an 8-column swatch grid, plus the cooldown ring. When no cooldown
 * is supplied (watch mode) the ring is hidden.
 */
export function PaletteDock({
  active,
  onPick,
  cooldown,
}: {
  active: number;
  onPick: (index: number) => void;
  cooldown?: Cooldown;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div
      className="absolute bottom-[18px] left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-[14px] px-3 py-2"
      style={glass}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg px-1.5 py-1"
      >
        <span
          className="h-[26px] w-[26px] rounded-md"
          style={{
            background: colorHex(active),
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.3)",
          }}
        />
        <span className="text-xs font-bold" style={{ color: DUEL.text }}>
          Color {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="grid grid-cols-8 gap-1.5">
          {PALETTE.map((hex, i) => {
            const idx = i + 1;
            const selected = idx === active;
            return (
              <button
                key={idx}
                title={hex}
                onClick={() => {
                  onPick(idx);
                  setOpen(false);
                }}
                className="h-[22px] w-[22px] rounded-[5px] transition-transform"
                style={{
                  background: hex,
                  transform: selected ? "scale(1.12)" : undefined,
                  boxShadow: selected
                    ? "0 0 0 2px #fff, 0 0 0 3px rgba(0,0,0,0.4)"
                    : "inset 0 0 0 1px rgba(255,255,255,0.15)",
                }}
              />
            );
          })}
        </div>
      )}

      {cooldown && (
        <>
          <div
            className="h-8 w-px"
            style={{ background: "rgba(255,255,255,0.12)" }}
          />
          <CooldownRing cooldown={cooldown} />
        </>
      )}
    </div>
  );
}
