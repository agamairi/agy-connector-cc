import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

// The prompt is handed to agy as a single argv entry, and execve caps the whole argument block
// (1 MiB on macOS — measured E2BIG just above that). Keep the evidence well below that limit.
export const MAX_REVIEW_CONTENT_BYTES = 384 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error?.code === "ENOBUFS") return maxBytes + 1;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(formatCommandFailure(result));
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) return maxBytes + 1;
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) return totalBytes;
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`,
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error?.code === "ENOENT") throw new Error("git is not installed. Install Git and retry.");
  if (result.status !== 0) throw new Error("This command must run inside a Git repository.");
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  for (const candidate of ["main", "master", "trunk"]) {
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0) {
      return candidate;
    }
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]).status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error(
    "Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.",
  );
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);
  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);

  if (baseRef) {
    return { mode: "branch", label: `branch diff against ${baseRef}`, baseRef, explicit: true };
  }
  if (requestedScope === "working-tree") {
    return { mode: "working-tree", label: "working tree diff", explicit: true };
  }
  if (!["auto", "working-tree", "branch"].includes(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`,
    );
  }
  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true,
    };
  }
  if (state.isDirty) {
    return { mode: "working-tree", label: "working tree diff", explicit: false };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false,
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) return `### ${relativePath}\n(skipped: directory)`;
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) return `### ${relativePath}\n(skipped: binary file)`;
  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, includeDiff) {
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
  const parts = includeDiff
    ? [
        formatSection("Git Status", status),
        formatSection(
          "Staged Diff",
          gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout,
        ),
        formatSection(
          "Unstaged Diff",
          gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout,
        ),
        formatSection("Untracked Files", untrackedBody),
      ]
    : [
        formatSection("Git Status", status),
        formatSection("Staged Diff Stat", gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout),
        formatSection("Unstaged Diff Stat", gitChecked(cwd, ["diff", "--shortstat"]).stdout),
        formatSection("Changed Files", changedFiles.join("\n")),
        formatSection("Untracked Files", untrackedBody),
      ];
  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles,
  };
}

function collectBranchContext(cwd, baseRef, comparison, includeDiff) {
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout;
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout;
  const sections = [formatSection("Commit Log", logOutput), formatSection("Diff Stat", diffStat)];
  sections.push(
    includeDiff
      ? formatSection(
          "Branch Diff",
          gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange])
            .stdout,
        )
      : formatSection("Changed Files", changedFiles.join("\n")),
  );
  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: sections.join("\n"),
    changedFiles,
    comparison,
  };
}

export function capReviewContent(content, maxBytes = MAX_REVIEW_CONTENT_BYTES) {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength <= maxBytes) return { content, truncated: false };
  // Slice on a character boundary so a multi-byte sequence is never cut in half.
  const head = new TextDecoder("utf-8").decode(buffer.subarray(0, maxBytes)).replace(/�$/, "");
  const dropped = buffer.byteLength - maxBytes;
  return {
    content: `${head}\n\n[TRUNCATED: ${dropped} more bytes of diff were omitted to stay within the CLI argument limit. Review what is shown and say explicitly that the diff was truncated.]`,
    truncated: true,
  };
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const maxInlineFiles = normalizeLimit(options.maxInlineFiles, DEFAULT_INLINE_DIFF_MAX_FILES);
  const maxInlineDiffBytes = normalizeLimit(options.maxInlineDiffBytes, DEFAULT_INLINE_DIFF_MAX_BYTES);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"],
      ],
      maxInlineDiffBytes,
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, includeDiff);
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange])
      .stdout.trim()
      .split("\n")
      .filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes,
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, comparison, includeDiff);
  }

  const bounded = capReviewContent(details.content, options.maxContentBytes);
  return {
    cwd: repoRoot,
    repoRoot,
    branch: getCurrentBranch(repoRoot),
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: includeDiff
      ? "Use the repository context below as primary evidence."
      : "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.",
    ...details,
    content: bounded.content,
    truncated: bounded.truncated,
  };
}
