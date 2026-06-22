export type CrossDirection = "north" | "south" | "east" | "west";
export type CrossLaneType = "grass" | "road" | "water" | "rails";

export type CrossHazardSnapshot = {
  id: string;
  laneIndex: number;
  x: number;
  width: number;
  vx: number;
  kind: "car" | "log" | "train";
};

export type CrossLaneSnapshot = {
  index: number;
  kind: CrossLaneType;
  hazards: CrossHazardSnapshot[];
};

export type CrossWorldSnapshot = {
  minLane: number;
  maxLane: number;
  lanes: CrossLaneSnapshot[];
};

export type CrossPlayerState = {
  id: string;
  name: string;
  column: number;
  laneIndex: number;
  score: number;
  deaths: number;
  alive: boolean;
  connected: boolean;
  facing: CrossDirection;
};

export type CrossSnapshot = {
  type: "cross:snapshot";
  protocol: number;
  roomCode: string;
  phase: string;
  serverTime: number;
  world: CrossWorldSnapshot;
  players: CrossPlayerState[];
  winnerId: string | null;
};
