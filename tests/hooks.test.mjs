import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { TRANSCRIPT_PATH_ENV } from "../plugins/antigravity/scripts/lib/claude-session-transfer.mjs";
import { listJobs, setConfig, upsertJob } from "../plugins/antigravity/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/antigravity/scripts/lib/tracked-jobs.mjs";
import { fixturePath, initGitRepo, makeTempDir, run } from "./helpers.mjs";

const pluginRoot = path.resolve("plugins/antigravity");
const companionScript = path.join(pluginRoot, "scripts", "agy-companion.mjs");
const sessionHook = path.join(pluginRoot, "scripts", "session-lifecycle-hook.mjs");
const stopHook = path.join(pluginRoot, "scripts", "stop-review-gate-hook.mjs");

function installFakeAgy(binDir) {
  const executable = path.join(binDir, "agy");
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} \"$@\"\n`,
    {
      mode: 0o755,
    },
  );
}

function hookEnv(pluginData, binDir = null, extra = {}) {
  return {
    ...process.env,
    ...(binDir ? { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } : {}),
    CLAUDE_PLUGIN_DATA: pluginData,
    ...extra,
  };
}

function makeRepository() {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "# test\n");
  run("git", ["add", "README.md"], { cwd });
  run("git", ["commit", "-m", "initial"], { cwd });
  return cwd;
}

test("stop gate blocks fixture findings when enabled", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    setConfig(cwd, "stopReviewGate", true);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }

  const result = run(process.execPath, [stopHook], {
    cwd,
    env: hookEnv(pluginData, binDir, { FAKE_AGY_SCENARIO: "findings" }),
    input: JSON.stringify({ cwd, session_id: "session-a", last_assistant_message: "I changed the parser." }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    decision: "block",
    reason: "Antigravity review gate found 1 issue(s).",
  });
});

test("stop gate stays silent when the enabled review returns no findings", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    setConfig(cwd, "stopReviewGate", true);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }

  const result = run(process.execPath, [stopHook], {
    cwd,
    env: hookEnv(pluginData, binDir),
    input: JSON.stringify({ cwd, session_id: "session-clean", last_assistant_message: "No changes." }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("stop gate logs the current running task but does not block when disabled", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    upsertJob(cwd, { id: "task-live", status: "running", sessionId: "session-a" });
    upsertJob(cwd, { id: "task-other", status: "running", sessionId: "session-b" });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }

  const result = run(process.execPath, [stopHook], {
    cwd,
    env: hookEnv(pluginData),
    input: JSON.stringify({ cwd, session_id: "session-a" }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /task-live is still running/);
  assert.doesNotMatch(result.stderr, /task-other/);
});

test("stop gate skips safely when Antigravity is not ready", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const emptyPath = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    setConfig(cwd, "stopReviewGate", true);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }

  const result = run(process.execPath, [stopHook], {
    cwd,
    env: hookEnv(pluginData, null, { PATH: emptyPath }),
    input: JSON.stringify({ cwd }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Antigravity is not set up for the review gate/);
});

test("stop gate skips safely when an otherwise available CLI returns an error", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    setConfig(cwd, "stopReviewGate", true);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }

  const result = run(process.execPath, [stopHook], {
    cwd,
    env: hookEnv(pluginData, binDir, { FAKE_AGY_SCENARIO: "error-result" }),
    input: JSON.stringify({ cwd }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Antigravity review gate skipped:.*fixture failure/);
});

test("session start persists the transcript path and transfer consumes it", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env");
  // transfer only accepts transcripts under ~/.claude/projects, so the fixture has to live
  // there too rather than in a temp dir.
  const testHome = makeTempDir();
  const projectsRoot = path.join(testHome, ".claude", "projects");
  fs.mkdirSync(projectsRoot, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(projectsRoot, "agy-hooks-test-"));
  try {
    const transcript = path.join(projectDir, "session.jsonl");
    installFakeAgy(binDir);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`);

    const sessionStart = run(process.execPath, [sessionHook, "SessionStart"], {
      cwd,
      env: hookEnv(pluginData, binDir, { CLAUDE_ENV_FILE: envFile, HOME: testHome }),
      input: JSON.stringify({ cwd, session_id: "session-a", transcript_path: transcript }),
    });
    const persisted = fs.readFileSync(envFile, "utf8");
    assert.equal(sessionStart.status, 0, sessionStart.stderr);
    assert.match(persisted, new RegExp(`export ${SESSION_ID_ENV}='session-a'`));
    assert.match(persisted, new RegExp(`export ${TRANSCRIPT_PATH_ENV}='${transcript}'`));

    const transfer = run(process.execPath, [companionScript, "transfer", "--json"], {
      cwd,
      env: hookEnv(pluginData, binDir, { HOME: testHome, [TRANSCRIPT_PATH_ENV]: transcript }),
    });
    assert.equal(transfer.status, 0, transfer.stderr);
    assert.equal(JSON.parse(transfer.stdout).sourcePath, fs.realpathSync(transcript));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("session end removes jobs that belong to the ending session only", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    upsertJob(cwd, { id: "ending", status: "completed", sessionId: "session-a" });
    upsertJob(cwd, { id: "remaining", status: "completed", sessionId: "session-b" });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }

  const result = run(process.execPath, [sessionHook, "SessionEnd"], {
    cwd,
    env: hookEnv(pluginData),
    input: JSON.stringify({ cwd, session_id: "session-a" }),
  });
  assert.equal(result.status, 0, result.stderr);

  const priorData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    assert.deepEqual(
      listJobs(cwd).map((job) => job.id),
      ["remaining"],
    );
  } finally {
    if (priorData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = priorData;
  }
});
