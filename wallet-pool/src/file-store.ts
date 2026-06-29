import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StoreError } from "./errors";
import type { WalletPoolStore } from "./store";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Owner-only filesystem store; one file per pool at <dir>/<wallet-pool-id>.json. */
export class FileWalletPoolStore implements WalletPoolStore {
  constructor(readonly dir: string) {}

  private path(id: string): string {
    if (!/^wp_[A-Za-z0-9_-]+$/.test(id)) throw new StoreError(`invalid pool id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
  }

  async read(id: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(id)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new StoreError(`read failed for ${id}: ${(e as Error).message}`);
    }
  }

  async write(id: string, bytes: Uint8Array): Promise<void> {
    await this.ensureDir();
    await writeFile(this.path(id), Buffer.from(bytes), { mode: FILE_MODE });
  }

  async list(): Promise<string[]> {
    try {
      const names = await readdir(this.dir);
      return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new StoreError(`list failed: ${(e as Error).message}`);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await rm(this.path(id));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new StoreError(`delete failed for ${id}: ${(e as Error).message}`);
    }
  }
}
