import { useCustomWallet } from "@/games/ticTacToe/app/contexts/CustomWallet";
import { ConnectButton } from "@mysten/dapp-kit";

function short(a?: string) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

export function LoginScene({
  onContinue,
  onPlayOnline,
}: {
  onContinue: () => void;
  onPlayOnline?: () => void;
}) {
  const { isConnected, address, login, logout } = useCustomWallet();

  return (
    <section className="qp-panel qp-stroke @container w-[95%] max-w-2xl p-6 md:p-10 flex flex-col items-center gap-6 text-center mx-auto">
      <div className="flex flex-col items-center justify-center select-none pointer-events-none mt-2 w-full text-center">
        <span className="qp-eyebrow mt-4 !text-lg md:!text-2xl">
          Tic Tac Toe · Caro
        </span>
        <h2
          className="qp-title mb-6 mt-4 flex flex-wrap items-center justify-center gap-2 md:gap-4 leading-none"
          style={{ fontSize: "clamp(3.5rem, 12cqw, 7rem)" }}
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: "clamp(3rem, 10cqw, 6rem)" }}
          >
            grid_3x3
          </span>
          Tic Tac Toe
        </h2>
      </div>

      {/* Connection Status / Form Actions */}
      <div className="flex flex-col items-center gap-4 w-full mt-2">
        {isConnected ? (
          <div className="flex flex-col gap-4 items-center w-full">
            <button
              onClick={onContinue}
              className="qp-btn qp-btn--go w-[90%] max-w-lg mx-auto flex items-center justify-center gap-4 !px-8 !py-6 md:!py-8 uppercase tracking-widest font-black"
            >
              <span className="material-symbols-outlined text-4xl md:text-5xl">
                smart_toy
              </span>
              <span className="text-2xl md:text-3xl">Play vs Bot</span>
            </button>

            {onPlayOnline && (
              <button
                onClick={onPlayOnline}
                className="qp-btn w-[90%] max-w-lg mx-auto flex items-center justify-center gap-4 !px-8 !py-6 md:!py-8 uppercase tracking-widest font-black mt-2"
              >
                <span className="material-symbols-outlined text-4xl md:text-5xl">
                  sports_esports
                </span>
                <span className="text-2xl md:text-3xl">Play Online</span>
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 w-full max-w-sm mt-4">
            <div className="w-full flex justify-center [&_button]:w-full [&_button]:py-4 [&_button]:px-6 [&_button]:border-[3px] [&_button]:border-[var(--qp-ink)] [&_button]:rounded-md [&_button]:font-bold [&_button]:text-[var(--qp-ink)] [&_button]:bg-[#fffdf6] [&_button]:hover:bg-[#f2f0e6] [&_button]:transition-colors [&_button]:text-xl">
              <ConnectButton connectText="Connect Wallet" />
            </div>

            <span className="text-lg md:text-xl font-bold text-[var(--qp-ink-soft)] italic uppercase">
              or
            </span>

            <button
              onClick={login}
              className="qp-btn !px-6 !py-4 !text-xl w-full uppercase"
            >
              Login with Google
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
