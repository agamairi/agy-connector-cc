#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_WRITE_MODEL,
  FAST_MODEL,
  MODEL_FAMILY_GROUPS,
  extractVerificationText,
  getAgyAvailability,
  groupModelsByFamily,
  listModels,
  parseStructuredOutput,
  readAgyConfiguredDefault,
  readOutputSchema,
  resolveJobModel,
  runAgy,
} from "./plugins/antigravity/scripts/lib/agy.mjs";
import {
  renderTranscriptAsPrompt,
  resolveClaudeSessionPath,
} from "./plugins/antigravity/scripts/lib/claude-session-transfer.mjs";
import {
  changedWorkingTreePaths,
  collectReviewContext,
  ensureGitRepository,
  normalizePathsToWorkspace,
  resolveReviewTarget,
  snapshotWorkingTree,
} from "./plugins/antigravity/scripts/lib/git.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
} from "./plugins/antigravity/scripts/lib/job-control.mjs";
import {
  binaryAvailable,
  getProcessIdentity,
  terminateProcessTree,
} from "./plugins/antigravity/scripts/lib/process.mjs";
import {
  buildTaskPrompt,
  interpolateTemplate,
  loadPromptTemplate,
} from "./plugins/antigravity/scripts/lib/prompts.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
} from "./plugins/antigravity/scripts/lib/render.mjs";
import {
  generateJobId,
  getConfig,
  upsertJob,
  writeJobFile,
} from "./plugins/antigravity/scripts/lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
} from "./plugins/antigravity/scripts/lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./plugins/antigravity/scripts/lib/workspace.mjs";

const ROOT_DIR = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "plugins/antigravity",
);
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");

const WAIT_DEFAULT_SECONDS = 240;
const WAIT_MAX_SECONDS = 300;
const POLL_INTERVAL_MS = 2000;
const activeJobs = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const modelSlugs = MODEL_FAMILY_GROUPS.flatMap((f) =>
  f.models.map((m) => m.slug),
);
const modelDescription = [
  "Model slug, label, or alias.",
  `Gemini family (large pool): ${modelSlugs.filter((s) => s.startsWith("gemini")).join(", ")}.`,
  `Claude/GPT family (scarce pool): ${modelSlugs.filter((s) => !s.startsWith("gemini")).join(", ")}.`,
  '"fast" or "spark" selects gemini-3.7-flash-low.',
  "Use Gemini for routine work; reserve Claude/GPT for hard reasoning.",
].join(" ");

function cwdFor(args) {
  return args?.cwd ? path.resolve(process.cwd(), args.cwd) : process.cwd();
}
function resolveModel(cwd, value, write) {
  return resolveJobModel(cwd, { explicit: value, write });
}
function textLine(text, fallback) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .find(Boolean) ?? fallback
  );
}

function createJob({
  prefix,
  kind,
  title,
  root,
  jobClass,
  summary,
  write = false,
  model = null,
}) {
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
function tracked(job) {
  const logFile = createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: false,
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id),
    }),
  };
}

function normalizeEffort(value) {
  if (value == null || !String(value).trim()) return null;
  const effort = String(value).trim().toLowerCase();
  if (!new Set(["low", "medium", "high"]).has(effort))
    throw new Error(`Unsupported reasoning effort "${value}". Use low, medium, or high.`);
  return effort;
}

// runTrackedJob was designed for a detached worker and initially records process.pid. In this
// long-lived MCP process that PID belongs to the server, not agy. runAgy does not expose its
// ChildProcess, so capture the child it synchronously creates and replace the temporary PID.
function activeChildPids() {
  return new Set(
    (typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [])
      .map((handle) => handle?.pid)
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  );
}
function recordAgyPid(job, before) {
  const pid = (typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [])
    .map((handle) => handle?.pid)
    .find((candidate) => Number.isInteger(candidate) && candidate > 0 && !before.has(candidate));
  if (!pid) return;
  const patch = { id: job.id, pid, pidStartedAt: nowIso(), pidIdentity: getProcessIdentity(pid) };
  const stored = readStoredJob(job.workspaceRoot, job.id) ?? job;
  writeJobFile(job.workspaceRoot, job.id, { ...stored, ...patch });
  upsertJob(job.workspaceRoot, patch);
}
function runAgyForJob(job, cwd, options) {
  const before = activeChildPids();
  const result = runAgy(cwd, options);
  recordAgyPid(job, before);
  return result;
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

async function executeReview(cwd, request) {
  ensureGitRepository(cwd);
  const target = resolveReviewTarget(cwd, request);
  const context = collectReviewContext(cwd, target);
  const reviewLabel = request.adversarial ? "Adversarial Review" : "Review";
  const agy = await runAgyForJob(request.job, context.repoRoot, {
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
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary,
    },
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
    summary:
      parsed.parsed?.summary ??
      textLine(agy.response, `${reviewLabel} finished.`),
  };
}

async function executeTask(cwd, request) {
  const root = resolveWorkspaceRoot(cwd);
  let before = null;
  if (request.write) {
    try {
      before = snapshotWorkingTree(root);
    } catch {
      // Shell-based edits are only observable from git when a working-tree snapshot is available.
    }
  }
  const agy = await runAgyForJob(request.job, root, {
    prompt: buildTaskPrompt(
      request.prompt || "Continue the prior task.",
      { write: request.write, successCriteria: request.successCriteria },
    ),
    model: request.model,
    effort: request.effort,
    write: request.write,
    readOnly: !request.write,
    onProgress: request.onProgress,
  });
  let after = null;
  if (request.write) {
    try {
      after = snapshotWorkingTree(root);
    } catch {
      // Keep agy's editor-tool paths if git is unavailable or this is not a repository.
    }
  }
  const filesChangedVerified = Boolean(before && after);
  const gitTouchedFiles = filesChangedVerified ? changedWorkingTreePaths(before, after) : [];
  const touchedFiles = normalizePathsToWorkspace(root, [...agy.touchedFiles, ...gitTouchedFiles]);
  const verification = request.write
    ? extractVerificationText(agy.response)
    : null;
  const payload = {
    status: agy.status,
    conversationId: agy.conversationId,
    model: agy.model,
    verification,
    touchedFiles,
    filesChangedVerified,
    rawOutput: agy.response,
    agy,
  };
  return {
    exitStatus: agy.exitStatus,
    stalled: agy.stalled,
    error: agy.error,
    conversationId: agy.conversationId,
    touchedFiles,
    filesChangedVerified,
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
      request.write ? "Antigravity task finished." : "Antigravity research finished.",
    ),
  };
}

function launchBackgroundJob(job, runner) {
  const { logFile, progress } = tracked(job);
  const queued = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    lastEventAt: job.createdAt,
    logFile,
  };
  writeJobFile(job.workspaceRoot, job.id, queued);
  upsertJob(job.workspaceRoot, queued);
  appendLogLine(logFile, "Queued for in-process background execution.");
  const promise = runTrackedJob(
    { ...job, logFile },
    () => runner(progress),
    { logFile },
  ).catch((error) => {
    appendLogLine(logFile, `Background runner failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  activeJobs.set(job.id, { promise });
  promise.finally(() => activeJobs.delete(job.id));
  return { logFile, promise };
}

async function waitForJob(cwd, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, jobId);
  while (
    snapshot.job &&
    (snapshot.job.status === "running" || snapshot.job.status === "queued") &&
    Date.now() < deadline
  ) {
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, jobId);
  }
  return snapshot;
}

const ok = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});
const text = (str) => ({
  content: [{ type: "text", text: str }],
});
const err = (obj) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});

const ANTIGRAVITY_CLAUDE_INSTRUCTIONS = `## Antigravity (agy) Integration

This project has access to Antigravity via MCP tools (prefixed \`antigravity_*\`).

- Use \`antigravity_execute\` to delegate substantial coding tasks (multi-file changes, refactors, new features)
- Use \`antigravity_research\` for codebase investigation and debugging
- Use \`antigravity_review\` / \`antigravity_adversarial_review\` for code review against git diffs
- Jobs run in the background — always call \`antigravity_wait\` or poll \`antigravity_result\` after launching
- Default models use the Gemini pool (large quota); only override with Claude/GPT for hard reasoning tasks
- For trivial edits, just make them directly — don't delegate single-line fixes`;

const server = new Server(
  { name: "agy-connector", version: "2.0.0" },
  {
    capabilities: { tools: {} },
    instructions: `# Antigravity (agy) MCP

Antigravity (agy) is a separate AI coding-agent CLI. Delegate suitable work to it through these MCP tools while you continue coordinating the task.

Available tools:
- antigravity_execute: delegate write tasks such as code changes, refactors, and new features; it returns a background job_id.
- antigravity_research: delegate read-only codebase research or debugging; it returns a background job_id.
- antigravity_review: run a structured code review against the current git working tree or a branch diff.
- antigravity_adversarial_review: challenge design choices and implementation assumptions against git state.
- antigravity_result: make a non-blocking status/result check for a job.
- antigravity_wait: block for up to 300 seconds while waiting for a job to finish.
- antigravity_cancel: cancel a running job.
- antigravity_list: list all tracked jobs in the workspace.
- antigravity_setup: diagnose agy installation, available models, and configuration.
- antigravity_transfer: replay the Claude session transcript into a new agy conversation.

Workflow:
- Execute, research, and both review tools run in the background. After launching one, always call antigravity_wait or poll antigravity_result until it finishes.
- For execute tasks, inspect the Verification section in the result before considering the task complete.
- Reviews and adversarial reviews operate on git state: the working tree by default, or a branch diff when requested.
- Default models use the Gemini pool, which has a large quota. Prefer them for routine work.
- Claude and GPT models are scarce; override to them only for genuinely hard reasoning or correctness-critical work.

Before delegating:
- Give agy a clear task, relevant constraints, and concrete success criteria where possible.
- Keep write work in antigravity_execute and investigation work in antigravity_research.
- Use antigravity_setup first if tool availability or model configuration is uncertain.

After a job completes:
- Use its reported findings, changed files, and verification output to decide the next step.
- Do not assume a background job succeeded until its result confirms completion.

Delegate when the work benefits from an independent agent: multi-file changes, large refactors, code reviews, codebase research, or debugging investigations.
Do not delegate trivial edits or single-line fixes; make those directly.`,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "antigravity_execute",
      description: [
        "Delegate a write-capable development task to Antigravity (agy).",
        "Spawns agy in the BACKGROUND and returns a job_id immediately — agy tasks take minutes.",
        "Poll antigravity_result(job_id) or call antigravity_wait(job_id) until status is no longer 'running'.",
        "agy edits code, runs commands, and verifies success_criteria, then reports a Verification section.",
        `Default model: ${DEFAULT_WRITE_MODEL} (Gemini pool — large quota).`,
        "Set model to a Claude/GPT slug only for hard reasoning or correctness-critical work.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Detailed description of the task to execute.",
          },
          model: { type: "string", description: modelDescription },
          effort: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Reasoning effort level.",
          },
          success_criteria: {
            type: "string",
            description:
              "Explicit conditions agy must verify before finishing (e.g. 'npx tsc --noEmit passes'). If omitted, agy chooses and states its own criteria.",
          },
          cwd: {
            type: "string",
            description:
              "Absolute working directory (the repo to operate on). Defaults to the server's cwd.",
          },
        },
        required: ["task"],
      },
    },
    {
      name: "antigravity_research",
      description: [
        "Delegate a read-only codebase research or debugging task to Antigravity.",
        "Spawns agy in the BACKGROUND and returns a job_id immediately.",
        "Poll antigravity_result(job_id) or antigravity_wait(job_id) until done.",
        "Returns a concise summary with file paths and line numbers. Does not edit files.",
        `Default model: ${FAST_MODEL} (Gemini pool — economical).`,
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The research question or bug description.",
          },
          model: { type: "string", description: modelDescription },
          cwd: {
            type: "string",
            description:
              "Absolute working directory. Defaults to the server's cwd.",
          },
        },
        required: ["question"],
      },
    },
    {
      name: "antigravity_review",
      description: [
        "Run an Antigravity code review against local git state.",
        "Spawns agy in the BACKGROUND with read-only barriers (--mode plan --sandbox).",
        "Returns structured findings: verdict, summary, findings array with severity/file/lines.",
        "Targets the working tree by default; use base/scope to review a branch diff.",
        `Default model: ${FAST_MODEL}.`,
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          base: {
            type: "string",
            description:
              "Base ref for branch diff (e.g. 'main'). If set, reviews commits from base to HEAD.",
          },
          scope: {
            type: "string",
            enum: ["auto", "working-tree", "branch"],
            description:
              "What to review: 'auto' picks based on state, 'working-tree' reviews uncommitted changes, 'branch' reviews the branch diff.",
          },
          model: { type: "string", description: modelDescription },
          cwd: {
            type: "string",
            description: "Absolute working directory (must be a git repo).",
          },
        },
      },
    },
    {
      name: "antigravity_adversarial_review",
      description: [
        "Run an adversarial Antigravity review that challenges the implementation approach and design choices.",
        "Spawns agy in the BACKGROUND. Unlike a standard review, this actively tries to break confidence in the change:",
        "it questions assumptions, probes failure modes, race conditions, auth gaps, rollback safety, and data integrity.",
        "Returns structured findings with confidence scores.",
        `Default model: ${FAST_MODEL}.`,
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          focus: {
            type: "string",
            description:
              "Optional focus area to challenge (e.g. 'the retry and rollback design').",
          },
          base: {
            type: "string",
            description: "Base ref for branch diff.",
          },
          scope: {
            type: "string",
            enum: ["auto", "working-tree", "branch"],
            description: "What to review.",
          },
          model: { type: "string", description: modelDescription },
          cwd: {
            type: "string",
            description: "Absolute working directory (must be a git repo).",
          },
        },
      },
    },
    {
      name: "antigravity_result",
      description: [
        "Get the stored result for a finished or running agy job (non-blocking).",
        "Returns status, result output, touched files, token usage, verification section, conversation ID, and continuation command.",
        "While status is 'running', wait and poll again. For a blocking wait, use antigravity_wait instead.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description:
              "The job_id returned by antigravity_execute/research/review.",
          },
          cwd: { type: "string", description: "Working directory." },
        },
        required: ["job_id"],
      },
    },
    {
      name: "antigravity_wait",
      description: [
        `Bounded long-poll: blocks until the job finishes OR timeout_seconds elapses (default ${WAIT_DEFAULT_SECONDS}s, max ${WAIT_MAX_SECONDS}s).`,
        "Returns the same shape as antigravity_result.",
        "If it returns status 'running' or 'queued', call it again.",
        "Reconciles dead PIDs and detects stalled jobs on each poll.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "The job_id to wait on.",
          },
          timeout_seconds: {
            type: "number",
            description: `Max seconds to block (default ${WAIT_DEFAULT_SECONDS}, max ${WAIT_MAX_SECONDS}).`,
          },
          cwd: { type: "string", description: "Working directory." },
        },
        required: ["job_id"],
      },
    },
    {
      name: "antigravity_cancel",
      description: [
        "Cancel a running agy job. Sends SIGTERM with graceful escalation to SIGKILL.",
        "Uses process-tree kill so child processes are also terminated.",
        "Safe against PID reuse — verifies process-birth identity before signalling.",
        "No-op if the job already finished.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "The job_id to cancel.",
          },
          cwd: { type: "string", description: "Working directory." },
        },
        required: ["job_id"],
      },
    },
    {
      name: "antigravity_list",
      description: [
        "List all tracked agy jobs for this workspace.",
        "Reconciles dead PIDs and stalled jobs before returning.",
        "Shows job ID, kind, status, model, elapsed time, summary, and conversation ID.",
        "Jobs persist across server restarts.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory." },
          all: {
            type: "boolean",
            description:
              "Show all jobs, not just the current session. Default false.",
          },
        },
      },
    },
    {
      name: "antigravity_setup",
      description: [
        "Diagnostic check: verifies agy binary, version, model availability, and configuration.",
        "Groups models by family (Gemini vs Claude/GPT) and reports agy's configured default model.",
        "Set install_instructions to true to add Antigravity usage guidance to .claude/CLAUDE.md when diagnostics pass.",
        "Call this before using other tools if unsure whether Antigravity is properly installed.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory." },
          install_instructions: {
            type: "boolean",
            description:
              "When true and setup is ready, create or append Antigravity guidance in .claude/CLAUDE.md.",
          },
        },
      },
    },
    {
      name: "antigravity_transfer",
      description: [
        "Replay the current Claude Code session transcript as context in a new Antigravity conversation.",
        "This is a context replay, not a native session import: agy has no importer.",
        "Seeds a new conversation with rendered Claude history and returns the conversation ID and resume command.",
        "The transferred conversation is read-only and inert — agy will not execute tools from the transcript.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "Path to Claude session JSONL file. If omitted, auto-resolved from the current project.",
          },
          cwd: { type: "string", description: "Working directory." },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: a = {} } = request.params;

  if (name === "antigravity_execute") {
    try {
      const cwd = cwdFor(a);
      const root = resolveWorkspaceRoot(cwd);
      const model = resolveModel(cwd, a.model, true);
      const job = createJob({
        prefix: "task",
        kind: "task",
        title: "Antigravity Task",
        root,
        jobClass: "task",
        summary: textLine(a.task, "Task"),
        write: true,
        model,
      });
      const request = {
        cwd,
        prompt: a.task,
        job,
        write: true,
        model,
        effort: normalizeEffort(a.effort),
        successCriteria: a.success_criteria ?? null,
      };
      const { logFile } = launchBackgroundJob(job, (progress) =>
        executeTask(cwd, { ...request, onProgress: progress }),
      );
      return ok({
        job_id: job.id,
        status: "running",
        model,
        note: "agy started in background. Poll antigravity_result(job_id) or antigravity_wait(job_id) until status != 'running'. Tasks typically take 1-5 min.",
      });
    } catch (e) {
      return err({ error: e.message });
    }
  }

  if (name === "antigravity_research") {
    try {
      const cwd = cwdFor(a);
      const root = resolveWorkspaceRoot(cwd);
      const model = resolveModel(cwd, a.model, false);
      const job = createJob({
        prefix: "task",
        kind: "task",
        title: "Antigravity Research",
        root,
        jobClass: "task",
        summary: textLine(a.question, "Research"),
        write: false,
        model,
      });
      const request = {
        cwd,
        prompt: a.question,
        job,
        write: false,
        model,
        effort: null,
        successCriteria: null,
      };
      launchBackgroundJob(job, (progress) =>
        executeTask(cwd, { ...request, onProgress: progress }),
      );
      return ok({
        job_id: job.id,
        status: "running",
        model,
        note: "agy started in background. Poll antigravity_result(job_id) or antigravity_wait(job_id) until status != 'running'.",
      });
    } catch (e) {
      return err({ error: e.message });
    }
  }

  if (name === "antigravity_review") {
    try {
      const cwd = cwdFor(a);
      const root = resolveWorkspaceRoot(cwd);
      const model = resolveModel(cwd, a.model, false);
      ensureGitRepository(cwd);
      const job = createJob({
        prefix: "review",
        kind: "review",
        title: "Antigravity Review",
        root,
        jobClass: "review",
        summary: "Review " + (resolveReviewTarget(cwd, a)?.label ?? "working tree"),
        model,
      });
      const request = {
        cwd,
        job,
        base: a.base,
        scope: a.scope,
        model,
        adversarial: false,
      };
      launchBackgroundJob(job, (progress) =>
        executeReview(cwd, { ...request, onProgress: progress }),
      );
      return ok({
        job_id: job.id,
        status: "running",
        model,
        note: "Review started in background. Poll antigravity_result(job_id) or antigravity_wait(job_id).",
      });
    } catch (e) {
      return err({ error: e.message });
    }
  }

  if (name === "antigravity_adversarial_review") {
    try {
      const cwd = cwdFor(a);
      const root = resolveWorkspaceRoot(cwd);
      const model = resolveModel(cwd, a.model, false);
      ensureGitRepository(cwd);
      const job = createJob({
        prefix: "review",
        kind: "adversarial-review",
        title: "Antigravity Adversarial Review",
        root,
        jobClass: "review",
        summary:
          "Adversarial review " +
          (resolveReviewTarget(cwd, a)?.label ?? "working tree"),
        model,
      });
      const request = {
        cwd,
        job,
        base: a.base,
        scope: a.scope,
        model,
        focus: a.focus || "",
        adversarial: true,
      };
      launchBackgroundJob(job, (progress) =>
        executeReview(cwd, { ...request, onProgress: progress }),
      );
      return ok({
        job_id: job.id,
        status: "running",
        model,
        note: "Adversarial review started in background. Poll antigravity_result(job_id) or antigravity_wait(job_id).",
      });
    } catch (e) {
      return err({ error: e.message });
    }
  }

  if (name === "antigravity_result") {
    try {
      const cwd = cwdFor(a);
      const { workspaceRoot, job } = resolveResultJob(cwd, a.job_id);
      const storedJob = readStoredJob(workspaceRoot, job.id);
      const rendered = renderStoredJobResult(job, storedJob);
      const conversationId = storedJob?.conversationId ?? job.conversationId ?? null;
      return ok({
        job_id: job.id,
        status: job.status,
        result: storedJob?.result ?? null,
        model: storedJob?.model ?? job.model ?? null,
        conversationId,
        continuation_command: conversationId ? `agy --conversation ${conversationId}` : null,
        touchedFiles: storedJob?.touchedFiles ?? job.touchedFiles ?? [],
        filesChangedVerified: storedJob?.filesChangedVerified ?? job.filesChangedVerified ?? false,
        usage: storedJob?.usage ?? job.usage ?? null,
        verification: storedJob?.verification ?? job.verification ?? null,
        summary: job.summary ?? null,
        rendered,
      });
    } catch (e) {
      return err({ error: e.message });
    }
  }

  if (name === "antigravity_wait") {
    try {
      const cwd = cwdFor(a);
      const requestedSeconds = a.timeout_seconds == null ? WAIT_DEFAULT_SECONDS : Number(a.timeout_seconds);
      const secs = Math.min(
        Math.max(Number.isFinite(requestedSeconds) ? requestedSeconds : WAIT_DEFAULT_SECONDS, 0),
        WAIT_MAX_SECONDS,
      );
      const snapshot = await waitForJob(cwd, a.job_id, secs * 1000);
      if (!snapshot.job) return err({ error: `Unknown job: ${a.job_id}` });
      const timedOut =
        snapshot.job.status === "running" || snapshot.job.status === "queued";
      const storedJob = readStoredJob(snapshot.workspaceRoot, snapshot.job.id);
      const conversationId = storedJob?.conversationId ?? snapshot.job.conversationId ?? null;
      const rendered = timedOut
        ? renderJobStatusReport(snapshot.job)
        : renderStoredJobResult(snapshot.job, storedJob);
      return ok({
        job_id: snapshot.job.id,
        status: snapshot.job.status,
        timed_out: timedOut,
        result: storedJob?.result ?? null,
        model: storedJob?.model ?? snapshot.job.model ?? null,
        conversationId,
        continuation_command: conversationId ? `agy --conversation ${conversationId}` : null,
        touchedFiles:
          storedJob?.touchedFiles ?? snapshot.job.touchedFiles ?? [],
        filesChangedVerified:
          storedJob?.filesChangedVerified ?? snapshot.job.filesChangedVerified ?? false,
        usage: storedJob?.usage ?? snapshot.job.usage ?? null,
        verification:
          storedJob?.verification ?? snapshot.job.verification ?? null,
        summary: snapshot.job.summary ?? null,
        rendered,
        note: timedOut
          ? `Job still ${snapshot.job.status} after ${secs}s. Call antigravity_wait again.`
          : undefined,
      });
    } catch (e) {
      return err({ error: e.message });
    }
  }

  if (name === "antigravity_cancel") {
    try {
      const cwd = cwdFor(a);
      const { workspaceRoot, job } = resolveCancelableJob(cwd, a.job_id, { env: process.env });
      const storedJob = readStoredJob(workspaceRoot, job.id) ?? {};
      const termination = await terminateProcessTree(job.pid ?? Number.NaN);
      const now = nowIso();
      appendLogLine(job.logFile, "Cancelled by user.");
      const next = {
        ...job,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        completedAt: now,
        lastEventAt: now,
        errorMessage: "Cancelled by user.",
      };
      upsertJob(workspaceRoot, {
        id: job.id,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        completedAt: now,
        lastEventAt: now,
        errorMessage: "Cancelled by user.",
      });
      writeJobFile(workspaceRoot, job.id, { ...storedJob, ...next });
      return ok({
        job_id: job.id,
        status: "cancelled",
        termination,
        rendered: renderCancelReport(next),
      });
    } catch (e) {
      return err({ error: e.message });
    }
  }

  if (name === "antigravity_list") {
    try {
      const cwd = cwdFor(a);
      const snapshot = buildStatusSnapshot(cwd, { all: a.all ?? false });
      const rendered = renderStatusReport(snapshot);
      return ok({
        count: (snapshot.running?.length ?? 0) + (snapshot.recent?.length ?? 0) + (snapshot.latestFinished ? 1 : 0),
        running: (snapshot.running ?? []).map((j) => ({
          job_id: j.id,
          kind: j.kindLabel ?? j.kind,
          status: j.status,
          model: j.model,
          summary: j.summary,
        })),
        recent: [
          ...(snapshot.latestFinished
            ? [
                {
                  job_id: snapshot.latestFinished.id,
                  kind: snapshot.latestFinished.kindLabel ?? snapshot.latestFinished.kind,
                  status: snapshot.latestFinished.status,
                  model: snapshot.latestFinished.model,
                  summary: snapshot.latestFinished.summary,
                },
              ]
            : []),
          ...(snapshot.recent ?? []).map((j) => ({
            job_id: j.id,
            kind: j.kindLabel ?? j.kind,
            status: j.status,
            model: j.model,
            summary: j.summary,
          })),
        ],
        rendered,
      });
    } catch (e) {
      return err({ error: e.message });
    }
  }

  if (name === "antigravity_setup") {
    try {
      const cwd = cwdFor(a);
      const root = resolveWorkspaceRoot(cwd);
      const agy = getAgyAvailability(cwd);
      const listedModels = agy.available
        ? listModels(cwd)
        : { live: false, detail: "agy unavailable", models: [] };
      const models = {
        ...listedModels,
        groups: groupModelsByFamily(listedModels.models),
      };
      const agyConfiguredDefault = readAgyConfiguredDefault();
      const config = getConfig(root);
      const report = {
        ready: binaryAvailable("node").available && agy.available && models.live,
        node: binaryAvailable("node"),
        agy,
        models,
        agyConfiguredDefault,
        reviewGateEnabled: Boolean(config.stopReviewGate),
        actionsTaken: [],
        nextSteps: [],
      };
      if (!agy.available)
        report.nextSteps.push(
          "Install the Antigravity CLI (`agy`) and ensure it is on PATH.",
        );
      if (!models.live)
        report.nextSteps.push(
          "`agy models` did not succeed. Check your Antigravity sign-in, network, and proxy configuration.",
        );
      if (a.install_instructions) {
        if (!report.ready) {
          report.actionsTaken.push(
            "Skipped .claude/CLAUDE.md Antigravity instructions because setup is not ready.",
          );
        } else {
          const claudeInstructionsPath = path.join(cwd, ".claude", "CLAUDE.md");
          if (!fs.existsSync(claudeInstructionsPath)) {
            fs.mkdirSync(path.dirname(claudeInstructionsPath), { recursive: true });
            fs.writeFileSync(
              claudeInstructionsPath,
              `${ANTIGRAVITY_CLAUDE_INSTRUCTIONS}\n`,
            );
            report.actionsTaken.push(
              "Created .claude/CLAUDE.md with Antigravity instructions.",
            );
          } else {
            const existingInstructions = fs.readFileSync(claudeInstructionsPath, "utf8");
            if (/antigravity/i.test(existingInstructions)) {
              report.actionsTaken.push(
                ".claude/CLAUDE.md already contains Antigravity instructions.",
              );
            } else {
              fs.appendFileSync(
                claudeInstructionsPath,
                `${existingInstructions.endsWith("\n") ? "\n" : "\n\n"}${ANTIGRAVITY_CLAUDE_INSTRUCTIONS}\n`,
              );
              report.actionsTaken.push(
                "Appended Antigravity instructions to .claude/CLAUDE.md.",
              );
            }
          }
        }
      }
      return text(renderSetupReport(report));
    } catch (e) {
      return err({ error: e.message });
    }
  }

  if (name === "antigravity_transfer") {
    try {
      const cwd = cwdFor(a);
      const root = resolveWorkspaceRoot(cwd);
      const sourcePath = resolveClaudeSessionPath(cwd, {
        source: a.source,
      });
      const model = resolveModel(cwd, null, false);
      const agy = await runAgy(root, {
        prompt: renderTranscriptAsPrompt(sourcePath),
        model,
        write: false,
        readOnly: true,
      });
      if (agy.exitStatus !== 0) {
        return err({
          error: String(
            agy.error ||
              agy.stderr ||
              "Antigravity failed while replaying the Claude transcript.",
          ).trim(),
        });
      }
      return ok({
        conversationId: agy.conversationId,
        model: agy.model,
        sourcePath,
        resumeCommand: agy.conversationId
          ? `agy --conversation ${agy.conversationId}`
          : null,
        note: "Created a new Antigravity conversation by replaying the Claude transcript as context (not a native session import).",
      });
    } catch (e) {
      return err({ error: e.message });
    }
  }

  return err({ error: `Unknown tool: ${name}` });
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("agy-connector MCP server v2.0.0 running on stdio");
