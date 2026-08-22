import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { binaryAvailable, runCommand } from "./process.mjs";

// execve caps the total argument block (1 MiB on macOS; measured E2BIG just above that) and the
// prompt travels as a single argv entry. Fail with an explanation instead of a bare E2BIG.
export const MAX_PROMPT_BYTES = 512 * 1024;

export const DEFAULT_PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT || "20m";
export const DEFAULT_INACTIVITY_TIMEOUT = process.env.AGY_INACTIVITY_TIMEOUT || "15m";
export const FAST_MODEL = "gemini-3.7-flash-low";
export const DEFAULT_READ_MODEL = FAST_MODEL;
export const DEFAULT_WRITE_MODEL = "gemini-3.1-pro-low";
export const MODEL_FAMILY_GROUPS = Object.freeze([
  Object.freeze({
    id: "gemini",
    label: "Gemini",
    prefixes: Object.freeze(["gemini"]),
    retryModel: "gemini-3.1-pro-high",
    models: Object.freeze([
      Object.freeze({ slug: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" }),
      Object.freeze({ slug: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" }),
      Object.freeze({ slug: FAST_MODEL, label: "Gemini 3.7 Flash (Low)" }),
      Object.freeze({ slug: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" }),
      Object.freeze({ slug: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" }),
      Object.freeze({ slug: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" }),
      Object.freeze({ slug: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (High)" }),
      Object.freeze({ slug: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash (Medium)" }),
      Object.freeze({ slug: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (Low)" }),
      Object.freeze({ slug: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" }),
      Object.freeze({ slug: DEFAULT_WRITE_MODEL, label: "Gemini 3.1 Pro (Low)" }),
    ]),
  }),
  Object.freeze({
    id: "claude-gpt",
    label: "Claude/GPT",
    prefixes: Object.freeze(["claude", "gpt"]),
    retryModel: "claude-sonnet-4-6",
    models: Object.freeze([
      Object.freeze({ slug: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" }),
      Object.freeze({ slug: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" }),
      Object.freeze({ slug: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" }),
    ]),
  }),
]);
const FALLBACK_MODELS = MODEL_FAMILY_GROUPS.flatMap((family) => family.models);

export function classifyModelFamily(value) {
  let normalized;
  try {
    normalized = String(value ?? "")
      .trim()
      .toLowerCase();
  } catch {
    return "unknown";
  }
  if (!normalized) return "unknown";
  return (
    MODEL_FAMILY_GROUPS.find((family) =>
      family.prefixes.some(
        (prefix) =>
          normalized === prefix || normalized.startsWith(`${prefix}-`) || normalized.startsWith(`${prefix} `),
      ),
    )?.id ?? "unknown"
  );
}

export function groupModelsByFamily(models = []) {
  const groups = Object.fromEntries(MODEL_FAMILY_GROUPS.map((family) => [family.id, []]));
  groups.unknown = [];
  for (const model of Array.isArray(models) ? models : []) {
    const family = classifyModelFamily(model?.slug ?? model?.label);
    groups[family].push(model);
  }
  return groups;
}

export function isQuotaExhaustionError(value) {
  let message;
  try {
    message = String(value ?? "");
  } catch {
    return false;
  }
  return (
    /\bquota\b/i.test(message) &&
    /\b(?:reach(?:ed)?|exhaust(?:ed|ion)?|exceed(?:ed)?|deplet(?:ed|ion)|limit)\b/i.test(message)
  );
}

export function formatQuotaError(value, model) {
  const original = String(value ?? "").trim();
  if (!isQuotaExhaustionError(original)) return original;
  const familyId = classifyModelFamily(model);
  const family = MODEL_FAMILY_GROUPS.find((item) => item.id === familyId);
  if (!family) {
    const modelDetail = String(model ?? "").trim();
    return (
      `${original}\n\nAntigravity reported quota exhaustion, but the model family could not be determined` +
      `${modelDetail ? ` for ${modelDetail}` : " because no model was recorded"}. ` +
      "In observed agy 1.1.18 behavior, Gemini and Claude/GPT use separate quota pools, so one may " +
      "still work when the other does not. Retry with an explicit model such as " +
      "`--model gemini-3.1-pro-high` or `--model claude-sonnet-4-6`."
    );
  }
  const alternative = MODEL_FAMILY_GROUPS.find((item) => item.id !== family.id);
  return (
    `${original}\n\nThe ${family.label} quota pool used by ${String(model).trim()} appears exhausted. ` +
    `In observed agy 1.1.18 behavior, the ${alternative.label} family uses a separate quota pool and ` +
    `may still work. Retry with \`--model ${alternative.retryModel}\`.`
  );
}

export function readAgyConfiguredDefault(options = {}) {
  const home = options.home ?? options.env?.HOME ?? os.homedir();
  const settingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (typeof settings?.model !== "string" || !settings.model.trim()) return null;
    const model = settings.model.trim();
    return { model, family: classifyModelFamily(model), settingsPath };
  } catch {
    return null;
  }
}
export function parseModelsOutput(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [slug, ...rest] = line.split(/\t+| {2,}/);
      return { slug, label: rest.join(" ").trim() || slug };
    })
    .filter((item) => item.slug);
}
export function listModels(cwd, options = {}) {
  const result = runCommand(options.command ?? "agy", ["models"], { cwd, env: options.env });
  const models =
    result.status === 0 && !result.error
      ? parseModelsOutput(result.stdout)
      : FALLBACK_MODELS.map(({ slug, label }) => ({ slug, label }));
  return {
    models,
    live: result.status === 0 && !result.error,
    detail:
      result.status === 0 ? "ok" : (result.stderr || result.error?.message || `exit ${result.status}`).trim(),
  };
}
export function normalizeModel(value, models = []) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (["fast", "spark"].includes(raw.toLowerCase())) return FAST_MODEL;
  const exact = models.find((model) => model.slug === raw || model.label.toLowerCase() === raw.toLowerCase());
  return exact?.slug ?? raw;
}
export function resolveJobModel(cwd, options = {}) {
  const explicit = String(options.explicit ?? "").trim();
  if (explicit) {
    const available = (options.modelLister ?? listModels)(cwd).models;
    return normalizeModel(explicit, available);
  }
  // AGY_DEFAULT_MODEL is itself a default, not a request to discover models. Keep this path local:
  // `agy models` is an authenticated network call and must not run on every task invocation.
  const configured = String((options.env ?? process.env).AGY_DEFAULT_MODEL ?? "").trim();
  if (configured) return normalizeModel(configured);
  return options.write ? DEFAULT_WRITE_MODEL : DEFAULT_READ_MODEL;
}
export const getAgyAvailability = (cwd) => binaryAvailable("agy", ["--version"], { cwd });

export function extractVerificationText(value) {
  const text = String(value ?? "").trim();
  const heading = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?Verification[ \t]*:?[ \t]*(.*)(?:\n|$)/i.exec(text);
  if (!heading) return null;
  const start = heading.index + heading[0].length;
  const inline = heading[1]?.trim();
  const trailing = text.slice(start).trim();
  const body = [inline, trailing].filter(Boolean).join("\n").trim();
  return body || null;
}

export function parseDurationMs(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const match = String(value ?? "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i);
  if (!match) {
    if (fallback !== null) return parseDurationMs(fallback);
    throw new Error(`Invalid duration "${value}". Use a value such as 500ms, 30s, 15m, or 2h.`);
  }
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2].toLowerCase()];
  return Number(match[1]) * multiplier;
}

export function shorten(value, limit = 96) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized || normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

export function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    String(command ?? ""),
  );
}

function parameter(parameters, ...names) {
  for (const name of names) {
    if (parameters?.[name] != null && String(parameters[name]).trim()) return String(parameters[name]).trim();
  }
  return "";
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function equivalentRoots(value) {
  const resolved = path.resolve(value);
  try {
    return [...new Set([resolved, fs.realpathSync.native(resolved)])];
  } catch {
    return [resolved];
  }
}

function displayPath(value, cwd, directory = false) {
  if (!value) return "";
  let displayed = String(value).trim();
  const absolute = path.isAbsolute(displayed) ? path.normalize(displayed) : null;
  const workspaceRoot = absolute ? equivalentRoots(cwd).find((root) => isInside(root, absolute)) : null;
  if (absolute && workspaceRoot) {
    const relative = path.relative(workspaceRoot, absolute);
    displayed = relative || path.basename(path.resolve(cwd));
  } else if (absolute && isInside(os.homedir(), absolute)) {
    displayed = path.join("~", path.relative(os.homedir(), absolute));
  }
  displayed = shorten(displayed, 96);
  return directory && displayed && !displayed.endsWith(path.sep) ? `${displayed}${path.sep}` : displayed;
}

function toolDetails(update, cwd) {
  const name = String(update?.tool_name ?? update?.tool_info?.name ?? "tool").trim() || "tool";
  const parameters = update?.tool_info?.parameters;
  // Parameter names verified against agy 1.1.15: view_file uses AbsolutePath and find_by_name uses
  // SearchDirectory, neither of which matches the TargetFile/SearchPath naming the write tools use.
  // Missing one degrades the progress line to a bare tool name, so keep these lists in sync with
  // whatever the CLI actually emits rather than what looks consistent.
  const file = displayPath(
    parameter(parameters, "TargetFile", "AbsolutePath", "FilePath", "NotebookPath", "Path"),
    cwd,
  );
  const directory = displayPath(parameter(parameters, "DirectoryPath", "Path"), cwd, true);
  const command = shorten(parameter(parameters, "CommandLine", "Command", "ShellCommand"), 96);
  const query = shorten(parameter(parameters, "Query", "SearchTerm", "Pattern", "Name"), 72);
  const searchRoot = displayPath(
    parameter(parameters, "SearchDirectory", "SearchPath", "DirectoryPath", "Path"),
    cwd,
  );
  return { name, file, directory, command, query, searchRoot };
}

const knownToolNames = new Set([
  "view_file",
  "list_dir",
  "run_command",
  "grep_search",
  "find_by_name",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
  "notebook_edit",
]);

export function describeStartedItem(update, cwd) {
  const item = toolDetails(update, cwd);
  switch (item.name) {
    case "view_file":
      return { message: item.file ? `Reading ${item.file}` : item.name, phase: "investigating" };
    case "list_dir":
      return { message: item.directory ? `Listing ${item.directory}` : item.name, phase: "investigating" };
    case "run_command":
      if (!item.command) return { message: item.name, phase: "running" };
      return {
        message: `${looksLikeVerificationCommand(item.command) ? "Verifying" : "Running"}: ${item.command}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running",
      };
    case "grep_search":
      return {
        message: item.query
          ? `Searching for ${JSON.stringify(item.query)}${item.searchRoot ? ` in ${item.searchRoot}` : ""}`
          : item.name,
        phase: "investigating",
      };
    case "find_by_name":
      return {
        message: item.query ? `Finding ${JSON.stringify(item.query)}` : item.name,
        phase: "investigating",
      };
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
    case "notebook_edit":
      return { message: item.file ? `Editing ${item.file}` : item.name, phase: "editing" };
    default:
      return { message: item.name, phase: "running" };
  }
}

export function describeCompletedItem(update, cwd) {
  const started = describeStartedItem(update, cwd);
  if (update?.state === "ERROR") {
    return { message: `ERROR: ${started.message}`, phase: "failed" };
  }
  const name = String(update?.tool_name ?? update?.tool_info?.name ?? "tool").trim() || "tool";
  if (!knownToolNames.has(name)) return started;
  return { message: `${started.message} — done`, phase: started.phase };
}

function collectTargetPaths(value, paths = []) {
  if (!value || typeof value !== "object") return paths;
  if (Array.isArray(value)) {
    for (const item of value) collectTargetPaths(item, paths);
    return paths;
  }
  for (const [key, item] of Object.entries(value)) {
    if (["TargetFile", "FilePath", "NotebookPath", "Path"].includes(key) && typeof item === "string") {
      if (item.trim()) paths.push(item.trim());
    } else if (item && typeof item === "object") {
      collectTargetPaths(item, paths);
    }
  }
  return paths;
}

export function collectTouchedFiles(events, cwd, options = {}) {
  const agyHomes = equivalentRoots(options.agyHome ?? path.join(os.homedir(), ".gemini", "antigravity-cli"));
  const workspaceRoots = equivalentRoots(cwd);
  const workspaceRoot = workspaceRoots[0];
  const writableTools = new Set([
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "sed_file",
    "notebook_edit",
  ]);
  const touched = new Set();
  for (const event of events ?? []) {
    const update = event?.event === "step_update" ? event.step_update : event;
    const name = update?.tool_name ?? update?.tool_info?.name;
    if (!writableTools.has(name)) continue;
    const parameters = update?.tool_info?.parameters;
    for (const target of collectTargetPaths(parameters)) {
      const absolute = path.resolve(workspaceRoot, target);
      if (agyHomes.some((root) => isInside(root, absolute))) continue;
      const containingRoot = workspaceRoots.find((root) => isInside(root, absolute));
      touched.add(containingRoot ? path.relative(containingRoot, absolute) || "." : absolute);
    }
  }
  return [...touched];
}

function isAgyNoiseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  try {
    const parsed = JSON.parse(trimmed);
    if (["init", "step_update", "result"].includes(parsed?.event)) return true;
  } catch {}
  return (
    /^(?:\[[^\]]+\]\s*)?(?:DEBUG|INFO|TRACE)\b[:\s-]*/i.test(trimmed) ||
    /^(?:Using model|Starting conversation|Conversation ID|Step \d+)\b/i.test(trimmed)
  );
}

export function cleanAgyStderr(stderr) {
  return String(stderr ?? "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !isAgyNoiseLine(line))
    .join("\n")
    .trim();
}

// agy 1.1.15 denies every tool call in non-interactive print mode unless permissions are
// auto-approved, so --dangerously-skip-permissions is required for any run to work at all.
// Reviews therefore get their write barrier from `--mode plan --sandbox`, plus an explicit
// read-only prompt and an inline git diff as defence in depth.
//
// Verified against agy 1.1.18: a read-only run instructed outright to create a file emitted an
// implementation plan and asked for approval instead, and no file appeared on disk. Re-check
// this if you bump the agy version — it is the only thing standing between a review and a write.
export async function runAgy(cwd, options = {}) {
  const promptBytes = Buffer.byteLength(options.prompt ?? "", "utf8");
  if (promptBytes > MAX_PROMPT_BYTES)
    throw new Error(
      `Prompt is ${promptBytes} bytes, over the ${MAX_PROMPT_BYTES}-byte limit for a single CLI argument. ` +
        `Narrow the review (for example with --base <ref>) or split the task.`,
    );
  // `--print` consumes the NEXT argv entry as the prompt, so the prompt has to sit
  // immediately after it. Appending the prompt at the end instead makes agy treat the
  // following flag ("--output-format") as the prompt and silently drop both the real
  // prompt and the JSON output format.
  const printTimeout = options.timeout ?? options.env?.AGY_PRINT_TIMEOUT ?? DEFAULT_PRINT_TIMEOUT;
  const inactivityTimeout =
    options.inactivityTimeout ?? options.env?.AGY_INACTIVITY_TIMEOUT ?? DEFAULT_INACTIVITY_TIMEOUT;
  const inactivityTimeoutMs = parseDurationMs(inactivityTimeout);
  const args = [
    "--print",
    options.prompt ?? "",
    "--output-format",
    "stream-json",
    "--print-timeout",
    printTimeout,
    "--dangerously-skip-permissions",
  ];
  if (options.readOnly) args.push("--mode", "plan", "--sandbox");
  else if (options.write) args.push("--mode", "accept-edits");
  if (options.conversationId) args.push("--conversation", options.conversationId);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.schemaPath) args.push("--json-schema", options.schemaPath);
  // Always put the target directory in agy's workspace. Spawning with `cwd` alone is NOT enough:
  // without --add-dir, a write task fails its edit against the real path (surfacing as a `tool
  // ERROR` step) and then silently rewrites the file under ~/.gemini/antigravity-cli/scratch/
  // instead, reporting success while the repo is untouched. Verified against agy 1.1.15.
  for (const directory of [...new Set([cwd, ...(options.addDirs ?? [])])].filter(Boolean))
    args.push("--add-dir", directory);
  return new Promise((resolve, reject) => {
    const child = spawn(options.command ?? "agy", [...(options.commandArgs ?? []), ...args], {
      cwd,
      env: options.env ?? process.env,
      // Must NOT be detached. The background worker is the process-group leader and cancel
      // works by signalling that whole group; detaching agy here would make it a group leader
      // of its own, so /antigravity:cancel would mark the job cancelled while the real agy
      // process kept running and kept burning quota.
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "",
      stderr = "",
      remainder = "",
      conversationId = null,
      model = options.model ?? null,
      final = null,
      inactivityTimer = null,
      forceKillTimer = null,
      inactivityError = null;
    const events = [];
    const report = (event) => options.onProgress?.(event);
    const clearInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = null;
    };
    const resetInactivityTimer = () => {
      clearInactivityTimer();
      if (inactivityTimeoutMs === 0) return;
      inactivityTimer = setTimeout(() => {
        inactivityError = `Antigravity produced no output for ${inactivityTimeout}; the run was terminated as stalled.`;
        report({ message: inactivityError, phase: "stalled" });
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        forceKillTimer.unref?.();
      }, inactivityTimeoutMs);
      inactivityTimer.unref?.();
    };
    const consume = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        report({ message: line, phase: "output" });
        return;
      }
      events.push(event);
      if (event.event === "init") {
        conversationId = event.conversation_id ?? conversationId;
        model = event.init?.model ?? model;
        report({
          message: `Conversation ${conversationId ?? "started"}`,
          phase: "starting",
          conversationId,
          model,
        });
      } else if (event.event === "step_update") {
        const update = event.step_update ?? {};
        conversationId = update.conversation_id ?? conversationId;
        const text = update.text_delta ?? "";
        const described =
          update.step_type === "tool"
            ? update.state === "ACTIVE"
              ? describeStartedItem(update, cwd)
              : describeCompletedItem(update, cwd)
            : null;
        report({
          message:
            text.trim() || described?.message || `${update.step_type ?? "step"} ${update.state ?? ""}`.trim(),
          phase: described?.phase ?? (update.step_type === "agent_response" ? "responding" : "running"),
          conversationId,
        });
      } else if (event.event === "result") {
        final = event.result ?? {};
        conversationId = final.conversation_id ?? conversationId;
        model = final.model ?? model;
        const finalError = formatQuotaError(final.error, model);
        report({
          message: final.status === "SUCCESS" ? "Completed." : finalError || "Failed.",
          phase: final.status === "SUCCESS" ? "finalizing" : "failed",
          conversationId,
        });
      }
    };
    // Decode through StringDecoder: chunk boundaries fall mid-sequence for multi-byte UTF-8, and
    // a bare chunk.toString() would corrupt any non-ASCII character that straddles two chunks.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk) => {
      resetInactivityTimer();
      options.onProgress?.({});
      const text = outDecoder.write(chunk);
      if (!text) return;
      stdout += text;
      remainder += text;
      let index;
      while ((index = remainder.indexOf("\n")) >= 0) {
        consume(remainder.slice(0, index));
        remainder = remainder.slice(index + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      resetInactivityTimer();
      options.onProgress?.({});
      stderr += errDecoder.write(chunk);
    });
    child.on("error", (error) => {
      clearInactivityTimer();
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearInactivityTimer();
      if (forceKillTimer) clearTimeout(forceKillTimer);
      // Flush any bytes the decoders are still holding before parsing the tail.
      const tail = outDecoder.end();
      if (tail) {
        stdout += tail;
        remainder += tail;
      }
      stderr += errDecoder.end();
      for (let index; (index = remainder.indexOf("\n")) >= 0;) {
        consume(remainder.slice(0, index));
        remainder = remainder.slice(index + 1);
      }
      if (remainder.trim()) consume(remainder);
      const response =
        final?.response ??
        events
          .filter((event) => event.event === "step_update")
          .map((event) => event.step_update?.text_delta ?? "")
          .join("");
      const status = final?.status ?? (code === 0 ? "SUCCESS" : "ERROR"),
        cleanedStderr = cleanAgyStderr(stderr),
        rawError =
          inactivityError || String(final?.error ?? "").trim() || (status === "SUCCESS" ? "" : cleanedStderr),
        error = inactivityError || formatQuotaError(rawError, model),
        result = final && error !== rawError ? { ...final, error } : final;
      resolve({
        status: inactivityError ? "STALLED" : status,
        exitStatus: inactivityError ? 1 : final?.status === "SUCCESS" && code === 0 ? 0 : code || 1,
        code,
        signal,
        stdout,
        stderr: cleanedStderr,
        events,
        result,
        conversationId,
        model,
        response,
        error,
        touchedFiles: collectTouchedFiles(events, cwd),
        usage: final?.usage && typeof final.usage === "object" ? final.usage : null,
        stalled: Boolean(inactivityError),
      });
    });
    resetInactivityTimer();
    child.stdin.end();
  });
}
// Recover the outermost JSON object embedded in a larger string. agy narrates each step as
// agent text and `result.response` ends up as that narration with the schema payload appended,
// so a whole-string parse is not enough in practice — a real review failed exactly this way.
function parseEmbeddedObject(text) {
  const lastBrace = text.lastIndexOf("}");
  if (lastBrace < 0) return null;
  // Try each candidate opening brace, earliest first, so we land on the outermost object
  // rather than a nested fragment of it.
  for (let start = text.indexOf("{"); start >= 0 && start < lastBrace; start = text.indexOf("{", start + 1)) {
    try {
      return JSON.parse(text.slice(start, lastBrace + 1));
    } catch {
      // Not a valid object boundary; advance to the next candidate.
    }
  }
  return null;
}

export function parseStructuredOutput(raw) {
  const text = String(raw ?? "").trim();
  try {
    return { parsed: JSON.parse(text), rawOutput: text, parseError: null };
  } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      return { parsed: JSON.parse(fenced[1]), rawOutput: text, parseError: null };
    } catch {}
  }

  const embedded = parseEmbeddedObject(text);
  if (embedded !== null) return { parsed: embedded, rawOutput: text, parseError: null };

  return { parsed: null, rawOutput: text, parseError: "No valid JSON object found in the response." };
}
export const readOutputSchema = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
