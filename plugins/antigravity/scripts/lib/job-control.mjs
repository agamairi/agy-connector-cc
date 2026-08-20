import fs from "node:fs";
import { getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export const sortJobsNewestFirst = (jobs) =>
  [...jobs].sort((a, b) =>
    String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")),
  );
const active = (job) => job.status === "queued" || job.status === "running";

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
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, active(job) ? null : job.completedAt),
    duration: active(job)
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
    jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(root), options)),
    running = jobs.filter(active).map((job) => enrichJob(job, options)),
    finished = jobs.filter((job) => !active(job)),
    latestFinished = finished[0] ? enrichJob(finished[0], options) : null,
    recent = (options.all ? jobs : jobs.slice(0, options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS))
      .filter((job) => !active(job) && job.id !== latestFinished?.id)
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
    job = matchJobReference(sortJobsNewestFirst(listJobs(root)), ref);
  if (!job) throw new Error(`No job found for "${ref}". Run /antigravity:status to inspect known jobs.`);
  return { workspaceRoot: root, job: enrichJob(job, options) };
}
export function resolveResultJob(cwd, ref) {
  const root = resolveWorkspaceRoot(cwd),
    jobs = sortJobsNewestFirst(ref ? listJobs(root) : filterJobsForCurrentSession(listJobs(root))),
    job = matchJobReference(jobs, ref, (job) => !active(job));
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
    jobs = sortJobsNewestFirst(listJobs(root)).filter(active);
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
