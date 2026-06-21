import { test } from "node:test";
import assert from "node:assert/strict";
import { settlementsUrl } from "./explorerClient";

test("settlementsUrl builds a keyset query with only the set filters", () => {
  assert.equal(
    settlementsUrl("https://api.example", { limit: 50 }),
    "https://api.example/v1/settlements?limit=50",
  );
  assert.equal(
    settlementsUrl("https://api.example", { limit: 25, cursor: "1750:Dg", address: "0xA" }),
    "https://api.example/v1/settlements?limit=25&cursor=1750%3ADg&address=0xA",
  );
});

test("settlementsUrl trims a trailing slash on the base", () => {
  assert.equal(
    settlementsUrl("https://api.example/", { limit: 10 }),
    "https://api.example/v1/settlements?limit=10",
  );
});
