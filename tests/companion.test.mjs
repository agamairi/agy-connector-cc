import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  resolveJobFile,
  resolveJobLogFile,
  resolveStateFile,
  upsertJob,
} from "../plugins/antigravity/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/antigravity/scripts/lib/tracked-jobs.mjs";
import { fixturePath, initGitRepo, makeTempDir, run } from "./helpers.mjs";

const companionScript = path.resolve("plugins/antigravity/scripts/agy-companion.mjs");

function installFakeAgy(binDir) {
  const executable = path.join(binDir, "agy");
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} "$@"\n`,
    { mode: 0o755 },
  );
}

function fixtureEnvironment(pluginData, binDir, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    CLAUDE_PLUGIN_DATA: pluginData,
    ...extra,
  };
  if (!Object.hasOwn(extra, SESSION_ID_ENV)) delete env[SESSION_ID_ENV];
  return env;
}

function runCompanion(args, options) {
  return run(process.execPath, [companionScript, ...args], {
    cwd: options.cwd,
    env: fixtureEnvironment(options.pluginData, options.binDir, options.env),
    input: options.input,
  });
}

function parseJsonResult(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  return JSON.parse(result.stdout);
}

function assertCleanError(result, pattern) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  assert.doesNotMatch(result.stderr, /\n\s+at\s|Error:\s/);
}

function makeRepository() {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "initial"], { cwd });
  return cwd;
}

function makeFeatureRepository() {
  const cwd = makeRepository();
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });
  return cwd;
}

function withStateEnvironment(pluginData, sessionId, callback) {
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  const previousSession = process.env[SESSION_ID_ENV];
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  if (sessionId) process.env[SESSION_ID_ENV] = sessionId;
  else delete process.env[SESSION_ID_ENV];
  try {
    return callback();
  } finally {
    if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousData;
    if (previousSession === undefined) delete process.env[SESSION_ID_ENV];
    else process.env[SESSION_ID_ENV] = previousSession;
  }
}

test("adversarial-review preserves trailing focus and plain review rejects it", () => {
  const cwd = makeRepository();
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 3;\n");
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  const argsFile = path.join(makeTempDir(), "agy-args.json");
  installFakeAgy(binDir);

  const adversarial = runCompanion(
    ["adversarial-review", "--json", "--scope", "working-tree", "challenge", "retry", "design"],
    {
      cwd,
      pluginData,
      binDir,
      env: { FAKE_AGY_ARGS_FILE: argsFile },
    },
  );
  const payload = parseJsonResult(adversarial);
  const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  const prompt = args[args.indexOf("--print") + 1];
  assert.equal(payload.review, "Adversarial Review");
  assert.match(prompt, /User focus: challenge retry design/);

  const plain = runCompanion(["review", "--scope", "working-tree", "focus", "here"], {
    cwd,
    pluginData,
    binDir,
  });
  assertCleanError(plain, /does not accept focus text/);
});

test("review selects --base and every supported scope like the reference", () => {
  const dirty = makeRepository();
  fs.writeFileSync(path.join(dirty, "app.js"), "export const value = 4;\n");
  const cleanFeature = makeFeatureRepository();
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir);

  const base = parseJsonResult(
    runCompanion(["review", "--json", "--base", "main"], { cwd: dirty, pluginData, binDir }),
  );
  assert.equal(base.target.mode, "branch");
  assert.equal(base.target.baseRef, "main");

  const workingTree = parseJsonResult(
    runCompanion(["review", "--json", "--scope", "working-tree"], {
      cwd: dirty,
      pluginData,
      binDir,
    }),
  );
  assert.equal(workingTree.target.mode, "working-tree");

  const autoDirty = parseJsonResult(
    runCompanion(["review", "--json", "--scope", "auto"], { cwd: dirty, pluginData, binDir }),
  );
  assert.equal(autoDirty.target.mode, "working-tree");

  const branch = parseJsonResult(
    runCompanion(["review", "--json", "--scope", "branch"], {
      cwd: cleanFeature,
      pluginData,
      binDir,
    }),
  );
  assert.equal(branch.target.mode, "branch");
  assert.equal(branch.target.baseRef, "main");

  const autoClean = parseJsonResult(
    runCompanion(["review", "--json", "--scope", "auto"], {
      cwd: cleanFeature,
      pluginData,
      binDir,
    }),
  );
  assert.equal(autoClean.target.mode, "branch");
});

test("task --resume and --fresh route conversations and reject invalid resume requests", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  const argsFile = path.join(makeTempDir(), "agy-args.json");
  const sessionEnv = { [SESSION_ID_ENV]: "session-task", FAKE_AGY_ARGS_FILE: argsFile };
  installFakeAgy(binDir);

  parseJsonResult(
    runCompanion(["task", "--json", "initial", "task"], {
      cwd,
      pluginData,
      binDir,
      env: sessionEnv,
    }),
  );
  parseJsonResult(
    runCompanion(["task", "--json", "--resume", "continue"], {
      cwd,
      pluginData,
      binDir,
      env: sessionEnv,
    }),
  );
  let args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  assert.deepEqual(args.slice(args.indexOf("--conversation"), args.indexOf("--conversation") + 2), [
    "--conversation",
    "fake-conversation-123",
  ]);

  parseJsonResult(
    runCompanion(["task", "--json", "--fresh", "start", "over"], {
      cwd,
      pluginData,
      binDir,
      env: sessionEnv,
    }),
  );
  args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  assert.equal(args.includes("--conversation"), false);

  const emptyRepo = makeRepository();
  const noPrior = runCompanion(["task", "--resume", "--json"], {
    cwd: emptyRepo,
    pluginData: makeTempDir(),
    binDir,
    env: { [SESSION_ID_ENV]: "session-empty" },
  });
  assertCleanError(noPrior, /No previous Antigravity task conversation was found/);

  const mutuallyExclusive = runCompanion(["task", "--resume", "--fresh", "continue"], {
    cwd,
    pluginData,
    binDir,
  });
  assertCleanError(mutuallyExclusive, /Choose either --resume\/--resume-last or --fresh/);
});

test("setup toggles the review gate and rejects conflicting switches", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir);

  const enabled = parseJsonResult(
    runCompanion(["setup", "--json", "--enable-review-gate"], { cwd, pluginData, binDir }),
  );
  assert.equal(enabled.reviewGateEnabled, true);
  assert.match(enabled.actionsTaken[0], /Enabled/);

  const disabled = parseJsonResult(
    runCompanion(["setup", "--json", "--disable-review-gate"], { cwd, pluginData, binDir }),
  );
  assert.equal(disabled.reviewGateEnabled, false);
  assert.match(disabled.actionsTaken[0], /Disabled/);

  const conflict = runCompanion(["setup", "--enable-review-gate", "--disable-review-gate"], {
    cwd,
    pluginData,
    binDir,
  });
  assertCleanError(conflict, /Choose either --enable-review-gate or --disable-review-gate/);
});

test("CLI error paths are non-zero, clear, and never print stack traces", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir);

  const notGit = runCompanion(["review", "--scope", "working-tree"], {
    cwd: makeTempDir(),
    pluginData,
    binDir,
  });
  assertCleanError(notGit, /must run inside a Git repository/);

  const unknownResult = runCompanion(["result", "missing-job"], { cwd, pluginData, binDir });
  assertCleanError(unknownResult, /No finished job found for "missing-job"/);

  const unknownCancel = runCompanion(["cancel", "missing-job"], { cwd, pluginData, binDir });
  assertCleanError(unknownCancel, /No active job found for "missing-job"/);

  const invalidEffort = runCompanion(["task", "--effort", "extreme", "investigate"], {
    cwd,
    pluginData,
    binDir,
  });
  assertCleanError(invalidEffort, /Unsupported reasoning effort "extreme"/);

  const unknownCommand = runCompanion(["something-else"], { cwd, pluginData, binDir });
  assertCleanError(unknownCommand, /Unknown subcommand: something-else/);
});

test("every JSON-capable subcommand emits valid JSON with its documented keys", () => {
  const cwd = makeRepository();
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 5;\n");
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  const sessionId = "session-json";
  const env = { [SESSION_ID_ENV]: sessionId };
  installFakeAgy(binDir);

  const setup = parseJsonResult(runCompanion(["setup", "--json"], { cwd, pluginData, binDir, env }));
  for (const key of ["ready", "node", "agy", "models", "reviewGateEnabled", "actionsTaken", "nextSteps"]) {
    assert.ok(Object.hasOwn(setup, key), `setup.${key}`);
  }

  const review = parseJsonResult(
    runCompanion(["review", "--json", "--scope", "working-tree"], {
      cwd,
      pluginData,
      binDir,
      env,
    }),
  );
  for (const key of ["review", "target", "context", "agy", "result", "rawOutput", "parseError"]) {
    assert.ok(Object.hasOwn(review, key), `review.${key}`);
  }

  const adversarial = parseJsonResult(
    runCompanion(["adversarial-review", "--json", "--scope", "working-tree", "focus"], {
      cwd,
      pluginData,
      binDir,
      env,
    }),
  );
  assert.ok(Object.hasOwn(adversarial, "review"));
  assert.ok(Object.hasOwn(adversarial, "result"));

  const taskPayload = parseJsonResult(
    runCompanion(["task", "--json", "inspect"], { cwd, pluginData, binDir, env }),
  );
  for (const key of ["status", "conversationId", "rawOutput", "agy"]) {
    assert.ok(Object.hasOwn(taskPayload, key), `task.${key}`);
  }
  assert.deepEqual(taskPayload.agy.touchedFiles, []);
  assert.equal(taskPayload.agy.usage.total_tokens, 24670);

  const testHome = makeTempDir();
  const transcriptDir = path.join(testHome, ".claude", "projects", "json-test");
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcript = path.join(transcriptDir, "session.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`);
  const transfer = parseJsonResult(
    runCompanion(["transfer", "--json", "--source", transcript], {
      cwd,
      pluginData,
      binDir,
      env: { ...env, HOME: testHome },
    }),
  );
  for (const key of ["conversationId", "sourcePath", "resumeCommand"]) {
    assert.ok(Object.hasOwn(transfer, key), `transfer.${key}`);
  }

  const status = parseJsonResult(runCompanion(["status", "--json"], { cwd, pluginData, binDir, env }));
  for (const key of [
    "workspaceRoot",
    "config",
    "sessionRuntime",
    "running",
    "latestFinished",
    "recent",
    "needsReview",
  ]) {
    assert.ok(Object.hasOwn(status, key), `status.${key}`);
  }

  const resultPayload = parseJsonResult(runCompanion(["result", "--json"], { cwd, pluginData, binDir, env }));
  assert.ok(Object.hasOwn(resultPayload, "job"));
  assert.ok(Object.hasOwn(resultPayload, "storedJob"));
  assert.deepEqual(resultPayload.job.touchedFiles, []);
  assert.equal(resultPayload.job.usage.total_tokens, 24670);
  assert.deepEqual(resultPayload.storedJob.touchedFiles, []);
  assert.equal(resultPayload.storedJob.usage.thinking_tokens, 425);

  const renderedResult = runCompanion(["result", resultPayload.job.id], { cwd, pluginData, binDir, env });
  assert.equal(renderedResult.status, 0, renderedResult.stderr);
  assert.match(renderedResult.stdout, /Files changed: no files modified/);
  assert.match(renderedResult.stdout, /Tokens: 24,670 total tokens \(425 thinking\)/);

  const renderedStatus = runCompanion(["status", resultPayload.job.id], { cwd, pluginData, binDir, env });
  assert.equal(renderedStatus.status, 0, renderedStatus.stderr);
  assert.match(renderedStatus.stdout, /Files changed: no files modified/);
  assert.match(renderedStatus.stdout, /Tokens: 24,670 total tokens \(425 thinking\)/);

  const waited = parseJsonResult(
    runCompanion(["status", resultPayload.job.id, "--wait", "--timeout-ms", "10", "--json"], {
      cwd,
      pluginData,
      binDir,
      env,
    }),
  );
  assert.equal(waited.waitTimedOut, false);
  assert.equal(waited.timeoutMs, 10);

  const candidate = parseJsonResult(
    runCompanion(["task-resume-candidate", "--json"], { cwd, pluginData, binDir, env }),
  );
  for (const key of ["available", "sessionId", "candidate"]) {
    assert.ok(Object.hasOwn(candidate, key), `task-resume-candidate.${key}`);
  }

  withStateEnvironment(pluginData, sessionId, () => {
    upsertJob(cwd, {
      id: "cancel-json",
      status: "running",
      jobClass: "task",
      title: "Cancelable fixture",
      sessionId,
      pid: null,
    });
  });
  const cancelled = parseJsonResult(
    runCompanion(["cancel", "cancel-json", "--json"], { cwd, pluginData, binDir, env }),
  );
  for (const key of ["jobId", "status", "title"]) {
    assert.ok(Object.hasOwn(cancelled, key), `cancel.${key}`);
  }
});

test("status and result survive corrupt state and corrupt per-job files", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir);

  withStateEnvironment(pluginData, null, () => {
    upsertJob(cwd, {
      id: "corrupt-stored-job",
      status: "completed",
      jobClass: "task",
      title: "Legacy task",
      write: false,
      summary: "state summary survives",
    });
    fs.writeFileSync(resolveJobFile(cwd, "corrupt-stored-job"), "{not json");
  });

  const statusWithCorruptJob = runCompanion(["status", "corrupt-stored-job", "--json"], {
    cwd,
    pluginData,
    binDir,
  });
  assert.equal(statusWithCorruptJob.status, 0, statusWithCorruptJob.stderr);
  assert.equal(JSON.parse(statusWithCorruptJob.stdout).job.summary, "state summary survives");

  const resultWithCorruptJob = runCompanion(["result", "corrupt-stored-job"], {
    cwd,
    pluginData,
    binDir,
  });
  assert.equal(resultWithCorruptJob.status, 0, resultWithCorruptJob.stderr);
  assert.match(resultWithCorruptJob.stdout, /state summary survives/);
  assert.match(resultWithCorruptJob.stdout, /No captured result payload/);

  withStateEnvironment(pluginData, null, () => {
    const stateFile = resolveStateFile(cwd);
    fs.writeFileSync(stateFile, "{broken state");
  });
  const statusWithCorruptState = runCompanion(["status", "--json"], { cwd, pluginData, binDir });
  assert.equal(statusWithCorruptState.status, 0, statusWithCorruptState.stderr);
  assert.deepEqual(JSON.parse(statusWithCorruptState.stdout).running, []);

  const resultWithCorruptState = runCompanion(["result"], { cwd, pluginData, binDir });
  assertCleanError(resultWithCorruptState, /No finished Antigravity jobs/);

  withStateEnvironment(pluginData, null, () => {
    fs.writeFileSync(
      resolveStateFile(cwd),
      JSON.stringify({ jobs: [null, {}, { id: "partial-job", status: "completed" }] }),
    );
  });
  const partial = parseJsonResult(
    runCompanion(["status", "partial-job", "--json"], { cwd, pluginData, binDir }),
  );
  assert.equal(partial.job.id, "partial-job");
  assert.equal(partial.job.kindLabel, "job");
});

test("write-capable tool events persist user files but exclude agy brain artifacts", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  const env = { FAKE_AGY_SCENARIO: "tool-events" };
  installFakeAgy(binDir);

  const task = parseJsonResult(
    runCompanion(["task", "--write", "--json", "edit", "the", "fixture"], {
      cwd,
      pluginData,
      binDir,
      env,
    }),
  );
  assert.deepEqual(task.agy.touchedFiles, [
    path.join("src", "app.js"),
    path.join("src", "config.js"),
    path.join("src", "routes.js"),
    "analysis.ipynb",
  ]);
  assert.equal(
    task.agy.touchedFiles.some((file) => file.includes("antigravity-cli/brain")),
    false,
  );

  const result = parseJsonResult(runCompanion(["result", "--json"], { cwd, pluginData, binDir, env }));
  assert.deepEqual(result.job.touchedFiles, task.agy.touchedFiles);
  assert.deepEqual(result.storedJob.touchedFiles, task.agy.touchedFiles);
  assert.equal(result.storedJob.usage.total_tokens, 24670);

  const rendered = runCompanion(["result", result.job.id], { cwd, pluginData, binDir, env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(
    rendered.stdout,
    /Files changed: src\/app\.js, src\/config\.js, src\/routes\.js, analysis\.ipynb/,
  );
  assert.doesNotMatch(rendered.stdout, /antigravity-cli\/brain/);
});

test("single-job status shows the latest running progress without final-output blocks", () => {
  const cwd = makeRepository();
  const pluginData = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir);
  withStateEnvironment(pluginData, null, () => {
    const logFile = resolveJobLogFile(cwd, "running-preview");
    fs.writeFileSync(
      logFile,
      [
        "[2026-01-01T00:00:00.000Z] obsolete line",
        "[2026-01-01T00:00:01.000Z] Reading auth.js",
        "[2026-01-01T00:00:02.000Z] Listing src/",
        '[2026-01-01T00:00:03.000Z] Searching for "TODO"',
        "[2026-01-01T00:00:04.000Z] Verifying: npm test",
        "[2026-01-01T00:00:05.000Z] Final output",
        "unprefixed final text",
      ].join("\n"),
    );
    upsertJob(cwd, {
      id: "running-preview",
      status: "running",
      jobClass: "task",
      title: "Preview fixture",
      logFile,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  const status = runCompanion(["status", "running-preview"], { cwd, pluginData, binDir });
  assert.equal(status.status, 0, status.stderr);
  for (const line of ["Reading auth.js", "Listing src/", 'Searching for "TODO"', "Verifying: npm test"])
    assert.ok(status.stdout.includes(line), line);
  assert.doesNotMatch(status.stdout, /obsolete line|Final output|unprefixed final text/);
});
