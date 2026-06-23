import type { CrossDirection } from "./crossSceneTypes.ts";
import type * as THREE from 'three';

const WORLD_EAST = { x: 1, z: 0 };

/**
 * Maps keyboard left/right to grid east/west using the live camera so movement
 * matches what the player sees on screen (isometric view).
 */
export function worldDirectionForScreenInput(
  camera: THREE.OrthographicCamera,
  logical: CrossDirection,
): CrossDirection {
  if (logical === 'north' || logical === 'south') return logical;

  camera.updateMatrixWorld();
  // camera local +X in world XZ after lookAt
  const m = camera.matrixWorld.elements;
  const rx = m[0];
  const rz = m[2];
  const len = Math.hypot(rx, rz) || 1;
  const sx = rx / len;
  const sz = rz / len;

  const dotEast = sx * WORLD_EAST.x + sz * WORLD_EAST.z;
  const screenRightIsWorldEast = dotEast >= 0;

  if (logical === 'east') return screenRightIsWorldEast ? 'east' : 'west';
  return screenRightIsWorldEast ? 'west' : 'east';
}
