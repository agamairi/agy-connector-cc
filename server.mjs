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
 * polls `antigravity_result(job_id)` until status != "running". Every MCP call is
 * fast, so long delegations never time out.
 */

const JOBS_DIR = join(tmpdir(), "agy-jobs");
mkdirSync(JOBS_DIR, { recursive: true });

const jobs = new Map(); // job_id -> { kind, model, status, code, outPath }

const server = new Server(
  { name: "agy-connector", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "antigravity_execute",
      description:
        "Delegate a development task to Antigravity (agy). Spawns agy in the BACKGROUND and returns a job_id immediately — agy tasks take minutes, so poll antigravity_result(job_id) until it is no longer 'running'. agy edits code, runs commands, and verifies success_criteria, then returns a structured JSON receipt (status/summary/files_changed/verification_details).",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Detailed description of the task to execute." },
          model: {
            type: "string",
            enum: ["gemini-3.5-pro", "gemini-3.5-flash", "gemini-3.0-pro"],
            description: "Use 'gemini-3.5-pro' for complex reasoning/refactoring, 'gemini-3.5-flash' for simple quick tasks."
          },
          success_criteria: { type: "string", description: "Explicit conditions agy must verify before finishing (e.g. 'npx tsc --noEmit passes')." },
          context_files: { type: "array", items: { type: "string" }, description: "Absolute file paths to point agy at the relevant code." }
        },
        required: ["task", "model", "success_criteria"]
      }
    },
    {
      name: "antigravity_research",
      description:
        "Delegate a codebase research/debugging task to Antigravity. Spawns agy in the BACKGROUND and returns a job_id immediately — poll antigravity_result(job_id) until done. Returns a concise summary with file paths/line numbers.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The research question or bug description." },
          model: { type: "string", enum: ["gemini-3.5-pro", "gemini-3.5-flash"], description: "Flash is usually sufficient for research." }
        },
        required: ["question", "model"]
      }
    },
    {
      name: "antigravity_result",
      description:
        "Poll a background agy job started by antigravity_execute/antigravity_research. Returns { status: 'running' | 'done' | 'error', ... }. While 'running', wait a bit and poll again (agy tasks take minutes). When done, returns agy's output (execute: the parsed JSON receipt; research: the summary).",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string", description: "The job_id returned by antigravity_execute/antigravity_research." } },
        required: ["job_id"]
      }
    }
  ]
}));

/** Spawn agy in the background, streaming output to a job file. Returns job_id. */
function startAgy(kind, prompt, model) {
  const jobId = randomUUID();
  const outPath = join(JOBS_DIR, `${jobId}.out`);
  writeFileSync(outPath, "");
  const fd = openSync(outPath, "a");

  const args = ["--print", prompt, "--dangerously-skip-permissions"];
  if (model) args.push("--model", model);

  // shell:false — argv passed directly so prompt metacharacters ( ) " ' \n are safe.
  const child = spawn("agy", args, { shell: false, stdio: ["ignore", fd, fd] });
  const job = { kind, model, status: "running", code: null, outPath };
  jobs.set(jobId, job);

  child.on("close", (code) => {
    job.status = code === 0 ? "done" : "error";
    job.code = code;
  });
  child.on("error", (err) => {
    job.status = "error";
    job.code = -1;
    try { writeFileSync(outPath, `spawn error: ${err.message}`, { flag: "a" }); } catch { /* ignore */ }
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
  const { name, arguments: a } = request.params;

  if (name === "antigravity_execute") {
    const { task, model, success_criteria, context_files } = a;
    const contextStr =
      context_files && context_files.length > 0
        ? `\nInitial context files to review:\n- ${context_files.join("\n- ")}`
        : "";
    const jobId = startAgy("execute", EXECUTE_INSTRUCTIONS(task, contextStr, success_criteria), model);
    return {
      content: [{ type: "text", text: JSON.stringify({ job_id: jobId, status: "running", note: "agy started in background. Poll antigravity_result(job_id) until status != 'running'. Tasks typically take 1-5 min." }, null, 2) }]
    };
  }

  if (name === "antigravity_research") {
    const { question, model } = a;
    const jobId = startAgy("research", RESEARCH_INSTRUCTIONS(question), model);
    return {
      content: [{ type: "text", text: JSON.stringify({ job_id: jobId, status: "running", note: "agy started in background. Poll antigravity_result(job_id) until status != 'running'." }, null, 2) }]
    };
  }

  if (name === "antigravity_result") {
    const { job_id } = a;
    const job = jobs.get(job_id);
    if (!job) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Unknown job_id: ${job_id}` }) }] };
    }
    let raw = "";
    try { raw = existsSync(job.outPath) ? readFileSync(job.outPath, "utf8") : ""; } catch { /* ignore */ }

    if (job.status === "running") {
      return { content: [{ type: "text", text: JSON.stringify({ status: "running", partial_output_tail: raw.slice(-400) }, null, 2) }] };
    }

    if (job.kind === "execute") {
      const parsed = extractJson(raw);
      if (parsed) return { content: [{ type: "text", text: JSON.stringify({ status: job.status, exit_code: job.code, result: parsed }, null, 2) }] };
      return { content: [{ type: "text", text: JSON.stringify({ status: job.status, exit_code: job.code, note: "agy finished but did not return strict JSON.", raw_output: raw }, null, 2) }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({ status: job.status, exit_code: job.code, output: raw }, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("agy-connector MCP server running on stdio");
