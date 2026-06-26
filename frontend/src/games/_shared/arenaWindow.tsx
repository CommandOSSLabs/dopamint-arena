import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { useSoloCabinet, type WindowMode } from "@/shell/cabinet/soloCabinet";
import { useSoloAutoRetry } from "@/lib/useSoloAutoRetry";
import type { GameWindowProps } from "../types";
import type { SessionStatus } from "./soloSessionHook";
import { ArenaScreen, type ArenaScreenTheme } from "./ArenaScreen";

/** The solo-session surface the window controller reads (the board reads the rest). */
interface ArenaSolo {
  status: SessionStatus;
  auto: boolean;
  error: string | null;
  view: unknown;
  start: (stake: number) => void;
  reset: () => void;
  toggleAuto: () => void;
  pause: () => void;
  resume: () => void;
}

/** The pvp-match surface the window controller reads. */
interface ArenaPvp {
  status: string; // PvpStatus, but the controller only string-compares it
  error: string | null;
  view: unknown;
  reset: () => void;
  findMatch: () => void;
}

export interface ArenaWindowSpec<Solo extends ArenaSolo, Pvp extends ArenaPvp> {
  /** Disposer/label prefix (e.g. "bomb-it"). */
  game: string;
  useSolo: (windowId: string) => Solo;
  usePvp: (windowId: string) => Pvp;
  Lobby: (props: {
    onSolo: (stake: number) => void;
    onFind: () => void;
  }) => ReactNode;
  /** Per-game card-chrome theme for the transitional screens. */
  screen: ArenaScreenTheme;
  /** PvP matchmaking title — "Finding match" / "Finding…" (kept per game, not unified). */
  matchingTitle: string;
  /** Whether the solo error screen shows an "Error" eyebrow (chicken-cross does, bomb-it doesn't). */
  errorEyebrow?: boolean;
  /** Render the game's board for the live solo session. */
  renderSoloBoard: (solo: Solo, onPlayAgain: () => void) => ReactNode;
  /** Render the game's board for the live pvp match. */
  renderPvpBoard: (pvp: Pvp, onPlayAgain: () => void) => ReactNode;
}

/** Default per-game stake for the auto-started solo match (matches the lobby default). */
const AUTO_STAKE = 500;

/**
 * Build an arena game Window: the Solo/PvP chooser + status router shared by every self-play-and-PvP
 * tunnel game. It owns the persisted mode (`modeStore`), the once-per-window auto-start, the
 * solo-error auto-retry, the cabinet attract/take-over wiring, the funding/matching/error/loading
 * screen copy, and the status→Lobby|Screen|Board routing — all identical between games. A game
 * supplies only its hooks, lobby, board renders, and the handful of strings/theme that differ. The
 * previous per-game windows were ~210-line copies of this body.
 */
export function createArenaWindow<Solo extends ArenaSolo, Pvp extends ArenaPvp>(
  spec: ArenaWindowSpec<Solo, Pvp>,
): (props: GameWindowProps) => ReactNode {
  // Persisted by windowId so a remount (minimize / maximize / desktop reflow) returns to the live
  // session instead of the chooser. Both modes survive remount — the sessions live out-of-React,
  // windowId-keyed. One map per game (each game calls this once). Cleared on window close.
  const modeStore = new Map<string, "solo" | "pvp">();
  // Auto-start fires AT MOST ONCE per window. Module-scoped so a minimize/maximize remount never
  // re-funds, and Back returns to the lobby rather than re-triggering. Cleared on close.
  const autoStarted = new Map<string, boolean>();

  return function ArenaWindow({ windowId }: GameWindowProps): ReactNode {
    const account = useCurrentAccount();
    const [mode, setModeState] = useState<WindowMode>(
      () => modeStore.get(windowId) ?? null,
    );
    const pvp = spec.usePvp(windowId);
    const solo = spec.useSolo(windowId);

    useEffect(() => {
      registerWindowDisposer(windowId, `${spec.game}-mode`, () => {
        modeStore.delete(windowId);
        autoStarted.delete(windowId);
      });
    }, [windowId]);

    const setMode = (m: WindowMode) => {
      if (m === "pvp" || m === "solo") modeStore.set(windowId, m);
      else modeStore.delete(windowId);
      setModeState(m);
    };

    const backToMenu = () => {
      if (mode === "solo") solo.reset();
      else if (mode === "pvp") pvp.reset();
      setMode(null);
    };

    // Cabinet "Return to Home": stop solo + show the chooser. Stable (module-const modeStore + stable
    // setModeState + session.reset) so the controller doesn't re-register every render.
    const goHome = useCallback(() => {
      solo.reset();
      modeStore.delete(windowId);
      setModeState(null);
    }, [solo.reset, windowId]);

    // Hand seat A to the human: flip auto off (reads `auto` fresh, so a double take-over is a no-op).
    const goManual = useCallback(() => {
      if (solo.auto) solo.toggleAuto();
    }, [solo.auto, solo.toggleAuto]);
    useSoloCabinet({
      offerable: mode === "solo" && solo.status === "playing" && solo.auto,
      pause: solo.pause,
      resume: solo.resume,
      goManual,
      goHome,
    });

    // Auto-retry a failed solo start every 5s while it sits in "error" (cold-start faucet race /
    // transient sponsor blip) so the unattended bot game self-heals. Retries with the stake last
    // started (auto-start uses AUTO_STAKE; the lobby's chosen stake otherwise).
    const lastStakeRef = useRef(AUTO_STAKE);
    const retrySolo = useCallback(() => {
      solo.reset();
      solo.start(lastStakeRef.current);
    }, [solo.reset, solo.start]);
    useSoloAutoRetry(mode === "solo", solo.status, retrySolo);

    // First open with a wallet connected → fund + play a solo bot match immediately (parity with the
    // other arena games), instead of landing on the lobby. Once-only per window: a remount never
    // re-funds (the out-of-React session is already live), and Back returns to the lobby, not a refund.
    useEffect(() => {
      if (autoStarted.get(windowId)) return;
      if (mode !== null || !account || solo.status !== "idle") return;
      autoStarted.set(windowId, true);
      setMode("solo");
      solo.start(AUTO_STAKE);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [account, mode, solo.status, windowId]);

    // Auto out to lobby/chooser when wallet disconnects
    useEffect(() => {
      if (!account && mode !== null) {
        if (mode === "pvp") {
          pvp.reset();
        }
        setMode(null);
      }
    }, [account, mode, pvp]);

    const screen = (
      children: ReactNode,
      onBack?: () => void,
      backLabel?: string,
    ) => (
      <ArenaScreen theme={spec.screen} onBack={onBack} backLabel={backLabel}>
        {children}
      </ArenaScreen>
    );
    const funding = screen(
      <>
        <span className="sketch-eyebrow">Tunnel</span>
        <h2 className="sketch-title">Funding</h2>
        <p className="sketch-note">
          Opening + funding the tunnel on-chain… approve in your wallet.
        </p>
      </>,
    );
    const loading = screen(<p className="sketch-note">Loading…</p>);

    if (mode === null) {
      const { Lobby } = spec;
      return (
        <Lobby
          onSolo={(s) => {
            lastStakeRef.current = s;
            setMode("solo");
            solo.start(s);
          }}
          onFind={() => {
            setMode("pvp");
            pvp.findMatch();
          }}
        />
      );
    }

    if (mode === "solo") {
      if (solo.status === "error")
        return screen(
          <>
            {spec.errorEyebrow ? (
              <span className="sketch-eyebrow">Error</span>
            ) : null}
            <p className="sketch-note text-[var(--sketch-red)]">
              {solo.error ?? "something went wrong"}
            </p>
          </>,
          backToMenu,
        );
      if (solo.status === "funding") return funding;
      if (
        (solo.status === "playing" ||
          solo.status === "settling" ||
          solo.status === "settled") &&
        solo.view !== null
      )
        return spec.renderSoloBoard(solo, backToMenu);
      return loading;
    }

    // PvP
    if (pvp.status === "error")
      return screen(
        <p className="sketch-note text-[var(--sketch-red)]">
          {pvp.error ?? "something went wrong"}
        </p>,
        backToMenu,
      );
    if (pvp.status === "matching")
      return screen(
        <>
          <span className="sketch-eyebrow">Relay</span>
          <h2 className="sketch-title">{spec.matchingTitle}</h2>
          <p className="sketch-note">
            Matching you with the next player over the relay.
          </p>
        </>,
        backToMenu,
        "Cancel",
      );
    if (pvp.status === "funding") return funding;
    if (
      (pvp.status === "playing" ||
        pvp.status === "settling" ||
        pvp.status === "settled") &&
      pvp.view !== null
    )
      return spec.renderPvpBoard(pvp, backToMenu);
    return loading;
  };
}
