import type { CoSignedUpdate } from "./tunnelTypes";
import { concatBytes } from "sui-tunnel-ts/core/bytes";
import { blake2b256 } from "sui-tunnel-ts/core/crypto";
import { serializeStateUpdate } from "sui-tunnel-ts/core/wire";

const enc = new TextEncoder();
const LEAF = enc.encode("sui_tunnel::transcript::leaf");
const NODE = enc.encode("sui_tunnel::transcript::node");
const ZERO32 = new Uint8Array(32);

function transcriptLeaf(update: CoSignedUpdate): Uint8Array {
  return blake2b256(
    concatBytes([
      LEAF,
      serializeStateUpdate(update.update),
      update.sigA,
      update.sigB,
    ]),
  );
}

export function transcriptRootFor(
  _tunnelId: string,
  updates: readonly CoSignedUpdate[],
): Uint8Array {
  if (updates.length === 0) return ZERO32;
  let level = updates.map(transcriptLeaf);
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(ZERO32);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(blake2b256(concatBytes([NODE, level[i], level[i + 1]])));
    }
    level = next;
  }
  return level[0];
}
