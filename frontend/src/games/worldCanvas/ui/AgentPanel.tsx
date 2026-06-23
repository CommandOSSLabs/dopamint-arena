/**
 * The Agent AI control window — the hero feature, framed as a floating Win-98 tool
 * palette. Spawn an agent (each opens its OWN co-signed tunnel and paints forever),
 * fire a one-click BURST (fast + max density + spawn = an instant TPS spike), and
 * dial Speed / Intelligence / Density / Template. Every control drives the existing
 * engine API unchanged — this is pure chrome over the proven per-agent tunnel path.
 */
import { type ReactNode } from "react";
import type {
  UseWorldCanvasOnchain,
  AgentSpeed,
} from "../useWorldCanvasOnchain";
import {
  AGENT_MODES,
  AGENT_MODE_GROUPS,
  AGENT_GROUP_LABELS,
  type AgentDrawMode,
  type AgentModeGroup,
} from "../designs";
import { TEMPLATES } from "../templates";
import { W98, FONT_W98, w98Outset, w98Button } from "./tokens";
import { W98Window } from "./W98Window";
import { TemplateThumb } from "./StampDock";

const MODES_BY_GROUP: { group: AgentModeGroup; modes: AgentDrawMode[] }[] =
  AGENT_MODE_GROUPS.map((group) => ({
    group,
    modes: Object.values(AGENT_MODES).filter((m) => m.group === group),
  }));

/** The acceleration dial — explicit ×N multipliers on the agent's co-signed cells/sec. */
const SPEEDS: { value: AgentSpeed; label: string }[] = [
  { value: "x1", label: "×1" },
  { value: "x2", label: "×2" },
  { value: "x4", label: "×4" },
  { value: "x8", label: "×8" },
];
const DENSITIES = [1, 2, 3] as const;

/** A beveled segmented toggle button in the Win-98 look. */
function Seg({
  active,
  onClick,
  title,
  grow,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  grow?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={{
        ...w98Button(active),
        flex: grow ? "1 1 0" : "0 0 auto",
        minHeight: 19,
        padding: "2px 7px",
        fontFamily: FONT_W98,
        fontSize: 11,
        fontWeight: active ? 700 : 400,
        color: W98.text,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: W98.textDim }}>{label}</span>
      {children}
    </div>
  );
}

export function AgentPanel({
  engine,
  onClose,
}: {
  engine: UseWorldCanvasOnchain;
  onClose: () => void;
}) {
  const burst = () => {
    engine.setAgentSpeed("x8");
    engine.setAgentDensity(3);
    engine.spawnAgent();
  };

  return (
    <W98Window
      title="Agent AI"
      icon="🤖"
      onClose={onClose}
      storageKey="wc.agentPanel"
      defaultAnchor={{ right: 12, top: 10 }}
      width={210}
      bodyStyle={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <div style={{ display: "flex", gap: 5 }}>
        <button
          onClick={engine.spawnAgent}
          title="Spawn one bot that paints forever over its OWN co-signed tunnel"
          style={{
            ...w98Outset,
            flex: "1 1 0",
            minHeight: 28,
            fontFamily: FONT_W98,
            fontSize: 12,
            fontWeight: 700,
            color: W98.text,
            cursor: "pointer",
          }}
        >
          🤖 Spawn
        </button>
        <button
          onClick={burst}
          title="BURST — fast + max density + spawn: an instant TPS spike"
          style={{
            ...w98Outset,
            flex: "0 0 auto",
            minHeight: 28,
            padding: "0 10px",
            fontFamily: FONT_W98,
            fontSize: 12,
            fontWeight: 800,
            color: "#a31515",
            cursor: "pointer",
          }}
        >
          ⚡ BURST
        </button>
      </div>

      <Field label="Speed (TPS multiplier)">
        <div style={{ display: "flex", gap: 3 }}>
          {SPEEDS.map((s) => (
            <Seg
              key={s.value}
              grow
              active={engine.agentSpeed === s.value}
              onClick={() => engine.setAgentSpeed(s.value)}
              title={`Accelerate co-signed cells/sec ${s.label} — ${s.value} burst`}
            >
              {s.label}
            </Seg>
          ))}
        </div>
      </Field>

      <Field label="Intelligence">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {MODES_BY_GROUP.map(({ group, modes }) => (
            <div key={group} style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
              <span
                style={{
                  fontSize: 9,
                  color: W98.textDim,
                  alignSelf: "center",
                  width: 38,
                  flex: "0 0 auto",
                }}
              >
                {AGENT_GROUP_LABELS[group]}
              </span>
              {modes.map((m) => (
                <Seg
                  key={m.id}
                  active={engine.agentMode === m.id}
                  onClick={() => engine.setAgentMode(m.id)}
                  title={m.title}
                >
                  {m.label}
                </Seg>
              ))}
            </div>
          ))}
        </div>
      </Field>

      {engine.agentMode === "artist" && (
        <Field label="Template">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
            <Seg
              active={engine.agentTemplate === null}
              onClick={() => engine.setAgentTemplate(null)}
              title="Lay the built-in flag rotation"
            >
              Flags
            </Seg>
            {TEMPLATES.map((tpl) => {
              const active = engine.agentTemplate === tpl.id;
              return (
                <button
                  key={tpl.id}
                  onClick={() => engine.setAgentTemplate(tpl.id)}
                  aria-pressed={active}
                  title={`Agents stamp: ${tpl.name}`}
                  style={{
                    ...w98Button(active),
                    padding: 2,
                    cursor: "pointer",
                    lineHeight: 0,
                  }}
                >
                  <TemplateThumb tpl={tpl} size={26} />
                </button>
              );
            })}
          </div>
        </Field>
      )}

      <Field label="Density (TPS burst per tick)">
        <div style={{ display: "flex", gap: 3 }}>
          {DENSITIES.map((n) => (
            <Seg
              key={n}
              grow
              active={engine.agentDensity === n}
              onClick={() => engine.setAgentDensity(n)}
              title={`Per-tick batch ×${n} — more cells co-signed per tick`}
            >
              {n}×
            </Seg>
          ))}
        </div>
      </Field>

      {engine.agentCount > 0 && (
        <div style={{ display: "flex", gap: 5 }}>
          <button
            onClick={engine.viewNextAgent}
            title="Cycle the camera to the next active agent"
            style={{
              ...w98Outset,
              flex: "1 1 0",
              minHeight: 22,
              fontFamily: FONT_W98,
              fontSize: 11,
              fontWeight: 700,
              color: W98.text,
              cursor: "pointer",
            }}
          >
            📍 View Agent
          </button>
          <button
            onClick={engine.stopAgents}
            title="Stop all agents and tear down their tunnels"
            style={{
              ...w98Outset,
              flex: "0 0 auto",
              minHeight: 22,
              padding: "0 9px",
              fontFamily: FONT_W98,
              fontSize: 11,
              fontWeight: 700,
              color: "#a31515",
              cursor: "pointer",
            }}
          >
            ✕ {engine.agentCount}
          </button>
        </div>
      )}
    </W98Window>
  );
}
