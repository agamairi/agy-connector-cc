import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceRoot } from "./workspace.mjs";
const fallback = path.join(os.tmpdir(), "agy-companion"),
  maxJobs = 50;
const defaults = () => ({ version: 1, config: { stopReviewGate: false }, jobs: [] });
export function resolveStateDir(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  let real = root;
  try {
    real = fs.realpathSync.native(root);
  } catch {}
  const slug =
    (path.basename(root) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "workspace";
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 16);
  // CLAUDE_PLUGIN_DATA is a shared variable name: the harness points it at this plugin's own
  // directory when it runs our commands and hooks, but a companion invoked by hand from a shell
  // inherits whatever value that shell already had — which in practice can be another plugin's
  // data dir. Namespacing under "antigravity" keeps our jobs out of a neighbour's state.json
  // instead of silently interleaving two plugins' job lists in one file.
  return path.join(
    process.env.CLAUDE_PLUGIN_DATA
      ? path.join(process.env.CLAUDE_PLUGIN_DATA, "state", "antigravity")
      : fallback,
    `${slug}-${hash}`,
  );
}
export const resolveStateFile = (cwd) => path.join(resolveStateDir(cwd), "state.json");
export const resolveJobsDir = (cwd) => path.join(resolveStateDir(cwd), "jobs");
export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}
export function resolveJobFile(cwd, id) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${id}.json`);
}
export function resolveJobLogFile(cwd, id) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${id}.log`);
}
export function loadState(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveStateFile(cwd), "utf8"));
    return {
      ...defaults(),
      ...parsed,
      config: { ...defaults().config, ...(parsed.config ?? {}) },
      jobs: Array.isArray(parsed.jobs)
        ? parsed.jobs.filter(
            (job) => job && typeof job === "object" && !Array.isArray(job) && typeof job.id === "string",
          )
        : [],
    };
  } catch {
    return defaults();
  }
}
export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const next = {
    version: 1,
    config: { ...defaults().config, ...(state.config ?? {}) },
    jobs: [...(state.jobs ?? [])]
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
      .slice(0, maxJobs),
  };
  const retainedIds = new Set(next.jobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) continue;
    const jobFile = resolveJobFile(cwd, job.id);
    if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile);
    if (job.logFile && fs.existsSync(job.logFile)) fs.unlinkSync(job.logFile);
  }
  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}
export const generateJobId = (prefix = "job") =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export function upsertJob(cwd, patch) {
  return updateState(cwd, (state) => {
    const at = new Date().toISOString(),
      index = state.jobs.findIndex((job) => job.id === patch.id);
    if (index < 0) state.jobs.unshift({ createdAt: at, updatedAt: at, ...patch });
    else state.jobs[index] = { ...state.jobs[index], ...patch, updatedAt: at };
  });
}
export const listJobs = (cwd) => loadState(cwd).jobs;
export const getConfig = (cwd) => loadState(cwd).config;
export const setConfig = (cwd, key, value) =>
  updateState(cwd, (s) => {
    s.config = { ...s.config, [key]: value };
  });
export const writeJobFile = (cwd, id, value) => {
  const file = resolveJobFile(cwd, id);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};
export const readJobFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
