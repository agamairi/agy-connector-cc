import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
test("package is private and has no runtime dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
});
