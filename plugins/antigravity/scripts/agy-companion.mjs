#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  extractVerificationText,
  getAgyAvailability,
  groupModelsByFamily,
  listModels,
  parseStructuredOutput,
  readAgyConfiguredDefault,
  resolveJobModel,
  runAgy,
} from "./lib/agy.mjs";
import { renderTranscriptAsPrompt, resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst,
} from "./lib/job-control.mjs";
import { binaryAvailable, getProcessIdentity, terminateProcessTree } from "./lib/process.mjs";
import { buildTaskPrompt, interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { generateJobId, getConfig, listJobs, setConfig, upsertJob, writeJobFile } from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV,
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2_000;
const efforts = new Set(["low", "medium", "high"]);
const normalizeArgv = (argv) => (argv.length === 1 ? splitRawArgumentString(argv[0]) : argv);
const parseInput = (argv, config) =>
  parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: { C: "cwd", m: "model", ...(config.aliasMap ?? {}) },
  });
const cwdFor = (options) => (options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd());
// `resolveJobModel` only shells out to `agy models` for an explicit --model. Built-in and
// AGY_DEFAULT_MODEL defaults stay local so the normal invocation path has no extra network call.
const resolveModel = (cwd, value, options = {}) => resolveJobModel(cwd, { ...options, explicit: value });
const textLine = (text, fallback) =>
  String(text ?? "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find(Boolean) ?? fallback;
const output = (payload, rendered, json) =>
  json ? console.log(JSON.stringify(payload, null, 2)) : process.stdout.write(rendered);
function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/agy-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/agy-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/agy-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/agy-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|fast>] [--effort <low|medium|high>] [--success-criteria <text>] [prompt]",
      "  node scripts/agy-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/agy-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
      "  node scripts/agy-companion.mjs result [job-id] [--json]",
      "  node scripts/agy-companion.mjs cancel [job-id] [--json]",
    ].join("\n"),
  );
}
function normalizeEffort(value) {
  if (value == null || !String(value).trim()) return null;
  const effort = String(value).trim().toLowerCase();
  if (!efforts.has(effort))
    throw new Error(`Unsupported reasoning effort "${value}". Use one of: low, medium, high.`);
  return effort;
}

function ensureAgyAvailable(cwd) {
  if (!getAgyAvailability(cwd).available) {
    throw new Error(
      "Antigravity CLI is not installed or is unavailable. Run /antigravity:setup and ensure `agy` is on PATH.",
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isActiveJobStatus(statusValue) {
  return statusValue === "queued" || statusValue === "running";
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);
  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }
  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs,
  };
}
function createJob({ prefix, kind, title, root, jobClass, summary, write = false, model = null }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: jobClass === "task" ? "rescue" : kind,
    title,
    workspaceRoot: root,
    jobClass,
    summary,
    write,
    model,
  });
}
function tracked(job, stderr = false, logFile = null) {
  const file = logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile: file,
    progress: createProgressReporter({
      stderr,
      logFile: file,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id),
    }),
  };
}
async function setup(argv) {
  const { options } = parseInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });
  if (options["enable-review-gate"] && options["disable-review-gate"])
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  const cwd = cwdFor(options),
    root = resolveWorkspaceRoot(cwd),
    actionsTaken = [];
  if (options["enable-review-gate"]) {
    setConfig(root, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${root}.`);
  }
  if (options["disable-review-gate"]) {
    setConfig(root, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${root}.`);
  }
  const agy = getAgyAvailability(cwd),
    listedModels = agy.available ? listModels(cwd) : { live: false, detail: "agy unavailable", models: [] },
    models = { ...listedModels, groups: groupModelsByFamily(listedModels.models) },
    agyConfiguredDefault = readAgyConfiguredDefault(),
    config = getConfig(root);
  const nextSteps = [];
  if (!agy.available)
    nextSteps.push("Install or repair Antigravity with `agy install`, then ensure `agy` is on PATH.");
  else if (!models.live)
    nextSteps.push(
      "`agy models` did not succeed. Check your Antigravity sign-in, network, and proxy configuration.",
    );
  if (!config.stopReviewGate)
    nextSteps.push(
      "Optional: run `/antigravity:setup --enable-review-gate` to require a fresh review before stop.",
    );
  const report = {
    ready: binaryAvailable("node").available && agy.available && models.live,
    node: binaryAvailable("node"),
    agy,
    models,
    agyConfiguredDefault,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps,
  };
  output(report, renderSetupReport(report), options.json);
}
function promptForReview(context, focus, adversarial) {
  if (!adversarial)
    return [
      "You are performing a code review. Report only material correctness, security, reliability, or regression findings.",
      "You are read-only: do not edit files, do not run write commands.",
      `Target: ${context.target.label}`,
      context.content,
    ].join("\n\n");
  return interpolateTemplate(loadPromptTemplate(ROOT_DIR, "adversarial-review"), {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focus || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
  });
}
async function executeReview(request) {
  ensureAgyAvailable(request.cwd);
  ensureGitRepository(request.cwd);
  const target = resolveReviewTarget(request.cwd, request),
    context = collectReviewContext(request.cwd, target),
    reviewLabel = request.adversarial ? "Adversarial Review" : "Review";
  if (!request.adversarial && request.focus)
    throw new Error(
      "`/antigravity:review` does not accept focus text; use `/antigravity:adversarial-review`.",
    );
  const agy = await runAgy(context.repoRoot, {
    prompt: promptForReview(context, request.focus, request.adversarial),
    model: request.model,
    readOnly: true,
    schemaPath: REVIEW_SCHEMA,
    onProgress: request.onProgress,
  });
  const parsed = parseStructuredOutput(agy.response);
  const payload = {
    review: reviewLabel,
    target,
    context: { repoRoot: context.repoRoot, branch: context.branch, summary: context.summary },
    model: agy.model,
    agy,
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
  };
  return {
    exitStatus: agy.exitStatus,
    stalled: agy.stalled,
    error: agy.error,
    conversationId: agy.conversationId,
    touchedFiles: agy.touchedFiles,
    usage: agy.usage,
    model: agy.model,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel,
      targetLabel: target.label,
      model: agy.model,
      failureMessage: agy.error,
    }),
    summary: parsed.parsed?.summary ?? textLine(agy.response, `${reviewLabel} finished.`),
  };
}
async function foreground(job, runner, json) {
  const { logFile, progress } = tracked(job, !json);
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  output(execution.payload, execution.rendered, json);
  if (execution.exitStatus) process.exitCode = execution.exitStatus;
}
async function review(argv, adversarial) {
  const { options, positionals } = parseInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "wait", "background"],
  });
  const cwd = cwdFor(options);
  const root = resolveWorkspaceRoot(cwd);
  const target = resolveReviewTarget(cwd, options);
  const focus = positionals.join(" ").trim();
  if (!adversarial && focus)
    throw new Error(
      `\`/antigravity:review\` does not accept focus text. Retry with \`/antigravity:adversarial-review ${focus}\` for focused review instructions.`,
    );
  const model = resolveModel(cwd, options.model, { write: false });
  const label = adversarial ? "Adversarial Review" : "Review";
  const job = createJob({
    prefix: "review",
    kind: adversarial ? "adversarial-review" : "review",
    title: `Antigravity ${label}`,
    root,
    jobClass: "review",
    summary: `${label} ${target.label}`,
    model,
  });
  const request = {
    type: "review",
    cwd,
    base: options.base,
    scope: options.scope,
    model,
    focus,
    adversarial,
  };
  if (options.background) {
    ensureAgyAvailable(cwd);
    ensureGitRepository(cwd);
    const { logFile } = tracked(job);
    appendLogLine(logFile, "Queued for background execution.");
    const child = spawnWorker(cwd, job.id);
    const pidStartedAt = nowIso();
    const stored = {
      ...job,
      status: "queued",
      phase: "queued",
      pid: child.pid ?? null,
      pidStartedAt,
      pidIdentity: child.pid ? getProcessIdentity(child.pid) : null,
      lastEventAt: job.createdAt,
      logFile,
      request,
    };
    writeJobFile(root, job.id, stored);
    upsertJob(root, stored);
    return output(
      { jobId: job.id, status: "queued", title: job.title, summary: job.summary, model, logFile },
      `${job.title} started in the background as ${job.id}. Check /antigravity:status ${job.id} for progress.\n`,
      options.json,
    );
  }
  await foreground(job, (progress) => executeReview({ ...request, onProgress: progress }), options.json);
}
function taskPrompt(cwd, options, positionals) {
  return options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : positionals.join(" ") || readStdinIfPiped();
}
function latestConversation(root, exclude) {
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  const jobs = sortJobsNewestFirst(listJobs(root))
    .filter((job) => job.id !== exclude)
    .filter((job) => !sessionId || job.sessionId === sessionId);
  const activeTask = jobs.find(
    (job) => job.jobClass === "task" && (job.status === "running" || job.status === "queued"),
  );
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /antigravity:status before continuing it.`);
  }
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" && job.conversationId && job.status !== "running" && job.status !== "queued",
    )?.conversationId ?? null
  );
}
async function executeTask(request) {
  const root = resolveWorkspaceRoot(request.cwd);
  ensureAgyAvailable(request.cwd);
  const conversationId = request.resume ? latestConversation(root, request.jobId) : null;
  if (request.resume && !conversationId)
    throw new Error("No previous Antigravity task conversation was found for this repository.");
  if (!request.prompt && !conversationId)
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume/--resume-last.");
  const agy = await runAgy(root, {
    prompt: buildTaskPrompt(request.prompt || "Continue the prior task.", {
      write: request.write,
      successCriteria: request.successCriteria,
    }),
    conversationId,
    model: request.model,
    effort: request.effort,
    write: request.write,
    readOnly: !request.write,
    onProgress: request.onProgress,
  });
  const verification = request.write ? extractVerificationText(agy.response) : null;
  const payload = {
    status: agy.status,
    conversationId: agy.conversationId,
    model: agy.model,
    verification,
    rawOutput: agy.response,
    agy,
  };
  return {
    exitStatus: agy.exitStatus,
    stalled: agy.stalled,
    error: agy.error,
    conversationId: agy.conversationId,
    touchedFiles: agy.touchedFiles,
    usage: agy.usage,
    model: agy.model,
    verification,
    payload,
    rendered: renderTaskResult({
      rawOutput: agy.response,
      failureMessage: agy.error,
      model: agy.model,
      verification,
    }),
    summary: textLine(
      agy.response,
      request.resume ? "Antigravity resume finished." : "Antigravity task finished.",
    ),
  };
}
function spawnWorker(cwd, jobId) {
  const child = spawn(
    process.execPath,
    [path.join(ROOT_DIR, "scripts", "agy-companion.mjs"), "job-worker", "--cwd", cwd, "--job-id", jobId],
    { cwd, env: process.env, detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  return child;
}
async function task(argv) {
  const { options, positionals } = parseInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "success-criteria"],
    booleanOptions: ["json", "write", "resume", "resume-last", "fresh", "background"],
  });
  if ((options.resume || options["resume-last"]) && options.fresh)
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  const cwd = cwdFor(options),
    root = resolveWorkspaceRoot(cwd),
    prompt = taskPrompt(cwd, options, positionals),
    resume = Boolean(options.resume || options["resume-last"]),
    write = Boolean(options.write),
    model = resolveModel(cwd, options.model, { write }),
    effort = normalizeEffort(options.effort),
    title = resume ? "Antigravity Resume" : "Antigravity Task",
    job = createJob({
      prefix: "task",
      kind: "task",
      title,
      root,
      jobClass: "task",
      summary: textLine(prompt, resume ? "Continue prior task" : "Task"),
      write,
      model,
    }),
    request = {
      cwd,
      prompt,
      resume,
      model,
      effort,
      successCriteria: options["success-criteria"] ?? null,
      write,
      jobId: job.id,
    };
  if (options.background) {
    ensureAgyAvailable(cwd);
    if (!prompt && !resume)
      throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume/--resume-last.");
    const { logFile } = tracked(job);
    appendLogLine(logFile, "Queued for background execution.");
    const child = spawnWorker(cwd, job.id);
    const pidStartedAt = nowIso();
    const stored = {
      ...job,
      status: "queued",
      phase: "queued",
      pid: child.pid ?? null,
      pidStartedAt,
      pidIdentity: child.pid ? getProcessIdentity(child.pid) : null,
      lastEventAt: job.createdAt,
      logFile,
      request: { ...request, type: "task" },
    };
    writeJobFile(root, job.id, stored);
    upsertJob(root, stored);
    return output(
      { jobId: job.id, status: "queued", title, summary: job.summary, model, logFile },
      `${title} started in the background as ${job.id}. Check /antigravity:status ${job.id} for progress.\n`,
      options.json,
    );
  }
  await foreground(job, (progress) => executeTask({ ...request, onProgress: progress }), options.json);
}
async function worker(argv) {
  const { options } = parseInput(argv, { valueOptions: ["cwd", "job-id"] });
  if (!options["job-id"]) throw new Error("Missing --job-id.");
  const cwd = cwdFor(options),
    root = resolveWorkspaceRoot(cwd);
  let stored = null;
  for (let attempt = 0; attempt < 20 && !stored; attempt += 1) {
    stored = readStoredJob(root, options["job-id"]);
    if (!stored) await sleep(25);
  }
  if (!stored?.request) throw new Error(`No stored task request found for ${options["job-id"]}.`);
  const { logFile, progress } = tracked(stored, false, stored.logFile);
  const runner =
    stored.request.type === "review"
      ? () => executeReview({ ...stored.request, onProgress: progress })
      : () => executeTask({ ...stored.request, onProgress: progress });
  await runTrackedJob({ ...stored, workspaceRoot: root, logFile }, runner, { logFile });
}
async function transfer(argv) {
  const { options } = parseInput(argv, { valueOptions: ["cwd", "source"], booleanOptions: ["json"] });
  const cwd = cwdFor(options),
    sourcePath = resolveClaudeSessionPath(cwd, options),
    model = resolveModel(cwd, null, { write: false }),
    agy = await runAgy(resolveWorkspaceRoot(cwd), {
      prompt: renderTranscriptAsPrompt(sourcePath),
      model,
      write: false,
      readOnly: true,
    });
  if (agy.exitStatus !== 0) {
    throw new Error(
      String(agy.error || agy.stderr || "Antigravity failed while replaying the Claude transcript.").trim(),
    );
  }
  const payload = {
    conversationId: agy.conversationId,
    model: agy.model,
    sourcePath,
    resumeCommand: agy.conversationId ? `agy --conversation ${agy.conversationId}` : null,
  };
  output(
    payload,
    `Created a new Antigravity conversation by replaying the Claude transcript as context (not a native session import).\nModel used: ${payload.model}\nAntigravity conversation ID: ${payload.conversationId ?? "unavailable"}\nContinue in agy: ${payload.resumeCommand ?? "unavailable"}\n`,
    options.json,
  );
}
async function status(argv) {
  const { options, positionals } = parseInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"],
  });
  const cwd = cwdFor(options);
  if (positionals[0]) {
    const report = options.wait
      ? await waitForSingleJobSnapshot(cwd, positionals[0], {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"],
        })
      : buildSingleJobSnapshot(cwd, positionals[0]);
    return output(report, renderJobStatusReport(report.job), options.json);
  }
  if (options.wait) throw new Error("`status --wait` requires a job id.");
  const report = buildStatusSnapshot(cwd, { all: options.all });
  output(report, renderStatusReport(report), options.json);
}
function result(argv) {
  const { options, positionals } = parseInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const { workspaceRoot, job } = resolveResultJob(cwdFor(options), positionals[0]);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  output({ job, storedJob }, renderStoredJobResult(job, storedJob), options.json);
}
function resumeCandidate(argv) {
  const { options } = parseInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const root = resolveWorkspaceRoot(cwdFor(options)),
    sessionId = process.env[SESSION_ID_ENV] ?? null,
    job =
      sortJobsNewestFirst(listJobs(root))
        .filter((item) => !sessionId || item.sessionId === sessionId)
        .find(
          (item) =>
            item.jobClass === "task" &&
            item.conversationId &&
            item.status !== "running" &&
            item.status !== "queued",
        ) ?? null;
  const candidate = job
    ? {
        id: job.id,
        status: job.status,
        title: job.title ?? null,
        summary: job.summary ?? null,
        conversationId: job.conversationId,
        completedAt: job.completedAt ?? null,
        updatedAt: job.updatedAt ?? null,
      }
    : null;
  output(
    { available: Boolean(candidate), sessionId, candidate },
    job
      ? `Resumable task found: ${job.id} (${job.status}).\n`
      : "No resumable task found for this session.\n",
    options.json,
  );
}
async function cancel(argv) {
  const { options, positionals } = parseInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const { workspaceRoot, job } = resolveCancelableJob(cwdFor(options), positionals[0], {
    env: process.env,
  });
  const stored = readStoredJob(workspaceRoot, job.id) ?? {};
  await terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");
  const completedAt = nowIso(),
    next = {
      ...job,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt,
      errorMessage: "Cancelled by user.",
    };
  writeJobFile(workspaceRoot, job.id, { ...stored, ...next });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user.",
  });
  output({ jobId: job.id, status: "cancelled", title: job.title }, renderCancelReport(next), options.json);
}
async function main() {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "setup":
      return setup(argv);
    case "review":
      return review(argv, false);
    case "adversarial-review":
      return review(argv, true);
    case "task":
      return task(argv);
    case "task-worker":
    case "job-worker":
      return worker(argv);
    case "transfer":
      return transfer(argv);
    case "status":
      return status(argv);
    case "result":
      return result(argv);
    case "cancel":
      return cancel(argv);
    case "task-resume-candidate":
      return resumeCandidate(argv);
    case "help":
    case "--help":
    case undefined:
      return usage();
    default:
      throw new Error(`Unknown subcommand: ${command}`);
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
