/**
 * Pluggable storage for proof-of-existence records (Deliverable 7).
 *
 * After a tunnel closes, its transcript is exported for post-event auditing. The store is
 * an interface so the destination is swappable: local files for the demo, in-memory for
 * tests/browser, or Walrus (or any blob store) via an injected upload hook. Walrus is
 * OPTIONAL — `WalrusStore` takes a `publish` function the caller supplies, so the SDK has
 * no hard Walrus dependency.
 */

import { ProofRecord } from "./transcript";

export interface PutResult {
  /** A reference to retrieve the record later (file path, blob id, key, ...). */
  ref: string;
}

export interface TranscriptStore {
  put(record: ProofRecord): Promise<PutResult>;
  get(ref: string): Promise<ProofRecord | null>;
}

/** In-memory store (universal; for tests and the browser). */
export class InMemoryStore implements TranscriptStore {
  private readonly data = new Map<string, ProofRecord>();

  async put(record: ProofRecord): Promise<PutResult> {
    const ref = `mem:${record.tunnelId}`;
    this.data.set(ref, record);
    return { ref };
  }

  async get(ref: string): Promise<ProofRecord | null> {
    return this.data.get(ref) ?? null;
  }

  get size(): number {
    return this.data.size;
  }
}

/**
 * Local-filesystem store: writes one JSON file per tunnel under `dir` (Node only).
 * Uses dynamic import of node:fs so this module stays loadable in non-Node environments.
 */
export class LocalFileStore implements TranscriptStore {
  constructor(private readonly dir: string) {}

  private async fs() {
    return import("node:fs/promises");
  }
  private path(tunnelId: string): string {
    const safe = tunnelId.replace(/[^0-9a-zA-Zx]/g, "_");
    return `${this.dir}/transcript-${safe}.json`;
  }

  async put(record: ProofRecord): Promise<PutResult> {
    const fs = await this.fs();
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.path(record.tunnelId);
    await fs.writeFile(file, JSON.stringify(record, null, 2), "utf8");
    return { ref: file };
  }

  async get(ref: string): Promise<ProofRecord | null> {
    const fs = await this.fs();
    try {
      return JSON.parse(await fs.readFile(ref, "utf8")) as ProofRecord;
    } catch {
      return null;
    }
  }
}

/** A blob publisher hook (e.g. a Walrus client's store call). */
export type BlobPublisher = (bytes: Uint8Array) => Promise<{ ref: string }>;
export type BlobReader = (ref: string) => Promise<Uint8Array | null>;

/**
 * Walrus (or any blob store) via injected hooks. The caller supplies `publish` (and
 * optionally `read`) wired to their Walrus client, so the framework needs no Walrus
 * dependency and works whether or not Walrus is available.
 */
export class WalrusStore implements TranscriptStore {
  constructor(
    private readonly publish: BlobPublisher,
    private readonly read?: BlobReader,
  ) {}

  async put(record: ProofRecord): Promise<PutResult> {
    const bytes = new TextEncoder().encode(JSON.stringify(record));
    return this.publish(bytes);
  }

  async get(ref: string): Promise<ProofRecord | null> {
    if (!this.read) return null;
    const bytes = await this.read(ref);
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes)) as ProofRecord;
  }
}
