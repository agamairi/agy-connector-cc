#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_AGY_SCENARIO ?? "success";

if (process.env.FAKE_AGY_ARGS_FILE) {
  await import("node:fs").then(({ writeFileSync }) => {
    writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(args));
  });
}

if (args.includes("--version")) {
  console.log("1.1.18");
  process.exit(0);
}
if (args[0] === "models") {
  console.log(
    [
      "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
      "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
      "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
      "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    ].join("\n"),
  );
  process.exit(0);
}
// Mirror the real CLI: `--print` takes the very next argv entry as the prompt.
// Reading `args.at(-1)` instead would let an arg-ordering bug pass the suite, which is
// exactly how the "prompt appended last" regression slipped through once already.
const printIndex = args.findIndex((arg) => arg === "--print" || arg === "-p" || arg === "--prompt");
const prompt = printIndex >= 0 ? (args[printIndex + 1] ?? "") : "";
if (prompt.startsWith("--")) {
  console.error(`fake-agy: --print swallowed a flag as its prompt: ${prompt}`);
  process.exit(2);
}
const id = "fake-conversation-123";
const modelIndex = args.indexOf("--model");
const selectedModel = modelIndex >= 0 ? args[modelIndex + 1] : "fixture-unset-model";

if (scenario === "silent") {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  process.exit(0);
}

if (scenario === "stderr-noise" || scenario === "stderr-failure") {
  console.error("INFO Loading Antigravity runtime");
  console.error("Using model gemini-3.7-flash-low");
  console.error("Permission denied while opening protected.txt");
}

if (scenario === "multibyte") {
  // Emit the stream one byte at a time so every multi-byte UTF-8 sequence is guaranteed to be
  // split across chunk boundaries. A reader using chunk.toString() mangles these into U+FFFD.
  const text = "café — 日本語 ✅\n";
  const payload =
    JSON.stringify({
      event: "init",
      conversation_id: id,
      init: { model: selectedModel, cwd: process.cwd() },
    }) +
    "\n" +
    JSON.stringify({
      event: "result",
      result: { conversation_id: id, status: "SUCCESS", response: text, num_turns: 1 },
    }) +
    "\n";
  const buffer = Buffer.from(payload, "utf8");
  for (const byte of buffer) process.stdout.write(Buffer.from([byte]));
  process.exit(0);
}
if (scenario === "unknown-events") {
  console.log(JSON.stringify({ event: "mystery", payload: { ignored: true } }));
  console.log(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: id,
        step_type: "custom_step_type",
        state: "RUNNING",
        text_delta: "PONG\\n",
      },
    }),
  );
  console.log("{not-json");
}
console.log(
  JSON.stringify({
    event: "init",
    conversation_id: id,
    init: { model: selectedModel, cwd: process.cwd() },
  }),
);
if (scenario === "quota-error") {
  const error =
    "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 29h49m43s.";
  console.log(
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: id,
        model: selectedModel,
        status: "ERROR",
        response: "",
        error,
        duration_seconds: 0.1,
        num_turns: 0,
      },
    }),
  );
  process.exit(0);
}
if (scenario === "tool-events") {
  const toolEvents = [
    ["list_dir", { DirectoryPath: process.cwd() }],
    ["view_file", { FilePath: `${process.cwd()}/auth.js` }],
    ["grep_search", { Query: "TODO", SearchPath: process.cwd() }],
    ["find_by_name", { Pattern: "*.test.mjs" }],
    ["run_command", { CommandLine: `npm test ${"--verbose ".repeat(20)}` }],
    ["write_to_file", { TargetFile: `${process.cwd()}/src/app.js` }],
    ["replace_file_content", { TargetFile: `${process.cwd()}/src/app.js` }],
    ["multi_replace_file_content", { TargetFile: `${process.cwd()}/src/config.js` }],
    ["sed_file", { TargetFile: `${process.cwd()}/src/routes.js` }],
    ["notebook_edit", { NotebookPath: `${process.cwd()}/analysis.ipynb` }],
    [
      "write_to_file",
      {
        TargetFile: `${process.env.HOME}/.gemini/antigravity-cli/brain/${id}/read_files_plan.md`,
      },
    ],
  ];
  let stepIndex = 3;
  for (const [toolName, parameters] of toolEvents) {
    for (const state of ["ACTIVE", "DONE"]) {
      console.log(
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: id,
            step_index: stepIndex,
            state,
            step_type: "tool",
            tool_name: toolName,
            tool_info: { name: toolName, parameters },
          },
        }),
      );
    }
    stepIndex += 1;
  }
  console.log(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: id,
        step_index: stepIndex,
        state: "ERROR",
        step_type: "tool",
        tool_name: "unknown_tool",
        tool_info: { name: "unknown_tool", parameters: {} },
      },
    }),
  );
}
if (scenario === "shell-write") {
  // This mirrors agy's run_command path: the filesystem changes have no editor-tool metadata.
  fs.writeFileSync(path.join(process.cwd(), "app.js"), "export const value = 'written by shell';\n");
  fs.writeFileSync(path.join(process.cwd(), "note-b.txt"), "SHELL_TOOL_TEST\n");
  console.log(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: id,
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "sed -i … app.js && printf … > note-b.txt" },
        },
      },
    }),
  );
}
console.log(
  JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: id,
      step_index: 2,
      state: "DONE",
      step_type: "agent_response",
      text_delta:
        prompt.includes("JSON") || scenario === "findings"
          ? JSON.stringify({
              verdict: "needs-work",
              summary: "fixture finding",
              findings: [
                {
                  severity: "high",
                  title: "Fixture finding",
                  body: "The fake runtime requested a blocking finding.",
                  file: "src/app.js",
                  line_start: 1,
                  line_end: 1,
                },
              ],
              next_steps: [],
            })
          : prompt.includes("headed exactly `## Verification`")
            ? "Fixture task complete.\n\n## Verification\nCriteria: fixture criteria.\nOutcome: passed.\n"
            : "PONG\n",
    },
  }),
);
const response =
  prompt.includes("JSON") || scenario === "findings"
    ? JSON.stringify(
        scenario === "findings"
          ? {
              verdict: "needs-work",
              summary: "fixture finding",
              findings: [
                {
                  severity: "high",
                  title: "Fixture finding",
                  body: "The fake runtime requested a blocking finding.",
                  file: "src/app.js",
                  line_start: 1,
                  line_end: 1,
                },
              ],
              next_steps: [],
            }
          : { verdict: "pass", summary: "ok", findings: [], next_steps: [] },
      )
    : prompt.includes("headed exactly `## Verification`")
      ? "Fixture task complete.\n\n## Verification\nCriteria: fixture criteria.\nOutcome: passed.\n"
      : "PONG\n";
const result = {
  event: "result",
  result: {
    conversation_id: id,
    status: scenario === "error-result" || scenario === "stderr-failure" ? "ERROR" : "SUCCESS",
    response,
    error: scenario === "error-result" ? "fixture failure" : undefined,
    duration_seconds: 0.1,
    num_turns: 1,
    usage:
      scenario === "no-usage"
        ? undefined
        : scenario === "partial-usage"
          ? { thinking_tokens: 7 }
          : {
              input_tokens: 23716,
              output_tokens: 954,
              thinking_tokens: 425,
              cache_read_tokens: 24397,
              total_tokens: 24670,
            },
  },
};
if (scenario === "partial-ndjson") {
  process.stdout.write(JSON.stringify(result));
} else {
  console.log(JSON.stringify(result));
}
