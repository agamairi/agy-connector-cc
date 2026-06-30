#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdirSync, openSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * MCP ⇄ Antigravity (agy) connector — ASYNC job model.
 *
 * Exposes the Antigravity (`agy`) CLI to any MCP client as a background executor.
 * agy agentic runs take minutes, which exceeds the typical MCP request timeout and
 * drops the stdio connection ("-32000 Connection closed") if run synchronously
 * inside a single tool call. So `antigravity_execute` / `antigravity_research`
 * SPAWN agy in the background and return a `job_id` IMMEDIATELY; the client then
 * polls `antigravity_result(job_id)` (or `antigravity_wait` for a bounded block)
 * until status != "running". Every MCP call stays fast, so long delegations never
 * time out. `antigravity_cancel` stops a job; `antigravity_list` enumerates them.
 */

const JOBS_DIR = join(tmpdir(), "agy-jobs");
mkdirSync(JOBS_DIR, { recursive: true });

const jobs = new Map(); // job_id -> { kind, model, cwd, status, code, outPath, child, created }

// Valid `agy --model` slugs (see `agy models`).
const MODELS = ["gemini-3.1-pro", "gemini-3.5-flash"];
// Bounded-wait cap. MUST stay under the client's MCP request timeout (often ~60s)
// or antigravity_wait would reintroduce the "Connection closed" timeout it avoids.
const WAIT_MAX_SECONDS = 50;
const WAIT_DEFAULT_SECONDS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = new Server(
  { name: "agy-connector", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "antigravity_execute",
      description:
        "Delegate a development task to Antigravity (agy). Spawns agy in the BACKGROUND and returns a job_id immediately — agy tasks take minutes, so poll antigravity_result(job_id) (or antigravity_wait) until it is no longer 'running'. agy edits code, runs commands, and verifies success_criteria, then returns a structured JSON receipt (status/summary/files_changed/verification_details).",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Detailed description of the task to execute." },
          model: {
            type: "string",
            enum: MODELS,
            description: "Use 'gemini-3.1-pro' for complex reasoning/refactoring, 'gemini-3.5-flash' for simple quick tasks."
          },
          success_criteria: { type: "string", description: "Explicit conditions agy must verify before finishing (e.g. 'npx tsc --noEmit passes')." },
          context_files: { type: "array", items: { type: "string" }, description: "Absolute file paths to point agy at the relevant code." },
          cwd: { type: "string", description: "Absolute working directory to run agy in (the repo/project to operate on). Defaults to the server's current directory." }
        },
        required: ["task", "model", "success_criteria"]
      }
    },
    {
      name: "antigravity_research",
      description:
        "Delegate a codebase research/debugging task to Antigravity. Spawns agy in the BACKGROUND and returns a job_id immediately — poll antigravity_result(job_id) (or antigravity_wait) until done. Returns a concise summary with file paths/line numbers.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The research question or bug description." },
          model: { type: "string", enum: MODELS, description: "'gemini-3.5-flash' is usually sufficient for research; 'gemini-3.1-pro' for hard problems." },
          cwd: { type: "string", description: "Absolute working directory to run agy in. Defaults to the server's current directory." }
        },
        required: ["question", "model"]
      }
    },
    {
      name: "antigravity_result",
      description:
        "Poll a background agy job (non-blocking). Returns { status: 'running' | 'done' | 'error' | 'cancelled', ... }. While 'running', wait a bit and poll again (agy tasks take minutes). When done, returns agy's output (execute: the parsed JSON receipt; research: the summary).",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string", description: "The job_id returned by antigravity_execute/antigravity_research." } },
        required: ["job_id"]
      }
    },
    {
      name: "antigravity_wait",
      description:
        `Bounded long-poll: blocks until the job finishes OR until timeout_seconds elapses (capped at ${WAIT_MAX_SECONDS}s to stay under the MCP request timeout), then returns the same shape as antigravity_result. Use this instead of sleep+poll loops. If it returns status 'running', call it again.`,
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "The job_id to wait on." },
          timeout_seconds: { type: "number", description: `Max seconds to block (default ${WAIT_DEFAULT_SECONDS}, capped at ${WAIT_MAX_SECONDS}).` }
        },
        required: ["job_id"]
      }
    },
    {
      name: "antigravity_cancel",
      description:
        "Terminate a running agy job by job_id (SIGTERM to the agy process). Returns the resulting status. No-op if the job already finished.",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string", description: "The job_id to cancel." } },
        required: ["job_id"]
      }
    },
    {
      name: "antigravity_list",
      description:
        "List all jobs this server knows about (in-memory; cleared on server restart), with their status, kind, model, cwd, and creation time. Useful to recover a job_id or see what's in flight.",
      inputSchema: { type: "object", properties: {} }
    }
  ]
}));

/** Spawn agy in the background, streaming output to a job file. Returns job_id. */
function startAgy(kind, prompt, model, cwd) {
  const jobId = randomUUID();
  const outPath = join(JOBS_DIR, `${jobId}.out`);
  writeFileSync(outPath, "");
  const fd = openSync(outPath, "a");

  const args = ["--print", prompt, "--dangerously-skip-permissions"];
  if (model) args.push("--model", model);

  const workdir = cwd || process.cwd();
  // shell:false — argv passed directly so prompt metacharacters ( ) " ' \n are safe.
  const child = spawn("agy", args, { cwd: workdir, shell: false, stdio: ["ignore", fd, fd] });
  const job = { kind, model: model || null, cwd: workdir, status: "running", code: null, outPath, child, created: new Date().toISOString() };
  jobs.set(jobId, job);

  child.on("close", (code) => {
    // Don't clobber a 'cancelled' status set by antigravity_cancel.
    if (job.status === "running") { job.status = code === 0 ? "done" : "error"; job.code = code; }
    job.child = null;
  });
  child.on("error", (err) => {
    if (job.status === "running") { job.status = "error"; job.code = -1; }
    try { writeFileSync(outPath, `spawn error: ${err.message}`, { flag: "a" }); } catch { /* ignore */ }
    job.child = null;
  });

  return jobId;
}

function extractJson(text) {
  const match = text.match(/```(?:json)?\n([\s\S]*?)\n```/) || text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[1] || match[0]); } catch { return null; }
  }
  return null;
}

function readOut(job) {
  try { return existsSync(job.outPath) ? readFileSync(job.outPath, "utf8") : ""; } catch { return ""; }
}

/** Shared result shape for antigravity_result / antigravity_wait. */
function buildResult(job) {
  const raw = readOut(job);
  if (job.status === "running") return { status: "running", partial_output_tail: raw.slice(-400) };
  if (job.status === "cancelled") return { status: "cancelled", note: "Job was cancelled.", partial_output: raw.slice(-1000) };
  if (job.kind === "execute") {
    const parsed = extractJson(raw);
    if (parsed) return { status: job.status, exit_code: job.code, result: parsed };
    return { status: job.status, exit_code: job.code, note: "agy finished but did not return strict JSON.", raw_output: raw };
  }
  return { status: job.status, exit_code: job.code, output: raw };
}

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const err = (obj) => ({ isError: true, content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

const EXECUTE_INSTRUCTIONS = (task, contextStr, success_criteria) =>
  `You are an autonomous executor agent orchestrated by a master AI agent.
Your task: ${task}${contextStr}

Your success criteria: ${success_criteria}

INSTRUCTIONS:
1. Perform the task using your available tools.
2. Verify that the success criteria are met. Run tests or commands if necessary to ensure correctness.
3. Terminate your task by returning a strictly valid JSON object matching the format below. Do not output any other text before or after the JSON.

JSON FORMAT:
{
  "status": "SUCCESS" | "FAILURE" | "NEEDS_CLARIFICATION",
  "summary": "Brief 1-2 sentence summary of what you did",
  "files_changed": ["path/to/file1"],
  "verification_details": "How you verified the success criteria and the outcome",
  "failure_reason": "If status is FAILURE, explain why. Otherwise null."
}`;

const RESEARCH_INSTRUCTIONS = (question) =>
  `You are an autonomous research agent orchestrated by a master AI agent.
Your task is to investigate the following and return a concise summary: ${question}

INSTRUCTIONS:
1. Search the codebase and read necessary files to find the answer.
2. Return a concise, high-density summary of your findings to the orchestrator. Include file paths and line numbers where relevant. Do not output raw code unless absolutely necessary to explain the finding.`;

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: a = {} } = request.params;

  if (name === "antigravity_execute") {
    const { task, model, success_criteria, context_files, cwd } = a;
    const contextStr =
      context_files && context_files.length > 0
        ? `\nInitial context files to review:\n- ${context_files.join("\n- ")}`
        : "";
    const jobId = startAgy("execute", EXECUTE_INSTRUCTIONS(task, contextStr, success_criteria), model, cwd);
    return ok({ job_id: jobId, status: "running", note: "agy started in background. Poll antigravity_result(job_id) or antigravity_wait until status != 'running'. Tasks typically take 1-5 min." });
  }

  if (name === "antigravity_research") {
    const { question, model, cwd } = a;
    const jobId = startAgy("research", RESEARCH_INSTRUCTIONS(question), model, cwd);
    return ok({ job_id: jobId, status: "running", note: "agy started in background. Poll antigravity_result(job_id) or antigravity_wait until status != 'running'." });
  }

  if (name === "antigravity_result") {
    const job = jobs.get(a.job_id);
    if (!job) return err({ status: "error", error: `Unknown job_id: ${a.job_id}` });
    return ok(buildResult(job));
  }

  if (name === "antigravity_wait") {
    const job = jobs.get(a.job_id);
    if (!job) return err({ status: "error", error: `Unknown job_id: ${a.job_id}` });
    const secs = Math.min(Math.max(Number(a.timeout_seconds) || WAIT_DEFAULT_SECONDS, 1), WAIT_MAX_SECONDS);
    const deadline = Date.now() + secs * 1000;
    while (job.status === "running" && Date.now() < deadline) await sleep(500);
    return ok(buildResult(job));
  }

  if (name === "antigravity_cancel") {
    const job = jobs.get(a.job_id);
    if (!job) return err({ status: "error", error: `Unknown job_id: ${a.job_id}` });
    if (job.status !== "running") return ok({ status: job.status, note: "Job already finished; nothing to cancel." });
    try { job.child?.kill("SIGTERM"); } catch { /* ignore */ }
    job.status = "cancelled";
    if (job.code == null) job.code = -1;
    return ok({ status: "cancelled", note: "Sent SIGTERM to the agy process." });
  }

  if (name === "antigravity_list") {
    const list = [...jobs.entries()].map(([job_id, j]) => ({
      job_id, kind: j.kind, model: j.model, cwd: j.cwd, status: j.status, exit_code: j.code, created: j.created
    }));
    return ok({ count: list.length, jobs: list });
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("agy-connector MCP server running on stdio");
