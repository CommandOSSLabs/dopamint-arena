import { test, expect } from "bun:test";
import { parseEnv, serializeEnv } from "./env";

test("env serialize/parse round-trips KEY=VALUE lines", () => {
  const vars = { PACKAGE_ID: "0xabc", SUI_RPC_URL: "http://127.0.0.1:9000" };
  expect(parseEnv(serializeEnv(vars))).toEqual(vars);
});

test("parseEnv ignores blanks and comments", () => {
  expect(parseEnv("# c\n\nA=1\n")).toEqual({ A: "1" });
});
