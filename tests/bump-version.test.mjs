import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
test("package has expected MCP server metadata", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json"));
  assert.equal(pkg.main, "server.mjs");
  assert.equal(typeof pkg.dependencies, "object");
  assert.ok(pkg.dependencies["@modelcontextprotocol/sdk"]);
  assert.equal(pkg.bin?.["agy-connector-cc"], "server.mjs");
});
