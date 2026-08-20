import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_MAX_PROGRESS_LINES,
  formatElapsedDuration,
  getJobTypeLabel,
  inferLegacyJobPhase,
  isProgressBlockTitle,
  matchJobReference,
  readJobProgressPreview,
  stripLogPrefix,
} from "../plugins/antigravity/scripts/lib/job-control.mjs";
import { makeTempDir } from "./helpers.mjs";

test("progress previews strip timestamps, skip output block titles, and keep the newest capped lines", () => {
  const logFile = path.join(makeTempDir(), "job.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-01-01T00:00:00.000Z] Starting task.",
      "[2026-01-01T00:00:01.000Z] Reading auth.js",
      "[2026-01-01T00:00:02.000Z] Listing src/",
      '[2026-01-01T00:00:03.000Z] Searching for "TODO"',
      "[2026-01-01T00:00:04.000Z] Verifying: npm test",
      "[2026-01-01T00:00:05.000Z] Final output",
      "this unprefixed output must not leak into progress",
      "",
    ].join("\n"),
  );
  assert.deepEqual(readJobProgressPreview(logFile), [
    "Reading auth.js",
    "Listing src/",
    'Searching for "TODO"',
    "Verifying: npm test",
  ]);
  assert.equal(readJobProgressPreview(logFile).length, DEFAULT_MAX_PROGRESS_LINES);
  assert.deepEqual(readJobProgressPreview(logFile, 2), ['Searching for "TODO"', "Verifying: npm test"]);
});

test("progress preview helpers handle prefixes, empty logs, and missing files", () => {
  const empty = path.join(makeTempDir(), "empty.log");
  fs.writeFileSync(empty, "");
  assert.equal(stripLogPrefix("[timestamp]   Reading a.js "), "Reading a.js");
  assert.equal(isProgressBlockTitle("Review output"), true);
  assert.equal(isProgressBlockTitle("Subagent investigator message"), true);
  assert.equal(isProgressBlockTitle("Reading a.js"), false);
  assert.deepEqual(readJobProgressPreview(empty), []);
  assert.deepEqual(readJobProgressPreview(path.join(makeTempDir(), "missing.log")), []);
  assert.deepEqual(readJobProgressPreview(null), []);
});

test("formatElapsedDuration covers second, minute, and hour boundaries", () => {
  const start = "2026-01-01T00:00:00.000Z";
  assert.equal(formatElapsedDuration(start, "2026-01-01T00:00:59.000Z"), "59s");
  assert.equal(formatElapsedDuration(start, "2026-01-01T00:01:00.000Z"), "1m 0s");
  assert.equal(formatElapsedDuration(start, "2026-01-01T00:59:59.000Z"), "59m 59s");
  assert.equal(formatElapsedDuration(start, "2026-01-01T01:00:00.000Z"), "1h 0m");
  assert.equal(formatElapsedDuration(start, "2026-01-01T02:03:45.000Z"), "2h 3m");
  assert.equal(formatElapsedDuration("not-a-date", "2026-01-01T00:00:00.000Z"), null);
  assert.equal(formatElapsedDuration(start, "2025-12-31T23:59:59.000Z"), null);
});

test("legacy job labels and phases retain useful status semantics", () => {
  assert.equal(getJobTypeLabel({ kind: "adversarial-review" }), "adversarial-review");
  assert.equal(getJobTypeLabel({ jobClass: "review" }), "review");
  assert.equal(getJobTypeLabel({ jobClass: "task" }), "rescue");
  assert.equal(getJobTypeLabel({}), "job");
  assert.equal(
    inferLegacyJobPhase({ status: "running", jobClass: "task" }, ["Verifying: npm test"]),
    "verifying",
  );
  assert.equal(
    inferLegacyJobPhase({ status: "running", jobClass: "review" }, ["Reading auth.js"]),
    "reviewing",
  );
  assert.equal(inferLegacyJobPhase({ status: "running", jobClass: "task" }, ["Editing app.js"]), "editing");
  assert.equal(inferLegacyJobPhase({ status: "completed" }), "done");
});

test("job reference matching supports exact and unique prefixes and rejects ambiguity", () => {
  const jobs = [{ id: "task-abc" }, { id: "task-abd" }, { id: "review-xyz" }];
  assert.equal(matchJobReference(jobs, "task-abc").id, "task-abc");
  assert.equal(matchJobReference(jobs, "review").id, "review-xyz");
  assert.throws(() => matchJobReference(jobs, "task-a"), /ambiguous/);
  assert.equal(matchJobReference(jobs, "missing"), null);
});
