export type ShellState = "attract" | "inviting" | "live";

export interface SeatModel {
  state: ShellState;
}

export type SeatEvent =
  | { type: "hover" }
  | { type: "unhover" }
  | { type: "takeOver" }
  | { type: "goHome" };

export const INITIAL: SeatModel = { state: "attract" };

export function reduce(m: SeatModel, e: SeatEvent): SeatModel {
  switch (m.state) {
    case "attract":
      return e.type === "hover" ? { state: "inviting" } : m;
    case "inviting":
      // unhover and the overlay's "Return to Home" both just dismiss → attract
      if (e.type === "unhover" || e.type === "goHome") return { state: "attract" };
      if (e.type === "takeOver") return { state: "live" }; // you took the seat
      return m;
    case "live":
      return e.type === "goHome" ? INITIAL : m; // in-game Home = exit to the floor
  }
}
