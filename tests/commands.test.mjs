import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/antigravity/scripts/lib/args.mjs";

const commandsRoot = path.resolve("plugins/antigravity/commands");
const readCommand = (name) => fs.readFileSync(path.join(commandsRoot, `${name}.md`), "utf8");

test("parses value options, boolean options, and aliases", () => {
  const parsed = parseArgs(["-m", "fast", "--base=main", "--write", "prompt"], {
    valueOptions: ["model", "base"],
    booleanOptions: ["write"],
    aliasMap: { m: "model" },
  });

  assert.deepEqual(parsed.options, { model: "fast", base: "main", write: true });
  assert.deepEqual(parsed.positionals, ["prompt"]);
});

test("supports explicit false booleans and preserves unknown flags as positionals", () => {
  const parsed = parseArgs(["--json=false", "--unrecognized", "task"], {
    booleanOptions: ["json"],
  });

  assert.deepEqual(parsed.options, { json: false });
  assert.deepEqual(parsed.positionals, ["--unrecognized", "task"]);
});

test("rejects missing values", () => {
  assert.throws(() => parseArgs(["--model"], { valueOptions: ["model"] }), /Missing value/);
});

test("splits quoted raw slash-command arguments", () => {
  assert.deepEqual(splitRawArgumentString("--model fast \"fix this\" --prompt-file 'a b.txt'"), [
    "--model",
    "fast",
    "fix this",
    "--prompt-file",
    "a b.txt",
  ]);
});

test("review commands preserve the reference size-estimation and verbatim-output flow", () => {
  for (const name of ["review", "adversarial-review"]) {
    const source = readCommand(name);
    assert.match(source, /AskUserQuestion/);
    assert.match(source, /git status --short --untracked-files=all/);
    assert.match(source, /git diff --shortstat/);
    assert.match(source, /roughly 1-2 files total/);
    assert.match(source, /run_in_background:\s*true/);
    assert.match(source, /Do not call `BashOutput`/);
    assert.match(source, /stdout verbatim, exactly as-is/);
    assert.match(source, /review-only/);
  }
  assert.match(readCommand("review"), /does not support.*extra focus text/);
  assert.match(readCommand("adversarial-review"), /can still take extra focus text/);
});

test("rescue and deterministic commands document their routing and output contracts", () => {
  const rescue = readCommand("rescue");
  assert.match(rescue, /subagent_type: "antigravity:antigravity-rescue"/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /stdout verbatim/);
  assert.match(rescue, /separate quota pools/);
  assert.match(rescue, /--model gemini-3\.1-pro-high/);
  assert.match(rescue, /--model claude-sonnet-4-6/);
  assert.match(rescue, /user's explicit model instruction always wins/i);
  assert.match(readCommand("status"), /\[--wait\].*\[--timeout-ms <ms>\]/);
  assert.match(readCommand("result"), /without summarizing or condensing/);
  assert.match(readCommand("transfer"), /context replay, not a native session import/);
  assert.doesNotMatch(readCommand("setup"), /disable-model-invocation:\s*true/);
});
