import { ConnectButton } from "@mysten/dapp-kit";
import { useCustomWallet } from "@/contexts/CustomWallet";

function short(a?: string) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

export function LoginScene({ onContinue, onPlayOnline }: { onContinue: () => void; onPlayOnline?: () => void }) {
  const { isConnected, address, login, logout } = useCustomWallet();

  return (
    <section className="relative w-full max-w-xl bg-surface-container-lowest border-[3px] border-primary rounded-[4px] p-6 md:p-12 shadow-[6px_6px_0px_#00336620] rotate-[-1deg] flex flex-col items-center gap-6 group">
      {/* Tape overlay top */}
      <div className="tape-top"></div>
      
      {/* Tape overlay bottom right */}
      <div className="tape-bottom-right hidden md:block"></div>

      {/* Game Wordmark Logo */}
      <div className="flex flex-col items-center justify-center select-none pointer-events-none mt-2 rotate-[-2deg] w-full text-center">
        <div className="relative font-headline-xl text-5xl md:text-6xl font-black text-primary tracking-tight leading-none uppercase flex items-center gap-1">
          <span className="relative inline-block">
            Tic
            <svg className="absolute -bottom-2 left-0 w-full h-2 text-secondary" viewBox="0 0 100 10" preserveAspectRatio="none">
              <path d="M5,5 Q50,9 95,3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-secondary font-body-lg text-4xl transform rotate-6 mx-1">-</span>
          <span className="relative inline-block">
            Tac
            <svg className="absolute -bottom-2 left-0 w-full h-2 text-primary/45" viewBox="0 0 100 10" preserveAspectRatio="none">
              <path d="M10,3 C40,7 70,2 90,6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-secondary font-body-lg text-4xl transform rotate-6 mx-1">-</span>
          <span className="text-secondary font-body-lg text-6xl italic transform -rotate-3 font-normal drop-shadow-sm select-none">
            Toe
          </span>
        </div>
        <div className="font-label-sm text-[10px] text-outline tracking-widest uppercase mt-4 border-t border-dashed border-primary/20 pt-2 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-xs">edit_note</span>
          Journal Edition
        </div>
      </div>



      {/* Connection Status / Form Actions */}
      <div className="flex flex-col items-center gap-4 w-full mt-2">
        {isConnected ? (
          <div className="flex flex-col gap-4 items-center w-full">
            <div className="flex items-center gap-2 text-surface-tint font-body-lg text-body-lg ink-bleed">
              <span className="material-symbols-outlined text-xl">check_circle</span>
              <span>Connected: <span className="font-label-sm text-sm border-b border-primary/20 pb-0.5">{short(address)}</span></span>
            </div>

            {/* Play vs Bot Button (Highlighter Style) */}
            <div className="relative group cursor-pointer w-full max-w-xs flex justify-center mt-2">
              <div className="absolute inset-y-[-4px] inset-x-2 bg-tertiary/20 highlight-bg -z-10 rounded-sm"></div>
              <button
                onClick={onContinue}
                className="relative flex items-center justify-center gap-2 w-full px-6 py-3 border-[3px] border-primary bg-surface font-headline-lg-mobile text-base text-primary uppercase tracking-widest hover:-translate-y-0.5 hover:translate-x-0.5 hover:shadow-[2px_2px_0px_#001e40] active:translate-y-0 active:translate-x-0 transition-all duration-150 rounded-sm"
              >
                <span className="material-symbols-outlined text-lg">smart_toy</span>
                Play vs Bot
              </button>
            </div>

            {onPlayOnline && (
              <button
                onClick={onPlayOnline}
                className="w-full max-w-xs py-3 px-5 border-[3px] border-secondary bg-surface text-secondary font-headline-lg-mobile text-base uppercase tracking-widest hover:bg-secondary hover:text-on-secondary active:translate-y-[2px] transition-all rounded-sm flex items-center justify-center gap-2 shadow-[3px_3px_0px_#001e40]"
              >
                <span className="material-symbols-outlined text-lg">group</span>
                Play Online (PvP)
              </button>
            )}

            <button 
              onClick={logout} 
              className="text-xs font-label-sm text-outline hover:text-secondary hover:underline transition-colors mt-2"
            >
              disconnect wallet
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 w-full max-w-xs">
            <div className="w-full flex justify-center [&_button]:w-full [&_button]:py-3 [&_button]:px-5 [&_button]:border-[3px] [&_button]:border-primary [&_button]:rounded-sm [&_button]:font-headline-lg-mobile [&_button]:text-primary [&_button]:bg-surface [&_button]:hover:bg-primary-container/10 [&_button]:transition-all [&_button]:text-base [&_button]:shadow-[3px_3px_0px_#001e40]">
              <ConnectButton connectText="Connect Wallet" />
            </div>

            <span className="font-body-md text-sm text-outline italic">or</span>

            <button
              onClick={login}
              className="w-full py-3 px-5 border-[3px] border-primary bg-surface text-primary font-headline-lg-mobile text-base hover:bg-primary-container/10 active:translate-y-[2px] transition-all rounded-sm flex items-center justify-center gap-2 shadow-[3px_3px_0px_#001e40]"
            >
              <span className="material-symbols-outlined text-lg">login</span>
              Login with Google
            </button>
          </div>
        )}
      </div>


    </section>
  );
}
