import assert from "node:assert/strict";
import fs from "node:fs";
import process from "node:process";
import test from "node:test";

import {
  createJobProgressUpdater,
  normalizeProgressEvent,
  readStoredJobOrNull,
  runTrackedJob,
} from "../plugins/antigravity/scripts/lib/tracked-jobs.mjs";
import { listJobs, readJobFile, resolveJobFile } from "../plugins/antigravity/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

async function withPluginData(callback) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

function job(workspaceRoot, id) {
  return {
    id,
    kind: "task",
    jobClass: "task",
    title: id,
    workspaceRoot,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function execution(label) {
  return {
    exitStatus: 0,
    conversationId: `conversation-${label}`,
    payload: { rawOutput: label },
    rendered: `${label}\n`,
    summary: label,
    touchedFiles: [`src/${label}.js`],
    usage: { total_tokens: 100, thinking_tokens: 10 },
  };
}

test("normalizes object and string progress events without leaking malformed fields", () => {
  assert.deepEqual(normalizeProgressEvent(" hello "), {
    message: "hello",
    phase: null,
    conversationId: null,
    stderrMessage: "hello",
    logTitle: null,
    logBody: null,
  });
  assert.deepEqual(
    normalizeProgressEvent({
      message: " Reading app.js ",
      phase: " investigating ",
      conversationId: " conversation-1 ",
      stderrMessage: null,
      logTitle: " Details ",
      logBody: "body\n",
    }),
    {
      message: "Reading app.js",
      phase: "investigating",
      conversationId: "conversation-1",
      stderrMessage: null,
      logTitle: "Details",
      logBody: "body",
    },
  );
});

test("tracked jobs persist touched files, usage, and progress identity in both records", async () => {
  await withPluginData(async () => {
    const workspace = makeTempDir();
    const current = job(workspace, "task-persist");
    const runPromise = runTrackedJob(current, async () => {
      createJobProgressUpdater(
        workspace,
        current.id,
      )({
        phase: "verifying",
        conversationId: "conversation-persist",
      });
      return execution("persist");
    });
    await runPromise;

    const summary = listJobs(workspace).find((item) => item.id === current.id);
    const stored = readJobFile(resolveJobFile(workspace, current.id));
    for (const record of [summary, stored]) {
      assert.deepEqual(record.touchedFiles, ["src/persist.js"]);
      assert.deepEqual(record.usage, { total_tokens: 100, thinking_tokens: 10 });
      assert.equal(record.conversationId, "conversation-persist");
      assert.equal(record.status, "completed");
    }
  });
});

test("two concurrent jobs in one workspace both survive state updates", async () => {
  await withPluginData(async () => {
    const workspace = makeTempDir();
    const first = runTrackedJob(job(workspace, "task-first"), async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return execution("first");
    });
    const second = runTrackedJob(job(workspace, "task-second"), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return execution("second");
    });
    await Promise.all([first, second]);
    const records = new Map(listJobs(workspace).map((item) => [item.id, item]));
    assert.equal(records.size, 2);
    assert.equal(records.get("task-first").summary, "first");
    assert.equal(records.get("task-second").summary, "second");
    assert.equal(readJobFile(resolveJobFile(workspace, "task-first")).result.rawOutput, "first");
    assert.equal(readJobFile(resolveJobFile(workspace, "task-second")).result.rawOutput, "second");
  });
});

test("concurrent jobs in two workspaces do not bleed into each other", async () => {
  await withPluginData(async () => {
    const firstWorkspace = makeTempDir();
    const secondWorkspace = makeTempDir();
    await Promise.all([
      runTrackedJob(job(firstWorkspace, "same-id"), async () => execution("first-workspace")),
      runTrackedJob(job(secondWorkspace, "same-id"), async () => execution("second-workspace")),
    ]);
    assert.deepEqual(
      listJobs(firstWorkspace).map((item) => item.summary),
      ["first-workspace"],
    );
    assert.deepEqual(
      listJobs(secondWorkspace).map((item) => item.summary),
      ["second-workspace"],
    );
  });
});

test("corrupt stored job files are treated as missing", async () => {
  await withPluginData(async () => {
    const workspace = makeTempDir();
    const file = resolveJobFile(workspace, "corrupt-job");
    fs.writeFileSync(file, "{not json");
    assert.equal(readStoredJobOrNull(workspace, "corrupt-job"), null);
  });
});
