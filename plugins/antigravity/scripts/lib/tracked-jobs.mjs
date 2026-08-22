import fs from "node:fs";
import process from "node:process";
import { getProcessIdentity } from "./process.mjs";
import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";
export const SESSION_ID_ENV = "ANTIGRAVITY_COMPANION_SESSION_ID";
export const nowIso = () => new Date().toISOString();

export function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      conversationId:
        typeof value.conversationId === "string" && value.conversationId.trim()
          ? value.conversationId.trim()
          : null,
      model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd(),
    };
  }
  const message = String(value ?? "").trim();
  return {
    message,
    phase: null,
    conversationId: null,
    model: null,
    stderrMessage: message,
    logTitle: null,
    logBody: null,
  };
}
export const appendLogLine = (file, message) => {
  const value = String(message ?? "").trim();
  if (file && value) fs.appendFileSync(file, `[${nowIso()}] ${value}\n`);
};
export const appendLogBlock = (file, title, body) => {
  if (file && body) fs.appendFileSync(file, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`);
};
export function createJobLogFile(root, id, title) {
  const file = resolveJobLogFile(root, id);
  fs.writeFileSync(file, "");
  if (title) appendLogLine(file, `Starting ${title}.`);
  return file;
}
export function createJobRecord(base, options = {}) {
  const id = (options.env ?? process.env)[options.sessionIdEnv ?? SESSION_ID_ENV];
  return { ...base, createdAt: nowIso(), ...(id ? { sessionId: id } : {}) };
}
export function createJobProgressUpdater(root, id, options = {}) {
  let lastPhase = null,
    lastConversationId = null,
    lastModel = null;
  return (event) => {
    const normalized = normalizeProgressEvent(event),
      patch = { id, lastEventAt: (options.now ?? nowIso)() };
    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
    }
    if (normalized.conversationId && normalized.conversationId !== lastConversationId) {
      lastConversationId = normalized.conversationId;
      patch.conversationId = normalized.conversationId;
    }
    if (normalized.model && normalized.model !== lastModel) {
      lastModel = normalized.model;
      patch.model = normalized.model;
    }
    upsertJob(root, patch);
    const file = resolveJobFile(root, id);
    const stored = readStoredJobOrNull(root, id);
    if (stored) writeJobFile(root, id, { ...stored, ...patch });
  };
}
export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) return null;
  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage),
      message = event.message,
      stderrMessage = event.stderrMessage ?? message;
    // Streamed text deltas can span several lines, so prefix every one of them. Prefixing only
    // the first leaves continuation lines looking like stray output from the companion itself.
    if (stderr && stderrMessage)
      process.stderr.write(
        stderrMessage
          .split(/\r?\n/)
          .map((line) => `[agy] ${line}`)
          .join("\n") + "\n",
      );
    appendLogLine(logFile, message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

export function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) return null;
  try {
    return readJobFile(jobFile);
  } catch {
    return null;
  }
}

export async function runTrackedJob(job, runner, options = {}) {
  const startedAt = nowIso();
  const running = {
    ...job,
    status: "running",
    startedAt,
    lastEventAt: startedAt,
    phase: "starting",
    pid: process.pid,
    pidStartedAt: startedAt,
    pidIdentity: (options.getProcessIdentity ?? getProcessIdentity)(process.pid),
    logFile: options.logFile ?? job.logFile ?? null,
  };
  writeJobFile(job.workspaceRoot, job.id, running);
  upsertJob(job.workspaceRoot, running);
  try {
    const execution = await runner();
    const reconciled = readStoredJobOrNull(job.workspaceRoot, job.id);
    if (reconciled && !["queued", "running"].includes(reconciled.status) && reconciled.status !== "failed") {
      return execution;
    }
    const status = execution.stalled ? "stalled" : execution.exitStatus === 0 ? "completed" : "failed",
      completedAt = nowIso(),
      touchedFiles = Array.isArray(execution.touchedFiles) ? execution.touchedFiles : [],
      usage = execution.usage && typeof execution.usage === "object" ? execution.usage : null,
      model = execution.model ?? running.model ?? null,
      verification = execution.verification ?? null,
      errorMessage = status === "completed" ? null : String(execution.error ?? "").trim() || null;
    const final = {
      ...running,
      status,
      phase: status === "completed" ? "done" : status,
      pid: null,
      completedAt,
      lastEventAt: completedAt,
      conversationId: execution.conversationId ?? null,
      result: execution.payload,
      rendered: execution.rendered,
      touchedFiles,
      usage,
      model,
      verification,
      ...(errorMessage ? { errorMessage } : {}),
    };
    writeJobFile(job.workspaceRoot, job.id, final);
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status,
      phase: final.phase,
      pid: null,
      completedAt,
      lastEventAt: completedAt,
      conversationId: final.conversationId,
      summary: execution.summary,
      touchedFiles,
      usage,
      model,
      verification,
      ...(errorMessage ? { errorMessage } : {}),
    });
    appendLogBlock(running.logFile, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error),
      completedAt = nowIso();
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? running;
    if (!["queued", "running", "failed"].includes(existing.status)) throw error;
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      lastEventAt: completedAt,
      errorMessage: message,
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      lastEventAt: completedAt,
      errorMessage: message,
    });
    throw error;
  }
}
