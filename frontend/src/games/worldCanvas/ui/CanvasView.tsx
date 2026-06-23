import { useEffect, useRef, useState } from "react";
import { useWorldCanvasOnchain } from "../useWorldCanvasOnchain";
import {
  AGENT_MODES,
  AGENT_MODE_GROUPS,
  AGENT_GROUP_LABELS,
  type AgentDrawMode,
  type AgentModeGroup,
} from "../designs";
import { TEMPLATES, type StrokeTemplate } from "../templates";
import { WorldCanvas } from "./WorldCanvas";
import { PaletteDock } from "./PaletteDock";
import { StampDock } from "./StampDock";
import { PlayersActivityPanel, LeaderboardPanel } from "./panels";
import { MenuBar, type W98Menu, type W98MenuItem } from "./MenuBar";
import { ToolBox, type ToolId } from "./ToolBox";
import { AgentPanel } from "./AgentPanel";
import { StatusBar } from "./StatusBar";
import { W98Window } from "./W98Window";
import { W98, FONT_W98, w98Inset } from "./tokens";

/** Modes bucketed by visual group — drives the Agent menu's Intelligence section. */
const MODES_BY_GROUP: { group: AgentModeGroup; modes: AgentDrawMode[] }[] =
  AGENT_MODE_GROUPS.map((group) => ({
    group,
    modes: Object.values(AGENT_MODES).filter((m) => m.group === group),
  }));

/**
 * The Paint app shell: a classic Windows-98 MS-Paint window — menu bar, left tool
 * box, sunken canvas client area, bottom color box, and a status bar — wrapped
 * around the SMOOTH chunked canvas. Every tool/menu maps to an existing engine op;
 * nothing new touches the wire. One human paint = one co-signed move; each spawned
 * Agent AI paints forever over its own tunnel.
 */
export function CanvasView({ onExit }: { onExit?: () => void }) {
  const engine = useWorldCanvasOnchain();
  const [primary, setPrimary] = useState(13); // foreground — Sui blue (index 13)
  const [secondary, setSecondary] = useState(0); // background — white (the eraser color)
  const [brushSize, setBrushSize] = useState(1);
  const [tool, setTool] = useState<ToolId>("brush");
  const [showGrid, setShowGrid] = useState(false);
  const [armedTemplate, setArmedTemplate] = useState<StrokeTemplate | null>(null);

  // Floating tool windows — toggled from the View / Agent menus.
  const [showAgentPanel, setShowAgentPanel] = useState(true);
  const [showStamps, setShowStamps] = useState(false);
  const [showPlayers, setShowPlayers] = useState(true);
  const [showLeaderboard, setShowLeaderboard] = useState(true);
  const [showAbout, setShowAbout] = useState(false);

  const tps = useRollingTps(engine.status.movesCoSigned);

  // Arming a stamp implies the Stamps window should be visible; Esc disarms.
  useEffect(() => {
    if (!armedTemplate) return;
    setShowStamps(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setArmedTemplate(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armedTemplate]);

  // Tool → existing paint op: Brush paints the foreground; Pencil is forced 1×;
  // Eraser paints the background (secondary) color. Non-wired tools keep brushing.
  const effectiveColor = tool === "eraser" ? secondary : primary;
  const effectiveBrush = tool === "pencil" ? 1 : brushSize;

  const swapColors = () => {
    setPrimary(secondary);
    setSecondary(primary);
  };
  const burst = () => {
    engine.setAgentSpeed("fast");
    engine.setAgentDensity(3);
    engine.spawnAgent();
  };

  const soon = (label: string): W98MenuItem => ({
    kind: "action",
    label,
    onClick: () => {},
    disabled: true,
    accel: "soon",
  });

  const menus: W98Menu[] = [
    {
      label: "File",
      items: [
        soon("New"),
        soon("Save Image"),
        { kind: "sep" },
        {
          kind: "action",
          label: "Exit",
          onClick: () => onExit?.(),
          disabled: !onExit,
        },
      ],
    },
    {
      label: "Edit",
      items: [soon("Undo"), soon("Redo"), { kind: "sep" }, soon("Clear Canvas")],
    },
    {
      label: "View",
      items: [
        { kind: "check", label: "Show Grid", checked: showGrid, onClick: () => setShowGrid((g) => !g) },
        { kind: "sep" },
        { kind: "check", label: "Agent AI", checked: showAgentPanel, onClick: () => setShowAgentPanel((v) => !v) },
        { kind: "check", label: "Stamps", checked: showStamps, onClick: () => setShowStamps((v) => !v) },
        { kind: "check", label: "Players", checked: showPlayers, onClick: () => setShowPlayers((v) => !v) },
        { kind: "check", label: "Leaderboard", checked: showLeaderboard, onClick: () => setShowLeaderboard((v) => !v) },
      ],
    },
    {
      label: "Colors",
      items: [
        { kind: "action", label: "Swap Foreground / Background", onClick: swapColors },
        { kind: "sep" },
        { kind: "action", label: "Open Stamps…", onClick: () => setShowStamps(true) },
        soon("Edit Colors…"),
      ],
    },
    {
      label: "Agent",
      items: [
        { kind: "action", label: "Spawn Agent AI", onClick: engine.spawnAgent },
        { kind: "action", label: "⚡ BURST (fast · 3× · spawn)", onClick: burst },
        { kind: "action", label: "View Next Agent", onClick: engine.viewNextAgent, disabled: engine.agentCount === 0 },
        { kind: "action", label: "Stop All Agents", onClick: engine.stopAgents, disabled: engine.agentCount === 0 },
        { kind: "sep" },
        { kind: "header", label: "Speed" },
        ...(["slow", "normal", "fast"] as const).map(
          (s): W98MenuItem => ({
            kind: "radio",
            label: s[0].toUpperCase() + s.slice(1),
            checked: engine.agentSpeed === s,
            onClick: () => engine.setAgentSpeed(s),
          }),
        ),
        { kind: "sep" },
        ...MODES_BY_GROUP.flatMap(({ group, modes }): W98MenuItem[] => [
          { kind: "header", label: `Intelligence · ${AGENT_GROUP_LABELS[group]}` },
          ...modes.map(
            (m): W98MenuItem => ({
              kind: "radio",
              label: m.label,
              checked: engine.agentMode === m.id,
              onClick: () => engine.setAgentMode(m.id),
            }),
          ),
        ]),
        ...(engine.agentMode === "artist"
          ? ([
              { kind: "sep" } as W98MenuItem,
              { kind: "header", label: "Template" } as W98MenuItem,
              {
                kind: "radio",
                label: "Flags (built-in)",
                checked: engine.agentTemplate === null,
                onClick: () => engine.setAgentTemplate(null),
              } as W98MenuItem,
              ...TEMPLATES.map(
                (t): W98MenuItem => ({
                  kind: "radio",
                  label: t.name,
                  checked: engine.agentTemplate === t.id,
                  onClick: () => engine.setAgentTemplate(t.id),
                }),
              ),
            ] as W98MenuItem[])
          : []),
        { kind: "sep" },
        { kind: "header", label: "Density" },
        ...([1, 2, 3] as const).map(
          (n): W98MenuItem => ({
            kind: "radio",
            label: `${n}× per tick`,
            checked: engine.agentDensity === n,
            onClick: () => engine.setAgentDensity(n),
          }),
        ),
        { kind: "sep" },
        { kind: "check", label: "Agent AI Window", checked: showAgentPanel, onClick: () => setShowAgentPanel((v) => !v) },
      ],
    },
    {
      label: "Help",
      items: [
        { kind: "action", label: "About The World is Your Canvas…", onClick: () => setShowAbout(true) },
        soon("Controls"),
      ],
    },
  ];

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        background: W98.face,
        color: W98.text,
        fontFamily: FONT_W98,
        overflow: "hidden",
      }}
    >
      <MenuBar menus={menus} />

      {/* Tool box + sunken canvas client area. */}
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex",
          gap: 3,
          padding: 3,
        }}
      >
        <ToolBox
          tool={tool}
          onTool={setTool}
          brushSize={brushSize}
          onBrushSize={setBrushSize}
        />

        <div
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            minHeight: 0,
            position: "relative",
            overflow: "hidden",
            ...w98Inset,
          }}
        >
          {/* Inner client: inset past the sunken bevel; the positioned ancestor for
              both the canvas and every floating tool window. */}
          <div style={{ position: "absolute", inset: 3, overflow: "hidden" }}>
            <WorldCanvas
              paints={engine.paints}
              revision={engine.revision}
              selectedColor={effectiveColor}
              brushSize={effectiveBrush}
              showGrid={showGrid}
              disabled={engine.status.phase === "opening"}
              onPaint={engine.submitHumanPaint}
              agents={engine.agents}
              focus={engine.focus}
              humanAddress={engine.humanAddress}
              armedTemplate={armedTemplate}
            />

            {showAgentPanel && (
              <AgentPanel engine={engine} onClose={() => setShowAgentPanel(false)} />
            )}
            {showStamps && (
              <StampDock
                armed={armedTemplate}
                onArm={setArmedTemplate}
                onClose={() => {
                  setArmedTemplate(null);
                  setShowStamps(false);
                }}
              />
            )}
            {showPlayers && (
              <PlayersActivityPanel
                painters={engine.painters}
                activity={engine.activity}
                humanAddress={engine.humanAddress}
                agents={engine.agents}
                onFocusAgent={engine.focusOnAgent}
                onClose={() => setShowPlayers(false)}
                revision={engine.revision}
              />
            )}
            {showLeaderboard && (
              <LeaderboardPanel
                painters={engine.painters}
                onClose={() => setShowLeaderboard(false)}
                revision={engine.revision}
              />
            )}
            {showAbout && <AboutWindow onClose={() => setShowAbout(false)} />}
          </div>
        </div>
      </div>

      <PaletteDock
        primary={primary}
        secondary={secondary}
        onPrimary={setPrimary}
        onSecondary={setSecondary}
      />

      <StatusBar
        movesCoSigned={engine.status.movesCoSigned}
        tps={tps}
        agentCount={engine.agentCount}
        phase={engine.status.phase}
        onchain={engine.status.onchain}
      />
    </div>
  );
}

/** A small About box in the Paint-app spirit. */
function AboutWindow({ onClose }: { onClose: () => void }) {
  return (
    <W98Window
      title="About"
      icon="🎨"
      onClose={onClose}
      storageKey="wc.aboutWindow"
      defaultAnchor={{ left: "50%", top: 64 }}
      width={272}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8, lineHeight: 1.4 }}>
        <strong style={{ fontSize: 13 }}>The World is Your Canvas</strong>
        <span style={{ fontSize: 11.5, color: W98.text }}>
          A shared, infinite brush-painting wall on the Sui tunnel arena. Every cell
          you paint is one co-signed off-chain move — roughly one TPS. Press Agent AI
          to spawn bots that co-paint forever, each on its own tunnel.
        </span>
        <span style={{ fontSize: 10.5, color: W98.textDim }}>
          Brush · Pencil · Eraser are live. Pick / Fill / Line / Rectangle / Ellipse
          are coming soon.
        </span>
      </div>
    </W98Window>
  );
}

/** Derive a live throughput number from the monotonic co-signed paint count via a
 *  short sliding window (sampled every 500 ms over ~3 s) — a coarse TPS dial. */
function useRollingTps(movesCoSigned: number): number {
  const [tps, setTps] = useState(0);
  const samples = useRef<{ t: number; n: number }[]>([]);
  const latest = useRef(movesCoSigned);
  latest.current = movesCoSigned;

  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      const s = samples.current;
      s.push({ t: now, n: latest.current });
      while (s.length > 1 && now - s[0].t > 3000) s.shift();
      const first = s[0];
      const dt = (now - first.t) / 1000;
      setTps(dt > 0 ? Math.max(0, (latest.current - first.n) / dt) : 0);
    }, 500);
    return () => clearInterval(id);
  }, []);

  return tps;
}
