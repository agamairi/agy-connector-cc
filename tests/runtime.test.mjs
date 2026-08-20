import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  cleanAgyStderr,
  collectTouchedFiles,
  describeCompletedItem,
  describeStartedItem,
  looksLikeVerificationCommand,
  normalizeModel,
  parseModelsOutput,
  MAX_PROMPT_BYTES,
  parseStructuredOutput,
  runAgy,
} from "../plugins/antigravity/scripts/lib/agy.mjs";
import { fixturePath, makeTempDir } from "./helpers.mjs";

// Regression: a real review failed because agy narrates each step as agent text and appends the
// schema payload to it, so `result.response` is prose followed by JSON rather than bare JSON.
test("recovers the schema payload when agy prefixes it with step narration", () => {
  const narrated = [
    "I will start by locating the math.js file in the workspace.",
    "I will now submit the findings and complete the task.",
  ].join("\n");
  const payload = { verdict: "needs-work", summary: "s", findings: [], next_steps: [] };
  const parsed = parseStructuredOutput(`${narrated}${JSON.stringify(payload)}`);
  assert.equal(parsed.parseError, null);
  assert.deepEqual(parsed.parsed, payload);
});

test("still reports a parse error when there is no JSON object at all", () => {
  const parsed = parseStructuredOutput("no structured output here");
  assert.equal(parsed.parsed, null);
  assert.ok(parsed.parseError);
});

test("parses a fenced json block", () => {
  const parsed = parseStructuredOutput('prose\n```json\n{"verdict":"pass"}\n```');
  assert.deepEqual(parsed.parsed, { verdict: "pass" });
});
test("parses models and normalizes fast aliases", () => {
  const models = parseModelsOutput("gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n");
  assert.equal(models[0].slug, "gemini-3.7-flash-low");
  assert.equal(normalizeModel("fast", models), "gemini-3.7-flash-low");
  assert.equal(normalizeModel("Gemini 3.7 Flash (Low)", models), "gemini-3.7-flash-low");
});
test("parses the agy NDJSON runtime stream defensively", async () => {
  const result = await runAgy(makeTempDir(), {
    command: process.execPath,
    commandArgs: [fixturePath],
    prompt: "say pong",
    readOnly: true,
  });
  assert.equal(result.exitStatus, 0);
  assert.equal(result.conversationId, "fake-conversation-123");
  assert.equal(result.response, "PONG\n");
});

test("puts the prompt immediately after --print and preserves stream-json output", async () => {
  const cwd = makeTempDir();
  const argsFile = path.join(cwd, "agy-args.json");
  await runAgy(cwd, {
    command: process.execPath,
    commandArgs: [fixturePath],
    prompt: "the exact prompt",
    readOnly: true,
    env: { ...process.env, FAKE_AGY_ARGS_FILE: argsFile },
  });

  const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  const printIndex = args.indexOf("--print");
  assert.equal(args[printIndex + 1], "the exact prompt");
  assert.deepEqual(args.slice(printIndex + 2, printIndex + 4), ["--output-format", "stream-json"]);
});

test("ignores unknown events, unknown step types, and malformed NDJSON lines", async () => {
  const result = await runAgy(makeTempDir(), {
    command: process.execPath,
    commandArgs: [fixturePath],
    prompt: "say pong",
    env: { ...process.env, FAKE_AGY_SCENARIO: "unknown-events" },
  });

  assert.equal(result.exitStatus, 0);
  assert.equal(result.response, "PONG\n");
  assert.equal(
    result.events.some((event) => event.event === "mystery"),
    true,
  );
});

test("consumes a final partial NDJSON line and tolerates an ERROR result payload", async () => {
  const partial = await runAgy(makeTempDir(), {
    command: process.execPath,
    commandArgs: [fixturePath],
    prompt: "say pong",
    env: { ...process.env, FAKE_AGY_SCENARIO: "partial-ndjson" },
  });
  const failed = await runAgy(makeTempDir(), {
    command: process.execPath,
    commandArgs: [fixturePath],
    prompt: "say pong",
    env: { ...process.env, FAKE_AGY_SCENARIO: "error-result" },
  });

  assert.equal(partial.response, "PONG\n");
  assert.equal(failed.status, "ERROR");
  assert.equal(failed.exitStatus, 1);
  assert.equal(failed.error, "fixture failure");
});

// Regression: the prompt travels as one argv entry and execve caps the argument block
// (~1 MiB on macOS). An oversized prompt must fail with an explanation, not a bare E2BIG.
test("rejects a prompt larger than the argv limit with an actionable error", async () => {
  await assert.rejects(
    () =>
      runAgy(makeTempDir(), {
        command: process.execPath,
        commandArgs: [fixturePath],
        prompt: "x".repeat(MAX_PROMPT_BYTES + 1),
      }),
    /over the \d+-byte limit/,
  );
});

// Regression: chunked stdout splits multi-byte UTF-8 sequences across reads; a bare
// chunk.toString() corrupts them. StringDecoder must stitch them back together.
test("decodes multi-byte UTF-8 split across stream chunks", async () => {
  const result = await runAgy(makeTempDir(), {
    command: process.execPath,
    commandArgs: [fixturePath],
    prompt: "say pong",
    env: { ...process.env, FAKE_AGY_SCENARIO: "multibyte" },
  });
  assert.equal(result.response, "café — 日本語 ✅\n");
  assert.ok(!result.response.includes("�"), "no replacement characters");
});

// Regression: spawning with `cwd` alone is not enough. Without --add-dir, an agy write task
// fails against the real path and silently rewrites the file under ~/.gemini/.../scratch/,
// reporting success while the target repo is untouched.
test("always adds the working directory to the agy workspace", async () => {
  const cwd = makeTempDir();
  const argsFile = path.join(cwd, "agy-args.json");
  await runAgy(cwd, {
    command: process.execPath,
    commandArgs: [fixturePath],
    prompt: "edit something",
    write: true,
    env: { ...process.env, FAKE_AGY_ARGS_FILE: argsFile },
  });

  const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  const dirs = args.flatMap((arg, i) => (arg === "--add-dir" ? [args[i + 1]] : []));
  assert.ok(dirs.includes(cwd), `--add-dir ${cwd} missing from ${JSON.stringify(dirs)}`);
  assert.equal(new Set(dirs).size, dirs.length, "no duplicate --add-dir entries");
  assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), [
    "--mode",
    "accept-edits",
  ]);
});

function toolUpdate(toolName, parameters = {}, state = "ACTIVE") {
  return {
    state,
    step_type: "tool",
    tool_name: toolName,
    tool_info: { name: toolName, parameters },
  };
}

test("describes every observed read and search tool with workspace-relative paths", () => {
  const cwd = path.join(path.sep, "tmp", "reviewrepo");
  const cases = [
    ["list_dir", { DirectoryPath: cwd }, "Listing reviewrepo/"],
    ["view_file", { FilePath: path.join(cwd, "auth.js") }, "Reading auth.js"],
    ["grep_search", { Query: "TODO", SearchPath: path.join(cwd, "src") }, 'Searching for "TODO" in src'],
    ["find_by_name", { Pattern: "*.test.mjs" }, 'Finding "*.test.mjs"'],
  ];
  for (const [name, parameters, expected] of cases) {
    assert.equal(describeStartedItem(toolUpdate(name, parameters), cwd).message, expected, name);
  }
});

test("describes every observed write tool as an edit", () => {
  const cwd = path.join(path.sep, "tmp", "reviewrepo");
  for (const name of [
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "sed_file",
    "notebook_edit",
  ]) {
    const key = name === "notebook_edit" ? "NotebookPath" : "TargetFile";
    assert.equal(
      describeStartedItem(toolUpdate(name, { [key]: path.join(cwd, "src", "app.js") }), cwd).message,
      "Editing src/app.js",
      name,
    );
  }
});

test("labels verification commands, truncates long commands, and surfaces tool errors", () => {
  const cwd = makeTempDir();
  const command = `npm test ${"--verbose ".repeat(30)}`;
  const started = describeStartedItem(toolUpdate("run_command", { CommandLine: command }), cwd);
  const failed = describeCompletedItem(toolUpdate("run_command", { CommandLine: command }, "ERROR"), cwd);
  assert.equal(started.phase, "verifying");
  assert.match(started.message, /^Verifying: npm test/);
  assert.match(started.message, /\.\.\.$/);
  assert.match(failed.message, /^ERROR: Verifying:/);
  assert.equal(failed.phase, "failed");
  assert.equal(looksLikeVerificationCommand("npx tsc --noEmit"), true);
  assert.equal(looksLikeVerificationCommand("node server.mjs"), false);
});

test("truncates long paths that cannot be made workspace-relative", () => {
  const cwd = makeTempDir();
  const message = describeStartedItem(
    toolUpdate("view_file", { FilePath: path.join(path.sep, "outside", "x".repeat(180), "app.js") }),
    cwd,
  ).message;
  assert.match(message, /^Reading \/outside\//);
  assert.match(message, /\.\.\.$/);
  assert.ok(message.length <= "Reading ".length + 96);
});

test("unknown tools and known tools with missing parameters fall back without throwing", () => {
  const cwd = makeTempDir();
  assert.deepEqual(describeStartedItem(toolUpdate("future_tool"), cwd), {
    message: "future_tool",
    phase: "running",
  });
  assert.equal(describeStartedItem(toolUpdate("view_file"), cwd).message, "view_file");
  assert.equal(describeCompletedItem(toolUpdate("future_tool", {}, "DONE"), cwd).message, "future_tool");
});

test("collects deduplicated workspace-relative touched files and excludes agy brain artifacts", () => {
  const cwd = makeTempDir();
  const agyHome = path.join(makeTempDir(), ".gemini", "antigravity-cli");
  const event = (name, target, key = "TargetFile") => ({
    event: "step_update",
    step_update: toolUpdate(name, { [key]: target }, "DONE"),
  });
  const touched = collectTouchedFiles(
    [
      event("write_to_file", path.join(cwd, "src", "app.js")),
      event("replace_file_content", path.join(cwd, "src", "app.js")),
      {
        event: "step_update",
        step_update: toolUpdate(
          "multi_replace_file_content",
          {
            Replacements: [
              { TargetFile: path.join(cwd, "src", "first.js") },
              { TargetFile: path.join(cwd, "src", "second.js") },
            ],
          },
          "DONE",
        ),
      },
      event("notebook_edit", path.join(cwd, "notes.ipynb"), "NotebookPath"),
      event("write_to_file", path.join(agyHome, "abc", "read_files_plan.md")),
      event("view_file", path.join(cwd, "read-only.js"), "FilePath"),
    ],
    cwd,
    { agyHome },
  );
  assert.deepEqual(touched, [
    path.join("src", "app.js"),
    path.join("src", "first.js"),
    path.join("src", "second.js"),
    "notes.ipynb",
  ]);
});

test("realistic tool events drive progress, touched files, and captured usage", async () => {
  const cwd = makeTempDir();
  const progress = [];
  const result = await runAgy(cwd, {
    command: process.execPath,
    commandArgs: [fixturePath],
    prompt: "inspect and edit",
    env: { ...process.env, FAKE_AGY_SCENARIO: "tool-events" },
    onProgress: (event) => progress.push(event),
  });
  assert.ok(progress.some((event) => event.message === `Listing ${path.basename(cwd)}/`));
  assert.ok(progress.some((event) => event.message === "Reading auth.js"));
  assert.ok(progress.some((event) => event.message === "Editing src/app.js"));
  assert.ok(progress.some((event) => event.phase === "verifying"));
  assert.ok(progress.some((event) => event.message === "ERROR: unknown_tool"));
  assert.deepEqual(result.touchedFiles, [
    path.join("src", "app.js"),
    path.join("src", "config.js"),
    path.join("src", "routes.js"),
    "analysis.ipynb",
  ]);
  assert.equal(result.usage.total_tokens, 24670);
  assert.equal(result.usage.thinking_tokens, 425);
});

test("usage tolerates absent and partial result objects", async () => {
  const runScenario = (scenario) =>
    runAgy(makeTempDir(), {
      command: process.execPath,
      commandArgs: [fixturePath],
      prompt: "usage",
      env: { ...process.env, FAKE_AGY_SCENARIO: scenario },
    });
  assert.equal((await runScenario("no-usage")).usage, null);
  assert.deepEqual((await runScenario("partial-usage")).usage, { thinking_tokens: 7 });
});

test("cleans agy diagnostics while preserving genuine stderr errors", async () => {
  const noisy = [
    "INFO Loading Antigravity runtime",
    "Using model gemini-3.7-flash-low",
    '{"event":"step_update","step_update":{"state":"ACTIVE"}}',
    "Loading configuration failed: invalid syntax",
    "Permission denied while opening protected.txt",
  ].join("\n");
  assert.equal(
    cleanAgyStderr(noisy),
    "Loading configuration failed: invalid syntax\nPermission denied while opening protected.txt",
  );

  const result = await runAgy(makeTempDir(), {
    command: process.execPath,
    commandArgs: [fixturePath],
    prompt: "stderr",
    env: { ...process.env, FAKE_AGY_SCENARIO: "stderr-noise" },
  });
  assert.equal(result.stderr, "Permission denied while opening protected.txt");

  const failed = await runAgy(makeTempDir(), {
    command: process.execPath,
    commandArgs: [fixturePath],
    prompt: "stderr failure",
    env: { ...process.env, FAKE_AGY_SCENARIO: "stderr-failure" },
  });
  assert.equal(failed.exitStatus, 1);
  assert.equal(failed.error, "Permission denied while opening protected.txt");
});

// Regression: verified against agy 1.1.15 — view_file passes AbsolutePath and find_by_name passes
// SearchDirectory. Both were missing from the parameter lookup, so their progress lines rendered
// as bare tool names with no file or directory.
test("describes view_file and find_by_name using the parameter names agy actually sends", () => {
  const cwd = "/repo";
  const view = describeStartedItem(
    {
      tool_name: "view_file",
      tool_info: { name: "view_file", parameters: { AbsolutePath: "/repo/auth.js" } },
    },
    cwd,
  );
  assert.equal(view.message, "Reading auth.js");

  const find = describeStartedItem(
    {
      tool_name: "find_by_name",
      tool_info: { name: "find_by_name", parameters: { Pattern: "*.js", SearchDirectory: "/repo/src" } },
    },
    cwd,
  );
  assert.match(find.message, /\*\.js/);
});
