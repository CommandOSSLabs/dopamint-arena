// Allocate-vs-resume dedup for the centralized batched arena entry (ADR-0028). On a reload the
// batched `enterArena` and each window's per-game resume both run; a game with a persisted in-flight
// tunnel must be RESUMED, not re-allocated — re-allocating opens (and deposits a fresh stake into) a
// second tunnel that resume then abandons, stranding that stake. This drops such games from the
// allocate set, using the same active-resume-record signal each lane reads, so the two stay consistent.

/** Resume records key games by the hook's resume key (kebab, e.g. `quantum-poker`, `caro`) while
 *  allocation enumerates arena ids (underscore, e.g. `quantum_poker`). For every id the batch
 *  enumerates (each module's DEFAULT variant) the two differ only by separator, so compare with
 *  separators stripped. (The multi-protocol tic-tac-toe module batches only its caro default, whose
 *  resume key is `caro`; the `ttt` variant's `tic_tac_toe` id is never batch-allocated, so its
 *  distinct key doesn't arise here.) */
const canonGameId = (id: string): string => id.replace(/[-_]/g, "");

/** Drop the arena ids whose game already has a resumable in-flight tunnel (its resume key present in
 *  `resumingGameKeys`). Pure so the id-form match — the underscore/kebab footgun — is unit-tested
 *  without a registry or localStorage. */
export function arenaIdsExcludingResuming(
  arenaIds: string[],
  resumingGameKeys: string[],
): string[] {
  const resuming = new Set(resumingGameKeys.map(canonGameId));
  return arenaIds.filter((id) => !resuming.has(canonGameId(id)));
}
