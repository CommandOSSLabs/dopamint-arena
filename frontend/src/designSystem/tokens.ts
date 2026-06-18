/** A color/gradient swatch rendered on the design-system page. */
export interface WalSwatch {
  /** Token name as shown under the swatch. */
  name: string;
  /** CSS value painted as the swatch background — a hex or a `var(--token)`. */
  value: string;
  /** Short note on where the token is used. */
  note: string;
}

/** Core neutrals — the ink/cream canvas and surfaces. */
export const WAL_NEUTRALS: WalSwatch[] = [
  { name: "ink", value: "#0C0F1D", note: "dark app canvas" },
  { name: "surface-card", value: "#0F1118", note: "card on dark" },
  { name: "surface-raised", value: "#16181F", note: "raised / hover" },
  { name: "cream", value: "#FAF8F5", note: "light canvas" },
  { name: "gray-400", value: "#8F9294", note: "secondary text" },
  { name: "gray-600", value: "#54575A", note: "muted / placeholder" },
];

/** Brand accents. Values flip with the active theme, so they read in both. */
export const WAL_ACCENTS: WalSwatch[] = [
  { name: "lilac", value: "var(--wal-lilac)", note: "soft brand / labels" },
  { name: "violet", value: "var(--wal-violet)", note: "primary action" },
  { name: "pink", value: "var(--wal-pink)", note: "aurora pink" },
  { name: "blue", value: "var(--wal-blue)", note: "aurora blue / info" },
  { name: "mint", value: "var(--wal-mint)", note: "success" },
  { name: "lime", value: "var(--wal-lime)", note: "signal / live" },
];

/** Signature gradients. */
export const WAL_GRADIENTS: WalSwatch[] = [
  {
    name: "memory",
    value: "var(--wal-grad-memory)",
    note: "violet → blue → pink",
  },
  { name: "aurora", value: "var(--wal-grad-aurora)", note: "full ribbon" },
];

/** shadcn semantic tokens, mapped onto the Walrus palette in styles/index.css. */
export const WAL_SEMANTIC: WalSwatch[] = [
  { name: "background", value: "var(--background)", note: "page canvas" },
  { name: "card", value: "var(--card)", note: "card surface" },
  { name: "primary", value: "var(--primary)", note: "primary action" },
  { name: "secondary", value: "var(--secondary)", note: "secondary surface" },
  { name: "muted", value: "var(--muted)", note: "muted surface" },
  { name: "destructive", value: "var(--destructive)", note: "errors / debits" },
  { name: "border", value: "var(--border)", note: "hairlines" },
  { name: "ring", value: "var(--ring)", note: "focus ring" },
];
