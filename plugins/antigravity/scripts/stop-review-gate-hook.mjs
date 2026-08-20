#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { getAgyAvailability, parseStructuredOutput, runAgy } from "./lib/agy.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { loadPromptTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");

export function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

export function logNote(message) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
}

export function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  return sessionId ? jobs.filter((job) => job.sessionId === sessionId) : jobs;
}

export function buildSetupNote(cwd) {
  const availability = getAgyAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Antigravity is not set up for the review gate.${detail} Run /antigravity:setup.`;
}

function buildStopReviewPrompt(input = {}) {
  const priorResponse = String(input.last_assistant_message ?? "").trim();
  const priorResponseBlock = priorResponse ? `\n\nPrevious Claude response:\n${priorResponse}` : "";
  return `${loadPromptTemplate(PLUGIN_ROOT, "stop-review-gate").trim()}${priorResponseBlock}`;
}

export async function runStopReview(cwd, input = {}) {
  const result = await runAgy(cwd, {
    prompt: buildStopReviewPrompt(input),
    readOnly: true,
    schemaPath: path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"),
  });

  if (result.exitStatus !== 0) {
    const detail = String(result.error || result.stderr || "").trim();
    return {
      ok: true,
      skipped: true,
      reason: detail
        ? `The stop-time Antigravity review failed: ${detail}`
        : "The stop-time Antigravity review failed. Run /antigravity:review manually or bypass the gate.",
    };
  }

  const parsed = parseStructuredOutput(result.response);
  if (!parsed.parsed || !Array.isArray(parsed.parsed.findings)) {
    return {
      ok: false,
      reason:
        "The stop-time Antigravity review returned invalid structured output. Run /antigravity:review manually or bypass the gate.",
    };
  }

  if (parsed.parsed.findings.length) {
    return {
      ok: false,
      reason: `Antigravity review gate found ${parsed.parsed.findings.length} issue(s).`,
    };
  }

  return { ok: true, reason: null };
}

export async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Antigravity task ${runningJob.id} is still running. Check /antigravity:status and use /antigravity:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  try {
    const review = await runStopReview(workspaceRoot, input);
    if (review.skipped) {
      logNote(`Antigravity review gate skipped: ${review.reason}`);
      logNote(runningTaskNote);
      return;
    }
    if (!review.ok) {
      emitDecision({
        decision: "block",
        reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason,
      });
      return;
    }
  } catch (error) {
    // A review gate must not trap a session merely because the external CLI becomes unavailable.
    logNote(`Antigravity review gate skipped: ${error instanceof Error ? error.message : String(error)}`);
    logNote(runningTaskNote);
    return;
  }

  logNote(runningTaskNote);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
