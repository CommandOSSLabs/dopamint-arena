import { useGameNavigate } from "@/games/blackjack/app/useGameRouter";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { useEffect } from "react";
import { SketchDefs } from "../App";

export default function Home() {
  const navigate = useGameNavigate();
  const account = useCurrentAccount();

  useEffect(() => {
    document.title = "Blackjack";
  }, []);

  return (
    <div className="w-full h-full flex flex-col items-center justify-center p-4 relative select-none">
      <SketchDefs />

      <div className="@container qp-panel qp-stroke w-[95%] max-w-2xl p-6 md:p-10 flex flex-col items-center gap-6 fade-in-up text-center mx-auto">
        <div className="flex flex-col items-center justify-center select-none pointer-events-none mt-2 w-full text-center">
          <span className="qp-eyebrow mt-4 !text-lg md:!text-2xl">
            MillionTPS
          </span>
          <h1
            className="qp-title uppercase text-center mb-6 mt-4 flex flex-wrap items-center justify-center gap-2 md:gap-4 leading-none"
            style={{ fontSize: "clamp(3.5rem, 12cqw, 7rem)" }}
          >
            <img
              src="/blackjack-logo-gold.svg"
              alt="Blackjack Icon"
              className="drop-shadow-md"
              style={{ width: "clamp(4rem, 14cqw, 8rem)", height: "auto" }}
            />
            Blackjack
          </h1>
        </div>

        {/* Play buttons / Connect warning */}
        <div className="w-full space-y-4">
          <div className="flex flex-col gap-5">
            <button
              onClick={() => navigate("/bot")}
              disabled={!account}
              data-testid="bj-play-bot"
              className="qp-btn qp-btn--go w-full text-center !py-6 font-black !text-2xl md:!text-3xl uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Play vs Bot
            </button>
            <button
              onClick={() => navigate("/pvp")}
              disabled={!account}
              className="qp-btn w-full text-center !py-6 font-black !text-2xl md:!text-3xl uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Play vs Player
            </button>
          </div>

          {!account && (
            <p className="text-center text-xl md:text-2xl text-[var(--qp-red)] font-bold pt-3 uppercase tracking-widest">
              Please connect your Sui wallet in the top bar to play.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
