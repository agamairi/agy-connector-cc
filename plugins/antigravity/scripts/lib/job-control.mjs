import fs from "node:fs";
import { parseDurationMs } from "./agy.mjs";
import { getProcessIdentity, isProcessAlive } from "./process.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "./state.mjs";
import { appendLogLine, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const DEFAULT_INACTIVITY_TIMEOUT = "15m";
export const DEFAULT_NO_PID_REAP_TIMEOUT = "5m";
export const DEFAULT_UNVERIFIED_PID_MAX_AGE = "1h";

export const sortJobsNewestFirst = (jobs) =>
  [...jobs].sort((a, b) =>
    String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")),
  );
export const isActiveJob = (job) => job.status === "queued" || job.status === "running";

function ageMs(value, now) {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) ? Math.max(0, now - at) : Number.POSITIVE_INFINITY;
}

function signalProcessTree(pid, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== "win32") {
    try {
      killImpl(-pid, "SIGTERM");
      return true;
    } catch {}
  }
  try {
    killImpl(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function persistReconciledJob(root, job, status, reason, now) {
  const completedAt = new Date(now).toISOString();
  const patch = {
    id: job.id,
    status,
    phase: status,
    pid: null,
    completedAt,
    errorMessage: reason,
  };
  const stored = readStoredJob(root, job.id);
  if (stored) writeJobFile(root, job.id, { ...stored, ...patch });
  upsertJob(root, patch);
  appendLogLine(job.logFile ?? stored?.logFile, reason);
  return { ...job, ...patch, updatedAt: completedAt };
}

export function reconcileActiveJobs(cwd, options = {}) {
  const root = resolveWorkspaceRoot(cwd);
  const now = options.nowMs?.() ?? Date.now();
  const env = options.env ?? process.env;
  const inactivityTimeoutMs = parseDurationMs(
    options.inactivityTimeout ?? env.AGY_INACTIVITY_TIMEOUT ?? DEFAULT_INACTIVITY_TIMEOUT,
  );
  const noPidTimeoutMs = parseDurationMs(
    options.noPidTimeout ?? env.AGY_NO_PID_REAP_TIMEOUT ?? DEFAULT_NO_PID_REAP_TIMEOUT,
  );
  const unverifiedPidMaxAgeMs = parseDurationMs(
    options.unverifiedPidMaxAge ?? env.AGY_UNVERIFIED_PID_MAX_AGE ?? DEFAULT_UNVERIFIED_PID_MAX_AGE,
  );
  const processAlive = options.isProcessAlive ?? isProcessAlive;
  const processIdentity = options.getProcessIdentity ?? getProcessIdentity;
  const terminate = options.terminateProcess ?? ((pid) => signalProcessTree(pid, options));

  return listJobs(root).map((job) => {
    if (!isActiveJob(job)) return job;
    const activeSince = job.startedAt ?? job.createdAt ?? job.updatedAt;
    const silentSince = job.lastEventAt ?? activeSince;
    const activeAge = ageMs(activeSince, now);
    const silentAge = ageMs(silentSince, now);
    if (!Number.isInteger(job.pid) || job.pid <= 0) {
      if (activeAge < noPidTimeoutMs) return job;
      return persistReconciledJob(
        root,
        job,
        "interrupted",
        "Worker process never reported a PID or result.",
        now,
      );
    }
    if (!processAlive(job.pid)) {
      return persistReconciledJob(
        root,
        job,
        "interrupted",
        "Worker process exited without reporting a result.",
        now,
      );
    }

    const liveIdentity = processIdentity(job.pid);
    if (job.pidIdentity && liveIdentity && job.pidIdentity !== liveIdentity) {
      return persistReconciledJob(
        root,
        job,
        "interrupted",
        "Worker PID was reused by a different process before a result was reported.",
        now,
      );
    }
    // Some platforms do not expose process birth identity portably (and hardened macOS sandboxes
    // can deny `ps`). Once such a record is both old and inactive, reconcile it without signalling
    // the possibly unrelated process. A long job that keeps emitting events remains healthy.
    if (
      (!job.pidIdentity || !liveIdentity) &&
      activeAge >= unverifiedPidMaxAgeMs &&
      silentAge >= inactivityTimeoutMs
    ) {
      return persistReconciledJob(
        root,
        job,
        "interrupted",
        "Worker PID could not be verified and the job exceeded the safe liveness window.",
        now,
      );
    }
    if (silentAge >= inactivityTimeoutMs) {
      terminate(job.pid);
      return persistReconciledJob(
        root,
        job,
        "stalled",
        `Worker produced no output for ${formatElapsedDuration(silentSince, new Date(now).toISOString())}.`,
        now,
      );
    }
    return job;
  });
}

function currentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = currentSessionId(options);
  return sessionId ? jobs.filter((job) => job.sessionId === sessionId) : jobs;
}

export function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) return job.kindLabel;
  if (job.kind === "adversarial-review") return "adversarial-review";
  if (job.jobClass === "review" || job.kind === "review") return "review";
  if (job.jobClass === "task" || job.kind === "task") return "rescue";
  return "job";
}

export function stripLogPrefix(line) {
  return String(line ?? "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();
}

export function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ (?:message|reasoning summary)$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) return [];
  try {
    return fs
      .readFileSync(logFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .filter((line) => line.startsWith("["))
      .map(stripLogPrefix)
      .filter((line) => line && !isProgressBlockTitle(line))
      .slice(-maxLines);
  } catch {
    return [];
  }
}

export function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? ""),
    end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000)),
    hours = Math.floor(totalSeconds / 3600),
    minutes = Math.floor((totalSeconds % 3600) / 60),
    seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

const looksLikeVerificationCommand = (line) =>
  /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line,
  );

export function inferLegacyJobPhase(job, progressPreview = []) {
  if (job.status === "queued") return "queued";
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "interrupted") return "interrupted";
  if (job.status === "stalled") return "stalled";
  if (job.status === "failed") return "failed";
  if (job.status === "completed") return "done";
  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("conversation ") || line.startsWith("starting ")) return "starting";
    if (line.startsWith("verifying:")) return "verifying";
    if (line.startsWith("running:")) return looksLikeVerificationCommand(line) ? "verifying" : "running";
    if (
      line.startsWith("reading ") ||
      line.startsWith("listing ") ||
      line.startsWith("searching ") ||
      line.startsWith("finding ")
    )
      return job.jobClass === "review" ? "reviewing" : "investigating";
    if (line.startsWith("editing ")) return "editing";
    if (line.startsWith("error:") || line.startsWith("failed")) return "failed";
    if (line.endsWith("completed.")) return "finalizing";
  }
  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const progressPreview = ["queued", "running", "failed"].includes(job.status)
    ? readJobProgressPreview(job.logFile, options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES)
    : [];
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, isActiveJob(job) ? null : job.completedAt),
    noOutputFor: isActiveJob(job)
      ? formatElapsedDuration(job.lastEventAt ?? job.startedAt ?? job.createdAt)
      : null,
    duration: isActiveJob(job)
      ? null
      : formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt),
    progressPreview,
  };
  return { ...enriched, phase: enriched.phase ?? inferLegacyJobPhase(enriched, progressPreview) };
}

export function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) return filtered[0] ?? null;
  const exact = filtered.find((job) => job.id === reference);
  if (exact) return exact;
  const prefixes = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixes.length === 1) return prefixes[0];
  if (prefixes.length > 1) throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  return null;
}
export const readStoredJob = (root, id) => {
  const file = resolveJobFile(root, id);
  if (!fs.existsSync(file)) return null;
  try {
    return readJobFile(file);
  } catch {
    return null;
  }
};
export function buildStatusSnapshot(cwd, options = {}) {
  const root = resolveWorkspaceRoot(cwd),
    jobs = sortJobsNewestFirst(filterJobsForCurrentSession(reconcileActiveJobs(root, options), options)),
    running = jobs.filter(isActiveJob).map((job) => enrichJob(job, options)),
    finished = jobs.filter((job) => !isActiveJob(job)),
    latestFinished = finished[0] ? enrichJob(finished[0], options) : null,
    recent = (options.all ? jobs : jobs.slice(0, options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS))
      .filter((job) => !isActiveJob(job) && job.id !== latestFinished?.id)
      .map((job) => enrichJob(job, options));
  return {
    workspaceRoot: root,
    config: getConfig(root),
    sessionRuntime: { label: "local agy CLI" },
    running,
    latestFinished,
    recent,
    needsReview: Boolean(getConfig(root).stopReviewGate),
  };
}
export function buildSingleJobSnapshot(cwd, ref, options = {}) {
  const root = resolveWorkspaceRoot(cwd),
    job = matchJobReference(sortJobsNewestFirst(reconcileActiveJobs(root, options)), ref);
  if (!job) throw new Error(`No job found for "${ref}". Run /antigravity:status to inspect known jobs.`);
  return { workspaceRoot: root, job: enrichJob(job, options) };
}
export function resolveResultJob(cwd, ref) {
  const root = resolveWorkspaceRoot(cwd),
    reconciled = reconcileActiveJobs(root),
    jobs = sortJobsNewestFirst(ref ? reconciled : filterJobsForCurrentSession(reconciled)),
    job = matchJobReference(jobs, ref, (job) => !isActiveJob(job));
  if (job) return { workspaceRoot: root, job };
  const existing = matchJobReference(jobs, ref);
  if (existing) throw new Error(`Job ${existing.id} is still ${existing.status}.`);
  throw new Error(
    ref
      ? `No finished job found for "${ref}".`
      : "No finished Antigravity jobs found for this repository yet.",
  );
}
export function resolveCancelableJob(cwd, ref, options = {}) {
  const root = resolveWorkspaceRoot(cwd),
    jobs = sortJobsNewestFirst(reconcileActiveJobs(root, options)).filter(isActiveJob);
  if (ref) {
    const job = matchJobReference(jobs, ref);
    if (!job) throw new Error(`No active job found for "${ref}".`);
    return { workspaceRoot: root, job };
  }

  const sessionJobs = filterJobsForCurrentSession(jobs, options);
  if (sessionJobs.length === 1) return { workspaceRoot: root, job: sessionJobs[0] };
  if (sessionJobs.length > 1)
    throw new Error("Multiple Antigravity jobs are active. Pass a job id to /antigravity:cancel.");
  if (currentSessionId(options)) throw new Error("No active Antigravity jobs to cancel for this session.");
  throw new Error("No active Antigravity jobs to cancel.");
}
