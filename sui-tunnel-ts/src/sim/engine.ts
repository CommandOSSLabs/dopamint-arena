/**
 * High-speed tunnel simulator (Deliverable 1).
 *
 * Builds N users + N agents + M tunnels with configurable assignment
 * (random / deterministic) and tunnel kinds (user-user, user-agent, agent-agent,
 * self-play), then drives continuous signed state updates via the activity generator.
 * Pure off-chain and in-memory — no Sui RPC. Self-play is always possible because the
 * simulator holds both parties' ephemeral keys (the locked design decision), so every
 * tunnel is locally signable regardless of its topological kind.
 */

import { OffchainTunnel } from "../core/tunnel";
import {
  ParticipantRegistry,
  Participant,
  createParticipant,
} from "../core/keys";
import { blake2b256 } from "../core/crypto";
import { toHex } from "../core/bytes";
import { Protocol, Balances } from "../protocol/Protocol";
import { PaymentsProtocol } from "../protocol/payments";
import { Counters, newCounters } from "../telemetry/metrics";
import { ActivityGenerator } from "./activityGen";
import { Rng, mulberry32 } from "./rng";

export type TunnelKind =
  | "user-user"
  | "user-agent"
  | "agent-agent"
  | "self-play";

export interface SimConfig {
  users: number;
  agents: number;
  tunnels: number;
  /** How endpoints are drawn from the pools. Default "deterministic". */
  assignment?: "random" | "deterministic";
  /** Allowed tunnel kinds, cycled/sampled across tunnels. Default ["user-agent"]. */
  kinds?: TunnelKind[];
  /** Per-party locked balance. Default 1_000_000n. */
  initialBalance?: bigint;
  /** Protocol factory (default Payments). Stateless protocols may be shared. */
  protocol?: () => Protocol<unknown, unknown>;
  /** RNG seed for reproducibility. Default 1. */
  seed?: number;
}

const enc = new TextEncoder();

/** Deterministic synthetic tunnel id for off-chain simulation (replaced by the real
 * object id once opened on-chain in Phase 4). */
export function simTunnelId(index: number): string {
  return "0x" + toHex(blake2b256(enc.encode(`sui_tunnel::sim::${index}`)));
}

export class Simulator {
  readonly users: Participant[];
  readonly agents: Participant[];
  readonly tunnels: OffchainTunnel<unknown, unknown>[];
  readonly counters: Counters = newCounters();
  readonly rng: Rng;

  constructor(cfg: SimConfig) {
    const assignment = cfg.assignment ?? "deterministic";
    const kinds = cfg.kinds && cfg.kinds.length ? cfg.kinds : ["user-agent"];
    const initial = cfg.initialBalance ?? 1_000_000n;
    const seed = cfg.seed ?? 1;
    this.rng = mulberry32(seed);

    // Seeded registry => deterministic identities => reproducible runs / replay.
    const registry = new ParticipantRegistry(this.rng);
    this.users = registry.createMany("user-", cfg.users);
    this.agents = registry.createMany("agent-", cfg.agents);

    const initialBalances: Balances = { a: initial, b: initial };
    const protoFactory =
      cfg.protocol ??
      (() => new PaymentsProtocol() as Protocol<unknown, unknown>);
    // stateless protocols can be shared across all tunnels (less allocation)
    const sharedProto = protoFactory();

    const pick = (pool: Participant[], i: number): Participant => {
      if (pool.length === 0) {
        // no pool members: fall back to a deterministic ephemeral identity
        return createParticipant(`ephemeral-${i}`, this.rng);
      }
      const idx =
        assignment === "random"
          ? Math.floor(this.rng() * pool.length)
          : i % pool.length;
      return pool[idx];
    };

    this.tunnels = new Array(cfg.tunnels);
    for (let i = 0; i < cfg.tunnels; i++) {
      const kind = kinds[i % kinds.length];
      let a: Participant;
      let b: Participant;
      switch (kind) {
        case "user-user":
          a = pick(this.users, i);
          b = pick(this.users, i + 1);
          break;
        case "agent-agent":
          a = pick(this.agents, i);
          b = pick(this.agents, i + 1);
          break;
        case "self-play":
          a = createParticipant(`self-${i}-a`, this.rng);
          b = createParticipant(`self-${i}-b`, this.rng);
          break;
        case "user-agent":
        default:
          a = pick(this.users, i);
          b = pick(this.agents, i);
          break;
      }
      this.tunnels[i] = OffchainTunnel.selfPlay(
        sharedProto,
        simTunnelId(i),
        a.keyPair,
        b.keyPair,
        a.address,
        b.address,
        initialBalances,
      );
    }
    this.counters.tunnelsOpened = cfg.tunnels;
  }

  /** Build an activity generator over all tunnels using this sim's counters + RNG. */
  activityGenerator(
    signMode: "full" | "sign-only" | "none" = "full",
  ): ActivityGenerator<unknown, unknown> {
    return new ActivityGenerator(
      this.tunnels,
      this.counters,
      this.rng,
      signMode,
    );
  }
}
