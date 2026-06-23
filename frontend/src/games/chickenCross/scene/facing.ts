import type { CrossDirection } from "./crossSceneTypes.ts";

/** Y rotation so +Z local (beak/arrow) matches world facing. */
export function crossFacingYaw(direction: CrossDirection): number {
  switch (direction) {
    case "north":
      return 0;
    case "east":
      return Math.PI / 2;
    case "south":
      return Math.PI;
    case "west":
      return -Math.PI / 2;
  }
}
