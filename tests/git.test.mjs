import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  capReviewContent,
  collectReviewContext,
  resolveReviewTarget,
} from "../plugins/antigravity/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function commitInitialFile(cwd) {
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "initial"], { cwd });
}

test("resolves a working-tree review by default", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitialFile(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");

  assert.deepEqual(resolveReviewTarget(cwd), {
    mode: "working-tree",
    label: "working tree diff",
    explicit: false,
  });
});

test("uses a branch scope when --base is supplied", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitialFile(cwd);

  assert.deepEqual(resolveReviewTarget(cwd, { base: "main" }), {
    mode: "branch",
    baseRef: "main",
    label: "branch diff against main",
    explicit: true,
  });
});

test("counts untracked files as reviewable working-tree content", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitialFile(cwd);
  fs.writeFileSync(path.join(cwd, "new-risk.js"), "export const risky = true;\n");

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd));
  assert.equal(context.fileCount, 1);
  assert.deepEqual(context.changedFiles, ["new-risk.js"]);
  assert.match(context.content, /new-risk\.js/);
});

test("reports an empty review context when there is nothing to review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitialFile(cwd);

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd));
  assert.equal(context.fileCount, 0);
  assert.deepEqual(context.changedFiles, []);
});

// Regression: an uncapped branch diff overflows the argv limit and the spawn dies with E2BIG.
test("caps oversized review content and flags the truncation in-band", () => {
  const small = capReviewContent("short diff", 1024);
  assert.equal(small.truncated, false);
  assert.equal(small.content, "short diff");

  const big = capReviewContent("x".repeat(5000), 1024);
  assert.equal(big.truncated, true);
  assert.ok(Buffer.byteLength(big.content, "utf8") < 5000);
  assert.match(big.content, /TRUNCATED: \d+ more bytes/);
});

test("never splits a multi-byte character when truncating", () => {
  // 1000 three-byte characters, cut at a byte count that lands mid-sequence.
  const { content } = capReviewContent("日".repeat(1000), 1000);
  assert.ok(!content.split("[TRUNCATED")[0].includes("\uFFFD"), "no replacement char at the cut");
});
