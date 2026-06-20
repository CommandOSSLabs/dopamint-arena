/** Reference-stable store for useSyncExternalStore: identical-by-value sets are no-ops. */
export class SnapshotStore<T extends object> {
  private current: Readonly<T>;
  private readonly listeners = new Set<() => void>();
  constructor(initial: T) { this.current = Object.freeze({ ...initial }); }
  get(): Readonly<T> { return this.current; }
  set(next: T): void {
    if (sameShallow(this.current as Record<string, unknown>, next as Record<string, unknown>)) return;
    this.current = Object.freeze({ ...next });
    for (const l of this.listeners) l();
  }
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

function sameShallow(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.is(a[k], b[k]));
}
