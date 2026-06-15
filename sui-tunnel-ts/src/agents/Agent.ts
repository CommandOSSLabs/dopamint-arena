/**
 * Autonomous agent framework (Deliverable 9).
 *
 * Thousands of agents that automatically discover partners, open tunnels, interact, and
 * settle. An {@link AgentSwarm} builds a population of behavior-typed agents, matchmakes
 * them into tunnels, drives signed interactions via the activity generator, and produces
 * cooperative settlement artifacts (auto-settle). It also reports a settlement-success rate
 * — the fraction of tunnels whose latest co-signed state is independently settleable.
 *
 * This is the at-scale, behavior-aware layer over the core engine; for raw multi-core
 * throughput it pairs with the cluster (sim/cluster.ts) via the benchmark harness.
 */

import { toHex } from "../core/bytes";
import { blake2b256 } from "../core/crypto";
import { Participant, ParticipantRegistry } from "../core/keys";
import {
  CoSignedSettlement,
  OffchainTunnel,
  SignMode,
  verifyCoSignedUpdate,
} from "../core/tunnel";
import { ActivityGenerator } from "../sim/activityGen";
import { Rng, mulberry32 } from "../sim/rng";
import { Counters, newCounters } from "../telemetry/metrics";
import {
  BEHAVIOR_NAMES,
  BehaviorName,
  createBehaviorProtocol,
} from "./behaviors";

export interface Agent {
  id: string;
  participant: Participant;
  behaviors: BehaviorName[];
}

export interface SwarmConfig {
  agents: number;
  tunnels: number;
  /** Behaviors cycled across tunnels. Default: all five. */
  behaviors?: BehaviorName[];
  /** Per-party locked balance. Default 1_000_000n. */
  initialBalance?: bigint;
  seed?: number;
}

interface SwarmTunnel {
  tunnelId: string;
  behavior: BehaviorName;
  tunnel: OffchainTunnel<unknown, unknown>;
  aId: string;
  bId: string;
}

const enc = new TextEncoder();

/** Pairs agents into tunnels (autonomous partner discovery). */
export class Matchmaker {
  /** Deterministically pair agents into `count` tunnels across `behaviors`. */
  static pair(
    agents: Agent[],
    count: number,
    behaviors: BehaviorName[],
  ): { a: Agent; b: Agent; behavior: BehaviorName }[] {
    if (agents.length < 2) throw new Error("need >= 2 agents to form tunnels");
    const out: { a: Agent; b: Agent; behavior: BehaviorName }[] = [];
    for (let i = 0; i < count; i++) {
      const n = agents.length;
      const a = agents[i % n];
      const base = i + 1 + Math.floor(i / n);
      let b = agents[base % n];
      // Guarantee a distinct partner. The previous fixed +2 fallback still collided with `a`
      // when n === 2 (it resolved back to a's own index); scan forward instead.
      if (b.id === a.id) {
        for (let k = 1; k < n; k++) {
          const cand = agents[(base + k) % n];
          if (cand.id !== a.id) {
            b = cand;
            break;
          }
        }
      }
      out.push({ a, b, behavior: behaviors[i % behaviors.length] });
    }
    return out;
  }
}

export class AgentSwarm {
  readonly agents: Agent[];
  readonly tunnels: OffchainTunnel<unknown, unknown>[];
  readonly counters: Counters = newCounters();
  readonly rng: Rng;
  private readonly swarmTunnels: SwarmTunnel[];

  constructor(cfg: SwarmConfig) {
    const seed = cfg.seed ?? 1;
    this.rng = mulberry32(seed);
    const behaviors = cfg.behaviors?.length ? cfg.behaviors : BEHAVIOR_NAMES;
    const initial = cfg.initialBalance ?? 1_000_000n;

    const reg = new ParticipantRegistry(this.rng);
    const parts = reg.createMany("agent-", cfg.agents);
    this.agents = parts.map((p, i) => ({
      id: p.id,
      participant: p,
      behaviors: [behaviors[i % behaviors.length]],
    }));

    const pairings = Matchmaker.pair(this.agents, cfg.tunnels, behaviors);
    this.swarmTunnels = pairings.map((pr, i) => {
      const tunnelId =
        "0x" + toHex(blake2b256(enc.encode(`sui_tunnel::agent::${i}`)));
      const tunnel = OffchainTunnel.selfPlay(
        createBehaviorProtocol(pr.behavior),
        tunnelId,
        pr.a.participant.keyPair,
        pr.b.participant.keyPair,
        pr.a.participant.address,
        pr.b.participant.address,
        { a: initial, b: initial },
      );
      return {
        tunnelId,
        behavior: pr.behavior,
        tunnel,
        aId: pr.a.id,
        bId: pr.b.id,
      };
    });
    this.tunnels = this.swarmTunnels.map((s) => s.tunnel);
    this.counters.tunnelsOpened = this.tunnels.length;
  }

  activityGenerator(
    signMode: SignMode = "full",
  ): ActivityGenerator<unknown, unknown> {
    return new ActivityGenerator(
      this.tunnels,
      this.counters,
      this.rng,
      signMode,
    );
  }

  /** Auto-settle: produce a cooperative settlement artifact for every tunnel. */
  settleAll(
    timestamp: bigint,
  ): { tunnelId: string; settlement: CoSignedSettlement }[] {
    const out = this.swarmTunnels.map((s) => ({
      tunnelId: s.tunnelId,
      settlement: s.tunnel.buildSettlement(timestamp),
    }));
    this.counters.settlements += out.length;
    return out;
  }

  /** Fraction of tunnels whose latest co-signed state independently verifies (settleable). */
  settlementSuccessRate(): number {
    let ok = 0;
    let total = 0;
    for (const s of this.swarmTunnels) {
      total++;
      const u = s.tunnel.latest;
      if (
        u &&
        verifyCoSignedUpdate(
          u,
          {
            publicKey: s.tunnel.partyA.publicKey,
            scheme: s.tunnel.partyA.scheme,
          },
          {
            publicKey: s.tunnel.partyB.publicKey,
            scheme: s.tunnel.partyB.scheme,
          },
        )
      ) {
        ok++;
      }
    }
    return total ? ok / total : 0;
  }

  /** Count of tunnels per behavior (for reports). */
  behaviorBreakdown(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.swarmTunnels)
      out[s.behavior] = (out[s.behavior] ?? 0) + 1;
    return out;
  }
}
