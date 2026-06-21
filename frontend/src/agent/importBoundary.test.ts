import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface ForbiddenPattern {
  group: string[];
  message: string;
}

const AGENT_DIR = new URL(".", import.meta.url).pathname;
const BOUNDARY_CONFIG_PATH = join(AGENT_DIR, ".eslintrc-import-boundary.json");

function loadForbiddenPatterns(): ForbiddenPattern[] {
  const raw = JSON.parse(readFileSync(BOUNDARY_CONFIG_PATH, "utf8"));
  const rule = raw.rules["no-restricted-imports"];
  assert.ok(
    Array.isArray(rule) && rule.length >= 2,
    "no-restricted-imports rule must be an array",
  );
  const options = rule[1];
  assert.ok(Array.isArray(options.patterns), "patterns must be an array");
  return options.patterns as ForbiddenPattern[];
}

function globToRegex(pattern: string): RegExp {
  // Escape regex-special characters except * and ?.
  let regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  regex = regex.replace(/\*\*/g, "{{GLOBSTAR}}");
  regex = regex.replace(/\*/g, "[^/]*");
  regex = regex.replace(/\?/g, "[^/]");
  regex = regex.replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regex}$`);
}

function matchesAnyPattern(
  source: string,
  patterns: ForbiddenPattern[],
): ForbiddenPattern | undefined {
  // Strip any Vite/Webpack query suffix (e.g. "?inline").
  const clean = source.split("?")[0]!;
  return patterns.find((p) => p.group.some((g) => globToRegex(g).test(clean)));
}

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (
      st.isFile() &&
      full.endsWith(".ts") &&
      !full.endsWith(".test.ts")
    ) {
      yield full;
    }
  }
}

function* extractImportSources(code: string): Generator<string> {
  // static imports: import ... from "..."
  const staticRe =
    /import\s+(?:(?:type\s+)?(?:[\s\S]*?)\s+from\s+)?["']([^"']+)["']/g;
  // dynamic imports: import("...") and require("...")
  const dynamicRe = /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  // export ... from "..."
  const exportRe =
    /export\s+(?:(?:type\s+)?(?:[\s\S]*?)\s+from\s+)?["']([^"']+)["']/g;

  for (const re of [staticRe, dynamicRe, exportRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      yield m[1]!;
    }
  }
}

describe("agent import-hygiene boundary", () => {
  const patterns = loadForbiddenPatterns();

  it("enforces the boundary for every implementation file", () => {
    const violations: string[] = [];

    for (const file of walkTsFiles(AGENT_DIR)) {
      const rel = relative(AGENT_DIR, file);
      const code = readFileSync(file, "utf8");
      for (const source of extractImportSources(code)) {
        const matched = matchesAnyPattern(source, patterns);
        if (matched) {
          violations.push(`${rel}: "${source}" -> ${matched.message}`);
        }
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      "Forbidden imports found:\n" + violations.join("\n"),
    );
  });
});
