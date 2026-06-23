import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import type { GameWindowProps } from "../types";
import { DUEL, glass, FONT_DISPLAY, FONT_MONO } from "./ui/tokens";
import { DuelChrome } from "./ui/DuelChrome";
import { DuelView } from "./ui/DuelView";
import { type DuelDifficulty } from "./usePaintDuel";
import { usePaintDuelOnchain, MIN_PLAY_MIST } from "./usePaintDuelOnchain";
import { DESIGNS, type PixelDesign } from "@/agent/games/pixelPaint/designs";
import { colorHex } from "./palette";
import {
  loadOrCreateBots,
  botBalances,
  fundBots,
  getSuiClient,
} from "@/games/ticTacToe/app/lib/bots";

/**
 * Pixel Wall ("Pixel Duel") — a secret-shape pixel duel on the Sui tunnel. TWO
 * modes, both running the SAME game (memorize a hidden shape, paint it from
 * memory, sabotage the opponent, reveal + score):
 *   - Play vs Bot (PvE): you duel a design-bot.
 *   - Watch Bots (Auto): two bots duel each other while you spectate.
 * The chooser mirrors the Battleship window's horizontal mode-bar + difficulty
 * pills. Difficulty tunes the bot(s) in both modes.
 */

type PaintMode = "vs-bot" | "auto";
/** Selectable DISPLAY pot (SUI on the line + reveal payout); separate from the
 *  lean sponsor-funded on-chain tunnel stake. */
type DuelStake = 1 | 2 | 5 | 10;
const STAKES: readonly DuelStake[] = [1, 2, 5, 10];
const DIFFICULTIES: readonly DuelDifficulty[] = ["easy", "normal", "hard"];
const DIFFICULTY_LABEL: Record<DuelDifficulty, string> = {
  easy: "Easy",
  normal: "Normal",
  hard: "Hard",
};

export function PaintWindow(_props: GameWindowProps) {
  const [mode, setMode] = useState<PaintMode | null>(null);
  const [difficulty, setDifficulty] = useState<DuelDifficulty>("normal");
  // The DISPLAY pot picked in the menu; carried into the duel as `duel.stake`.
  // Independent of the on-chain tunnel stake (a lean sponsor-funded 1 MIST).
  const [stake, setStake] = useState<DuelStake>(10);

  // <DuelChrome/> mounts ONCE here so its fonts, keyframes, and #pdGlass filter
  // are available to both the menu and the duel (and survive mode switches).
  return (
    <>
      <DuelChrome />
      {mode === null ? (
        <ModeChooser
          onPick={setMode}
          difficulty={difficulty}
          onDifficulty={setDifficulty}
          stake={stake}
          onStake={setStake}
        />
      ) : (
        <div className="relative h-full min-h-0 w-full">
          <DuelMode mode={mode} difficulty={difficulty} stake={stake} />
          <button
            onClick={() => setMode(null)}
            className="absolute right-4 top-3.5 z-10 flex h-[54px] items-center rounded-[14px] px-3 text-xs font-bold"
            style={{ ...glass, color: DUEL.text }}
            title="Back to modes"
          >
            ✕ Modes
          </button>
        </div>
      )}
    </>
  );
}

/** Mounts the duel hook keyed by mode so switching modes rebuilds a fresh duel.
 *  Branch on the (stable, keyed) mode so each child calls exactly one hook: BOTH
 *  modes run over an OffchainTunnel, differing only in who drives seat A — a bot
 *  (auto) or you (vs-bot). */
function DuelMode({
  mode,
  difficulty,
  stake,
}: {
  mode: PaintMode;
  difficulty: DuelDifficulty;
  /** DISPLAY pot in SUI carried into the duel; separate from the tunnel stake. */
  stake: DuelStake;
}) {
  return mode === "auto" ? (
    <AutoDuelInner key={mode} difficulty={difficulty} stake={stake} />
  ) : (
    <VsBotDuelInner key={mode} difficulty={difficulty} stake={stake} />
  );
}

/** Play vs Bot — your seat-A paints + the bot's seat-B ticks co-signed over an
 *  OffchainTunnel (fog stays on; the local duel still drives the UI), reporting
 *  heartbeat TPS and (when the bots hold gas) settling on-chain. The in-view "Auto"
 *  button hands seat A to a bot on the SAME duel via `duel.setAuto` — no remount. */
function VsBotDuelInner({
  difficulty,
  stake,
}: {
  difficulty: DuelDifficulty;
  stake: DuelStake;
}) {
  const { duel, status } = usePaintDuelOnchain({ difficulty, auto: false, stake });
  return <DuelView duel={duel} onchain={status} />;
}

/** Watch Bots (Auto) — bot-vs-bot self-play co-signed over an OffchainTunnel,
 *  reporting heartbeat TPS and (when the bots hold gas) settling on-chain. */
function AutoDuelInner({
  difficulty,
  stake,
}: {
  difficulty: DuelDifficulty;
  stake: DuelStake;
}) {
  const { duel, status } = usePaintDuelOnchain({ difficulty, auto: true, stake });
  return <DuelView duel={duel} onchain={status} />;
}

// ---- Mode chooser (cosmic liquid-glass menu — see pixel-duel-design) -------

/** Per-cell side (px) of the showcase pixel-art tiles' box-shadow grid. */
const SHOWCASE_PIXEL = 4;
/** Real designs rendered as the secret-shape teaser row. */
const SHOWCASE_DESIGNS: readonly PixelDesign[] = [
  DESIGNS.heart,
  DESIGNS.suiDroplet,
  DESIGNS.smiley,
  DESIGNS.walrus,
];
/** Twinkling-pixel tints scattered behind the hero. */
const FLOATER_TINTS = [DUEL.seatA, DUEL.seatB, DUEL.cyan] as const;

type Floater = {
  key: number;
  left: string;
  top: string;
  size: string;
  color: string;
  dur: string;
  delay: string;
};

/** Faint diagonal-fade pixel grid behind the hero. */
const GRID_BACKDROP_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "repeating-linear-gradient(0deg,transparent 0 27px,rgba(77,162,255,0.045) 27px 28px)," +
    "repeating-linear-gradient(90deg,transparent 0 27px,rgba(77,162,255,0.045) 27px 28px)",
  pointerEvents: "none",
  maskImage: "radial-gradient(120% 100% at 50% 30%, #000 40%, transparent 85%)",
  WebkitMaskImage:
    "radial-gradient(120% 100% at 50% 30%, #000 40%, transparent 85%)",
};

/** Caption above each pill group (difficulty / stake). */
const GROUP_LABEL_STYLE: CSSProperties = {
  fontSize: 10.5,
  letterSpacing: ".2em",
  textTransform: "uppercase",
  color: "#6f7d99",
  whiteSpace: "nowrap",
};

/** Frosted capsule wrapping a row of pills. */
const PILL_GROUP_STYLE: CSSProperties = {
  display: "inline-flex",
  padding: 4,
  borderRadius: 999,
  border: "1px solid rgba(160,140,255,0.2)",
  background: "rgba(10,18,38,0.6)",
  gap: 3,
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
};

/** Active pills glow Sui-blue; idle pills are muted ghosts. */
function pillStyle(active: boolean): CSSProperties {
  return {
    cursor: "pointer",
    border: "none",
    borderRadius: 999,
    padding: "7px 18px",
    fontFamily: "inherit",
    fontSize: 13,
    fontWeight: 700,
    transition: "all .15s",
    background: active ? DUEL.accent : "transparent",
    color: active ? "#06203B" : "#7f93b5",
    boxShadow: active ? "0 2px 12px rgba(77,162,255,0.5)" : "none",
  };
}

function makeFloaters(): Floater[] {
  return Array.from({ length: 22 }, (_, i) => ({
    key: i,
    left: `${(Math.random() * 100).toFixed(1)}%`,
    top: `${(Math.random() * 100).toFixed(1)}%`,
    size: `${3 + Math.floor(Math.random() * 4)}px`,
    color: FLOATER_TINTS[i % FLOATER_TINTS.length],
    dur: `${(2.4 + Math.random() * 2.6).toFixed(2)}s`,
    delay: `${(Math.random() * 3).toFixed(2)}s`,
  }));
}

function ModeChooser({
  onPick,
  difficulty,
  onDifficulty,
  stake,
  onStake,
}: {
  onPick: (m: PaintMode) => void;
  difficulty: DuelDifficulty;
  onDifficulty: (d: DuelDifficulty) => void;
  stake: DuelStake;
  onStake: (s: DuelStake) => void;
}) {
  // Frozen once so the twinkles don't re-scatter on every difficulty toggle.
  const floaters = useMemo(makeFloaters, []);
  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        width: "100%",
        overflow: "auto",
        background:
          "radial-gradient(130% 100% at 50% -10%, #112c4d 0%, #0a1730 32%, #06060c 72%)",
        fontFamily: FONT_DISPLAY,
        color: DUEL.text,
      }}
    >
      <div
        style={{
          position: "relative",
          minHeight: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 22,
          padding: 28,
          textAlign: "center",
          boxSizing: "border-box",
        }}
      >
        <div style={GRID_BACKDROP_STYLE} aria-hidden />
        {floaters.map((f) => (
          <div
            key={f.key}
            aria-hidden
            style={{
              position: "absolute",
              borderRadius: 2,
              pointerEvents: "none",
              left: f.left,
              top: f.top,
              width: f.size,
              height: f.size,
              background: f.color,
              animation: `pdTwinkle ${f.dur} ease-in-out ${f.delay} infinite`,
            }}
          />
        ))}

        {/* hero */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
            zIndex: 1,
            animation: "pdRise .5s ease both",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "5px 14px",
              borderRadius: 999,
              border: "1px solid rgba(160,140,255,0.22)",
              background: "rgba(77,162,255,0.07)",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: DUEL.accent,
                boxShadow: `0 0 10px ${DUEL.accent}`,
              }}
            />
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: ".34em",
                textTransform: "uppercase",
                color: "#9fb6d6",
              }}
            >
              On-chain Pixel War
            </span>
          </div>
          <div
            style={{
              fontSize: 66,
              lineHeight: 0.95,
              fontWeight: 700,
              color: "#f3f6ff",
              letterSpacing: "-.03em",
              whiteSpace: "nowrap",
              animation: "pdGlow 3.5s ease-in-out infinite",
            }}
          >
            Pixel Duel
          </div>
          <p
            style={{
              margin: 0,
              maxWidth: "32rem",
              fontSize: 15.5,
              lineHeight: 1.55,
              color: "#93a0bd",
            }}
          >
            Memorize a secret shape, paint it from memory under{" "}
            <span style={{ color: "#cdd8ef", fontWeight: 600 }}>fog of war</span>
            , then probe to reveal &amp; sabotage your opponent's. Highest match
            takes the stake.
          </p>
        </div>

        {/* secret-shape showcase */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-end",
            justifyContent: "center",
            gap: 18,
            zIndex: 1,
            animation: "pdRise .6s ease .08s both",
          }}
        >
          {SHOWCASE_DESIGNS.map((d) => (
            <ShowcaseTile key={d.name} design={d} />
          ))}
        </div>

        {/* difficulty + stake */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: 28,
            zIndex: 1,
            animation: "pdRise .6s ease .14s both",
          }}
        >
          <DifficultyPicker difficulty={difficulty} onDifficulty={onDifficulty} />
          <StakePicker stake={stake} onStake={onStake} />
        </div>

        {/* on-chain: faucet the shared bots so the duel opens a REAL tunnel */}
        <FundBotsControl />

        {/* mode cards */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: 18,
            zIndex: 1,
            animation: "pdRise .6s ease .2s both",
          }}
        >
          <ModeCard variant={MODE_CARDS["vs-bot"]} onClick={() => onPick("vs-bot")} />
          <ModeCard variant={MODE_CARDS.auto} onClick={() => onPick("auto")} />
        </div>

        {/* footer stats */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontSize: 11.5,
            color: "#5f6c87",
            zIndex: 1,
            fontFamily: FONT_MONO,
            animation: "pdRise .6s ease .26s both",
          }}
        >
          <span>💰 {stake} STAKE</span>
          <span style={{ opacity: 0.4 }}>|</span>
          <span>36×18 WALL</span>
          <span style={{ opacity: 0.4 }}>|</span>
          <span>FOG OF WAR</span>
        </div>
      </div>
    </div>
  );
}

/** One secret-shape teaser: a real design rasterized as a box-shadow pixel
 *  grid in its true palette colors, captioned with its name. */
function ShowcaseTile({ design }: { design: PixelDesign }) {
  const shadow = useMemo(() => {
    const parts: string[] = [];
    for (let r = 0; r < design.h; r++) {
      for (let c = 0; c < design.w; c++) {
        const v = design.pixels[r * design.w + c];
        if (v !== 0) {
          parts.push(
            `${c * SHOWCASE_PIXEL}px ${r * SHOWCASE_PIXEL}px 0 0 ${colorHex(v)}`,
          );
        }
      }
    }
    return parts.join(",");
  }, [design]);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 9,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 70,
          height: 70,
          borderRadius: 14,
          background: "rgba(255,255,255,0.025)",
          border: "1px solid rgba(160,140,255,0.16)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
        }}
      >
        <div
          style={{
            position: "relative",
            width: design.w * SHOWCASE_PIXEL,
            height: design.h * SHOWCASE_PIXEL,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: SHOWCASE_PIXEL,
              height: SHOWCASE_PIXEL,
              background: "transparent",
              boxShadow: shadow,
            }}
          />
        </div>
      </div>
      <span
        style={{
          fontSize: 10,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          color: "#6f7d99",
          fontFamily: FONT_MONO,
        }}
      >
        {design.name}
      </span>
    </div>
  );
}

/** Segmented Easy / Normal / Hard control for the bot(s)' skill (wired). */
function DifficultyPicker({
  difficulty,
  onDifficulty,
}: {
  difficulty: DuelDifficulty;
  onDifficulty: (d: DuelDifficulty) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 9,
      }}
    >
      <span style={GROUP_LABEL_STYLE}>Bot difficulty</span>
      <div style={PILL_GROUP_STYLE}>
        {DIFFICULTIES.map((d) => {
          const active = d === difficulty;
          return (
            <button
              key={d}
              onClick={() => onDifficulty(d)}
              aria-pressed={active}
              style={pillStyle(active)}
            >
              {DIFFICULTY_LABEL[d]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Segmented 1 / 2 / 5 / 10 SUI stake selector (wired). Sets the duel's DISPLAY
 *  pot — what's on the line + the reveal payout. The on-chain tunnel runs its own
 *  lean sponsor-funded stake, untouched by this. */
function StakePicker({
  stake,
  onStake,
}: {
  stake: DuelStake;
  onStake: (s: DuelStake) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 9,
      }}
    >
      <span style={GROUP_LABEL_STYLE}>Stake</span>
      <div style={PILL_GROUP_STYLE}>
        {STAKES.map((s) => {
          const active = s === stake;
          return (
            <button
              key={s}
              onClick={() => onStake(s)}
              aria-pressed={active}
              style={{ ...pillStyle(active), fontFamily: FONT_MONO }}
            >
              💰 {s}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** MIST (1e9) → SUI, 3 decimals. */
const fmtSui = (mist: bigint) => (Number(mist) / 1e9).toFixed(3);

/**
 * One-click faucet funding for the two SHARED bots (the same identities
 * tic-tac-toe uses). Funded bots make the duel open a REAL on-chain tunnel
 * (create_and_fund → co-signed paints → settle) instead of the off-chain demo —
 * no wallet needed, it just requests testnet SUI. Fund here, then pick a mode.
 */
function FundBotsControl() {
  const bots = useMemo(() => loadOrCreateBots(), []);
  const [bal, setBal] = useState<{ x: bigint; o: bigint } | null>(null);
  const [funding, setFunding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBal(await botBalances(getSuiClient(), bots));
    } catch {
      /* RPC hiccup — keep the last reading rather than flapping */
    }
  }, [bots]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onFund = useCallback(async () => {
    setFunding(true);
    setErr(null);
    try {
      await fundBots(getSuiClient(), bots);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setFunding(false);
    }
  }, [bots, refresh]);

  const ready = !!bal && bal.x >= MIN_PLAY_MIST && bal.o >= MIN_PLAY_MIST;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 7,
        zIndex: 1,
        animation: "pdRise .6s ease .17s both",
      }}
    >
      <span style={GROUP_LABEL_STYLE}>On-chain bots · faucet → real txns</span>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={onFund}
          disabled={funding}
          style={{
            cursor: funding ? "default" : "pointer",
            border: "1px solid rgba(160,140,255,0.3)",
            borderRadius: 999,
            padding: "7px 16px",
            fontFamily: "inherit",
            fontSize: 12.5,
            fontWeight: 700,
            color: DUEL.text,
            background: "rgba(77,162,255,0.14)",
            opacity: funding ? 0.6 : 1,
          }}
        >
          {funding ? "⛽ Funding…" : "⛽ Fund bots"}
        </button>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: ready ? "#5fe3a1" : "#93a0bd",
          }}
        >
          {bal
            ? `A ${fmtSui(bal.x)} · B ${fmtSui(bal.o)} SUI${ready ? " · ready ✓" : " · needs gas"}`
            : "checking balances…"}
        </span>
      </div>
      {err && (
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: DUEL.hit }}>
          faucet: {err}
        </span>
      )}
    </div>
  );
}

type ModeCardVariant = {
  icon: string;
  title: string;
  subtitle: string;
  accent: string;
  blurb: string;
  cta: string;
  iconStyle: CSSProperties;
  cardBg: string;
  cardBorder: string;
  shadowBase: string;
  shadowHover: string;
  sweep: boolean;
};

const MODE_CARDS: Record<PaintMode, ModeCardVariant> = {
  "vs-bot": {
    icon: "⚔️",
    title: "Play vs Bot",
    subtitle: "You · Sui blue",
    accent: DUEL.seatA,
    blurb:
      "Duel a design-bot — build your secret shape and probe to sabotage theirs before it finishes.",
    cta: "Start duel",
    iconStyle: {
      background: DUEL.seatA,
      boxShadow: "0 4px 14px rgba(77,162,255,0.5)",
    },
    cardBg:
      "linear-gradient(165deg, rgba(77,162,255,0.16), rgba(18,16,40,0.6))",
    cardBorder: "1px solid rgba(77,162,255,0.38)",
    shadowBase: "0 14px 40px rgba(77,162,255,0.18)",
    shadowHover: "0 22px 54px rgba(77,162,255,0.32)",
    sweep: true,
  },
  auto: {
    icon: "👁",
    title: "Watch Bots",
    subtitle: "Spectate · god-view",
    accent: DUEL.seatB,
    blurb:
      "Sit back as two bots build hidden shapes and probe each other. The wall plays itself out to the reveal.",
    cta: "Spectate",
    iconStyle: {
      background: "rgba(207,110,228,0.16)",
      border: "1px solid rgba(207,110,228,0.4)",
    },
    cardBg:
      "linear-gradient(165deg, rgba(207,110,228,0.1), rgba(18,16,40,0.6))",
    cardBorder: "1px solid rgba(160,140,255,0.26)",
    shadowBase: "0 14px 40px rgba(0,0,0,0.3)",
    shadowHover: "0 22px 54px rgba(207,110,228,0.22)",
    sweep: false,
  },
};

/** A big mode tile: sweeping highlight (blue only) + hover-lift, calling
 *  onPick for its mode. */
function ModeCard({
  variant,
  onClick,
}: {
  variant: ModeCardVariant;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        overflow: "hidden",
        width: 268,
        textAlign: "left",
        cursor: "pointer",
        borderRadius: 18,
        padding: 22,
        fontFamily: "inherit",
        color: DUEL.text,
        background: variant.cardBg,
        border: variant.cardBorder,
        boxShadow: hover ? variant.shadowHover : variant.shadowBase,
        transform: hover ? "translateY(-5px)" : "none",
        transition: "transform .16s ease, box-shadow .16s ease",
      }}
    >
      {variant.sweep && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(110deg,transparent 30%,rgba(255,255,255,0.12) 50%,transparent 70%)",
            backgroundSize: "200% 100%",
            animation: "pdSweep 4s linear infinite",
            pointerEvents: "none",
          }}
        />
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 42,
            height: 42,
            borderRadius: 11,
            fontSize: 21,
            ...variant.iconStyle,
          }}
        >
          {variant.icon}
        </span>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-.01em" }}>
            {variant.title}
          </div>
          <div
            style={{
              fontSize: 10.5,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: variant.accent,
              fontWeight: 700,
            }}
          >
            {variant.subtitle}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "#9fb0cf" }}>
        {variant.blurb}
      </div>
      <div
        style={{
          marginTop: 14,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          fontWeight: 700,
          color: variant.accent,
        }}
      >
        {variant.cta} <span style={{ fontSize: 14 }}>→</span>
      </div>
    </button>
  );
}
