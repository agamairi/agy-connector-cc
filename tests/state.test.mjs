import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst,
} from "../plugins/antigravity/scripts/lib/job-control.mjs";
import {
  listJobs,
  resolveStateDir,
  saveState,
  upsertJob,
} from "../plugins/antigravity/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/antigravity/scripts/lib/tracked-jobs.mjs";
import { makeTempDir } from "./helpers.mjs";

function withPluginData(callback) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const previousSessionId = process.env[SESSION_ID_ENV];
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  delete process.env[SESSION_ID_ENV];
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    if (previousSessionId === undefined) delete process.env[SESSION_ID_ENV];
    else process.env[SESSION_ID_ENV] = previousSessionId;
  }
}

test("stores jobs in workspace-scoped state directories", () =>
  withPluginData(() => {
    const first = makeTempDir();
    const second = makeTempDir();
    upsertJob(first, { id: "first-job", status: "completed" });

    assert.equal(listJobs(first)[0].id, "first-job");
    assert.deepEqual(listJobs(second), []);
    assert.notEqual(resolveStateDir(first), resolveStateDir(second));
  }));

test("caps persisted job history at fifty newest records", () =>
  withPluginData(() => {
    const cwd = makeTempDir();
    const jobs = Array.from({ length: 51 }, (_, index) => ({
      id: `job-${index}`,
      status: "completed",
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString(),
    }));

    saveState(cwd, { jobs });
    const persisted = listJobs(cwd);
    assert.equal(persisted.length, 50);
    assert.equal(persisted[0].id, "job-50");
    assert.equal(persisted.at(-1).id, "job-1");
  }));

test("sorts jobs newest first and resolves the latest result when no id is given", () =>
  withPluginData(() => {
    const cwd = makeTempDir();
    saveState(cwd, {
      jobs: [
        { id: "old", status: "completed", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "new", status: "failed", updatedAt: "2026-01-02T00:00:00.000Z" },
      ],
    });

    assert.deepEqual(
      sortJobsNewestFirst(listJobs(cwd)).map((job) => job.id),
      ["new", "old"],
    );
    assert.equal(resolveResultJob(cwd).job.id, "new");
  }));

test("requires a job id when multiple jobs are active", () =>
  withPluginData(() => {
    const cwd = makeTempDir();
    saveState(cwd, {
      jobs: [
        { id: "old-running", status: "running", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "new-queued", status: "queued", updatedAt: "2026-01-02T00:00:00.000Z" },
      ],
    });

    assert.throws(() => resolveCancelableJob(cwd), /Multiple Antigravity jobs are active/);
  }));
