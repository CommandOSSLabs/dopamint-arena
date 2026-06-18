import { useState } from "react";
import "../bomb-it.css";

function randomCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function BombLobby({
  onCreate,
  onJoin,
}: {
  onCreate: (code: string) => void;
  onJoin: (code: string) => void;
}) {
  const [input, setInput] = useState("");
  const [activeCode, setActiveCode] = useState<string | null>(null);

  const handleCreate = () => {
    const code = input.trim().toUpperCase() || randomCode();
    setActiveCode(code);
    setInput(code);
    onCreate(code);
  };

  const handleJoin = () => {
    const code = input.trim().toUpperCase();
    if (!code) return;
    onJoin(code);
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-arena-bg p-4 text-center">
      <h2 className="text-gold text-lg font-extrabold uppercase tracking-widest">Bomb It PvP</h2>
      <p className="max-w-xs text-sm text-arena-muted">
        Create a match, share the code; opponent joins with it (2nd tab works).
      </p>

      {activeCode && (
        <div className="flex flex-col items-center gap-1 rounded border border-amber-500 bg-arena-accent/10 px-6 py-3">
          <span className="text-[11px] uppercase tracking-wider text-arena-muted">Your match code</span>
          <span className="font-mono text-2xl font-extrabold tracking-[0.25em] text-gold">{activeCode}</span>
          <span className="text-[11px] text-arena-muted">Share this with your opponent</span>
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-arena-muted">Match Code</span>
        <input
          type="text"
          maxLength={8}
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          placeholder="e.g. AB12"
          className="w-40 rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-center font-mono uppercase text-arena-text placeholder:text-arena-muted/50"
        />
      </label>

      <div className="flex gap-3">
        <button
          onClick={handleCreate}
          className="gold-glow-hover rounded border border-amber-500 bg-arena-accent px-5 py-2 font-bold uppercase tracking-widest text-arena-bg transition-all hover:opacity-90"
        >
          Create Match
        </button>
        <button
          onClick={handleJoin}
          disabled={!input.trim()}
          className="rounded border border-arena-edge px-5 py-2 font-bold uppercase tracking-widest text-arena-text transition-all hover:opacity-90 disabled:opacity-40"
        >
          Join Match
        </button>
      </div>
    </div>
  );
}
