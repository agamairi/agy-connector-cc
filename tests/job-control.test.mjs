import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  DEFAULT_MAX_PROGRESS_LINES,
  formatElapsedDuration,
  getJobTypeLabel,
  inferLegacyJobPhase,
  isProgressBlockTitle,
  matchJobReference,
  readJobProgressPreview,
  reconcileActiveJobs,
  resolveCancelableJob,
  resolveResultJob,
  stripLogPrefix,
} from "../plugins/antigravity/scripts/lib/job-control.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  saveState,
  writeJobFile,
} from "../plugins/antigravity/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/antigravity/scripts/lib/tracked-jobs.mjs";
import { makeTempDir } from "./helpers.mjs";

function withPluginData(callback) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const previousSession = process.env[SESSION_ID_ENV];
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  delete process.env[SESSION_ID_ENV];
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    if (previousSession === undefined) delete process.env[SESSION_ID_ENV];
    else process.env[SESSION_ID_ENV] = previousSession;
  }
}

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

test("reaps dead PIDs into persisted interrupted results", () =>
  withPluginData(() => {
    const cwd = makeTempDir();
    const job = {
      id: "task-dead",
      status: "running",
      startedAt: "2026-08-22T00:00:00.000Z",
      lastEventAt: "2026-08-22T00:01:00.000Z",
      pid: 54161,
      pidIdentity: "old-process",
    };
    saveState(cwd, { jobs: [job] });
    writeJobFile(cwd, job.id, job);

    const [reaped] = reconcileActiveJobs(cwd, {
      nowMs: () => Date.parse("2026-08-22T01:00:00.000Z"),
      isProcessAlive: () => false,
    });
    assert.equal(reaped.status, "interrupted");
    assert.equal(reaped.pid, null);
    assert.equal(reaped.completedAt, "2026-08-22T01:00:00.000Z");
    assert.match(reaped.errorMessage, /exited without reporting a result/i);
    assert.equal(listJobs(cwd)[0].status, "interrupted");
    assert.equal(readJobFile(resolveJobFile(cwd, job.id)).status, "interrupted");
  }));

test("status, result, cancel, and both snapshot builders automatically reap before reading", () =>
  withPluginData(() => {
    const seed = (cwd, id) => {
      const now = new Date().toISOString();
      const job = {
        id,
        status: "running",
        startedAt: now,
        lastEventAt: now,
        pid: 2_000_000_000,
        pidIdentity: "definitely-not-live",
      };
      saveState(cwd, { jobs: [job] });
      writeJobFile(cwd, id, job);
    };

    const aggregateCwd = makeTempDir();
    seed(aggregateCwd, "aggregate-dead");
    assert.equal(buildStatusSnapshot(aggregateCwd).latestFinished.status, "interrupted");

    const singleCwd = makeTempDir();
    seed(singleCwd, "single-dead");
    assert.equal(buildSingleJobSnapshot(singleCwd, "single-dead").job.status, "interrupted");

    const resultCwd = makeTempDir();
    seed(resultCwd, "result-dead");
    assert.equal(resolveResultJob(resultCwd, "result-dead").job.status, "interrupted");

    const cancelCwd = makeTempDir();
    seed(cancelCwd, "cancel-dead");
    assert.throws(() => resolveCancelableJob(cancelCwd, "cancel-dead"), /No active job found/);
    assert.equal(listJobs(cancelCwd)[0].status, "interrupted");
  }));

test("rejects a live recycled PID without signalling the unrelated process", () =>
  withPluginData(() => {
    const cwd = makeTempDir();
    saveState(cwd, {
      jobs: [
        {
          id: "task-reused",
          status: "running",
          startedAt: "2026-08-22T00:00:00.000Z",
          lastEventAt: "2026-08-22T00:04:00.000Z",
          pid: 15708,
          pidIdentity: "original-birth",
        },
      ],
    });
    let terminated = false;
    const [reaped] = reconcileActiveJobs(cwd, {
      nowMs: () => Date.parse("2026-08-22T00:05:00.000Z"),
      isProcessAlive: () => true,
      getProcessIdentity: () => "recycled-birth",
      terminateProcess: () => {
        terminated = true;
      },
    });
    assert.equal(reaped.status, "interrupted");
    assert.match(reaped.errorMessage, /PID was reused/);
    assert.equal(terminated, false);
  }));

test("terminates and persists a live job after the inactivity timeout", () =>
  withPluginData(() => {
    const cwd = makeTempDir();
    saveState(cwd, {
      jobs: [
        {
          id: "task-stalled",
          status: "running",
          startedAt: "2026-08-22T00:00:00.000Z",
          lastEventAt: "2026-08-22T00:02:00.000Z",
          pid: 65009,
          pidIdentity: "same-birth",
        },
      ],
    });
    const terminated = [];
    const [reaped] = reconcileActiveJobs(cwd, {
      nowMs: () => Date.parse("2026-08-22T00:13:00.000Z"),
      inactivityTimeout: "10m",
      isProcessAlive: () => true,
      getProcessIdentity: () => "same-birth",
      terminateProcess: (pid) => terminated.push(pid),
    });
    assert.equal(reaped.status, "stalled");
    assert.deepEqual(terminated, [65009]);
    assert.match(reaped.errorMessage, /no output for 11m 0s/i);
    assert.equal(listJobs(cwd)[0].status, "stalled");
  }));

test("reaps old PID-less records and surfaces output inactivity for healthy jobs", () =>
  withPluginData(() => {
    const cwd = makeTempDir();
    saveState(cwd, {
      jobs: [
        {
          id: "task-no-pid",
          status: "queued",
          createdAt: "2026-08-22T00:00:00.000Z",
          pid: null,
        },
      ],
    });
    const [reaped] = reconcileActiveJobs(cwd, {
      nowMs: () => Date.parse("2026-08-22T00:06:00.000Z"),
    });
    assert.equal(reaped.status, "interrupted");
    assert.match(reaped.errorMessage, /never reported a PID/);

    const recent = new Date(Date.now() - 90_000).toISOString();
    saveState(cwd, {
      jobs: [
        {
          id: "task-healthy",
          status: "running",
          startedAt: recent,
          lastEventAt: recent,
          pid: process.pid,
        },
      ],
    });
    const snapshot = buildSingleJobSnapshot(cwd, "task-healthy");
    assert.match(snapshot.job.noOutputFor, /^1m 3\ds$/);
  }));

test("keeps a long unverified-PID job alive while it continues emitting events", () =>
  withPluginData(() => {
    const cwd = makeTempDir();
    saveState(cwd, {
      jobs: [
        {
          id: "task-long-active",
          status: "running",
          startedAt: "2026-08-22T00:00:00.000Z",
          lastEventAt: "2026-08-22T02:59:30.000Z",
          pid: 4242,
          pidIdentity: null,
        },
      ],
    });
    const [job] = reconcileActiveJobs(cwd, {
      nowMs: () => Date.parse("2026-08-22T03:00:00.000Z"),
      isProcessAlive: () => true,
      getProcessIdentity: () => null,
    });
    assert.equal(job.status, "running");
  }));
