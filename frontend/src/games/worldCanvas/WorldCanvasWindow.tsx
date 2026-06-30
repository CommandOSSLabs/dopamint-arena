import { ConnectModal, useCurrentAccount } from "@mysten/dapp-kit";
import { isEnokiWallet } from "@mysten/enoki";
import type { GameWindowProps } from "../types";
import { SketchDefs } from "../sketch";
import { PvpCanvasView } from "./ui/PvpCanvasView";
import "./ui/worldCanvas.sketch.css";

/**
 * "The World is Your Canvas" — matchmake with another human and co-draw ONE shared
 * canvas over a genuine 2-party tunnel (each human owns a seat; half-signatures are
 * exchanged over the relay). Each painted cell is one co-signed move.
 *
 * Every paint co-signs a real on-chain tunnel, so a wallet is required to play
 * (gas is sponsored — free to paint); until one is connected the window shows the
 * connect gate. Sketch-chrome lives under ONE persistent `.wc-sketch.sketch` root so
 * the hand-drawn skin (ink-stroke borders + Gochi Hand text) and the single
 * {@link SketchDefs} roughen filter cascade to every overlay. The drawing canvas
 * itself stays a plain white surface. A remount mid-match resumes straight to the
 * live board.
 */
export function WorldCanvasWindow({ windowId }: GameWindowProps) {
  const account = useCurrentAccount();
  return (
    <div
      className="wc-sketch sketch"
      style={{ height: "100%", width: "100%", position: "relative" }}
    >
      <SketchDefs />
      {account ? <PvpCanvasView windowId={windowId} /> : <WalletGate />}
    </div>
  );
}

/**
 * Wallet gate — shown until a wallet is connected, mirroring the arena's other games
 * (Battleship/Quantum Poker). Painting co-signs a real tunnel that settles on-chain;
 * gas is sponsored, so it's free. One Enoki connect (wallets + Google zkLogin) via
 * {@link ConnectModal}. Sketch-styled to match the lobby card.
 */
function WalletGate() {
  return (
    <div className="sketch-welcome">
      <div className="sketch-welcome__card sketch-panel sketch-stroke">
        <div className="sketch-welcome__head">
          <span className="sketch-eyebrow">Wallet required</span>
          <span className="sketch-title">Connect to paint</span>
        </div>
        <p
          className="sketch-note"
          style={{ maxWidth: 320, margin: "2px 0 10px" }}
        >
          Every painted cell is one co-signed move on a real tunnel that settles
          on-chain — gas is sponsored, so painting is free.
        </p>
        <div className="sketch-welcome__actions">
          <ConnectModal
            walletFilter={isEnokiWallet}
            trigger={
              <button type="button" className="sketch-btn sketch-btn--go">
                👛 Connect wallet
              </button>
            }
          />
        </div>
      </div>
    </div>
  );
}
