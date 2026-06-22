import { describe, expect, it } from "bun:test";
import { deriveServerMove } from "./fairness";

describe("deriveServerMove", () => {
  const seed = "de".repeat(48); // 48-byte BLS-sig-like hex

  it("is deterministic for the same seed and cells", () => {
    const a = deriveServerMove([0, 4, 8], seed);
    const b = deriveServerMove([0, 4, 8], seed);
    expect(a).toBe(b);
  });

  it("returns a cell from the provided set", () => {
    const cells = [1, 3, 5, 7];
    expect(cells).toContain(deriveServerMove(cells, seed));
  });

  it("returns the only cell when the set has one element", () => {
    expect(deriveServerMove([6], seed)).toBe(6);
  });

  it("throws on an empty set", () => {
    expect(() => deriveServerMove([], seed)).toThrow();
  });
});
