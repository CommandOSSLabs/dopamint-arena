import type { GameModule } from "../games/types";

export function Catalog({
  games,
  onLaunch,
  onClose,
}: {
  games: GameModule[];
  onLaunch: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-arena-bg/70 backdrop-blur-sm">
      <div className="w-[520px] rounded-lg border border-arena-edge bg-arena-panel p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Game Catalog</h2>
          <button
            onClick={onClose}
            aria-label="Close catalog"
            className="text-arena-muted hover:text-arena-text"
          >
            ✕
          </button>
        </div>
        {games.length === 0 ? (
          <p className="text-sm text-arena-muted">No games registered yet.</p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {games.map((g) => (
              <button
                key={g.id}
                onClick={() => onLaunch(g.id)}
                className="flex flex-col items-center gap-2 rounded-md border border-arena-edge bg-arena-bg p-4 hover:border-arena-accent"
              >
                <span className="text-3xl">{g.icon}</span>
                <span className="text-xs text-arena-text">{g.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
