import { MODEL_FAMILY_GROUPS } from "./agy.mjs";

function severityRank(severity) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity] ?? 4;
}

function formatLineRange(finding) {
  if (!finding.line_start) return "";
  if (!finding.line_end || finding.line_end === finding.line_start) return `:${finding.line_start}`;
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) return "Missing string `verdict`.";
  if (typeof data.summary !== "string" || !data.summary.trim()) return "Missing string `summary`.";
  if (!Array.isArray(data.findings)) return "Missing array `findings`.";
  if (!Array.isArray(data.next_steps)) return "Missing array `next_steps`.";
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;
  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title:
      typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : "",
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map(normalizeReviewFinding),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim()),
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  return Boolean(
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (Object.hasOwn(result, "result") || Object.hasOwn(result, "parseError")),
  );
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function resumeCommand(job) {
  return job?.conversationId ? `agy --conversation ${job.conversationId}` : null;
}

export function formatJobLine(job) {
  const parts = [job.id, job.status || "unknown"];
  if (job.kindLabel) parts.push(job.kindLabel);
  if (job.title) parts.push(job.title);
  return parts.join(" | ");
}

function formatUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : Number.NaN,
    thinking = typeof usage.thinking_tokens === "number" ? usage.thinking_tokens : Number.NaN;
  if (Number.isFinite(total)) {
    return `${total.toLocaleString("en-US")} total token${total === 1 ? "" : "s"}${Number.isFinite(thinking) && thinking > 0 ? ` (${thinking.toLocaleString("en-US")} thinking)` : ""}`;
  }
  if (Number.isFinite(thinking) && thinking > 0)
    return `${thinking.toLocaleString("en-US")} thinking token${thinking === 1 ? "" : "s"}`;
  return null;
}

function pushExecutionDetails(lines, job) {
  if (job.model) lines.push(`  Model used: ${job.model}`);
  const touchedFiles = Array.isArray(job.touchedFiles) ? job.touchedFiles : [];
  if (Array.isArray(job.touchedFiles) || job.write === false) {
    // Read-only jobs run behind `--mode plan --sandbox`, so an empty list there is a real
    // "nothing changed", not a gap. Only a write job whose git snapshot failed is genuinely
    // unknown — saying otherwise would imply a sandboxed job might have edited the tree.
    const filesChanged = touchedFiles.length
      ? touchedFiles.join(", ")
      : job.filesChangedVerified === true || job.write === false
        ? "no files modified"
        : "not detected (agy may have edited via shell commands)";
    lines.push(`  Files changed: ${filesChanged}`);
  }
  const usage = formatUsage(job.usage);
  if (usage) lines.push(`  Tokens: ${usage}`);
  if (typeof job.verification === "string" && job.verification.trim()) {
    lines.push("  Verification:");
    for (const line of job.verification.trim().split(/\r?\n/)) lines.push(`    ${line}`);
  }
}

function appendStoredResultMetadata(rendered, job, storedJob) {
  const details = [];
  const merged = { ...job, ...storedJob };
  if (merged.model && rendered.includes(`Model used: ${merged.model}`)) merged.model = null;
  pushExecutionDetails(details, merged);
  if (!details.length) return rendered;
  return `${rendered.trimEnd()}\n\n${details.map((line) => line.trimStart()).join("\n")}\n`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Antigravity Conversation ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/antigravity:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/antigravity:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase)} | ${escapeMarkdownCell(job.elapsed)} | ${escapeMarkdownCell(job.conversationId)} | ${escapeMarkdownCell(job.summary)} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`,
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) lines.push(`  Summary: ${job.summary}`);
  if (job.phase) lines.push(`  Phase: ${job.phase}`);
  if (options.showElapsed && job.elapsed) lines.push(`  Elapsed: ${job.elapsed}`);
  if (job.noOutputFor) lines.push(`  No output for: ${job.noOutputFor}`);
  if (options.showDuration && job.duration) lines.push(`  Duration: ${job.duration}`);
  if (job.errorMessage) lines.push(`  Reason: ${job.errorMessage}`);
  if (job.conversationId) {
    lines.push(`  Antigravity conversation ID: ${job.conversationId}`);
    lines.push(`  Continue in agy: ${resumeCommand(job)}`);
  }
  if (job.logFile && options.showLog) lines.push(`  Log: ${job.logFile}`);
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /antigravity:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /antigravity:result ${job.id}`);
  }
  if (
    job.status !== "queued" &&
    job.status !== "running" &&
    job.jobClass === "task" &&
    job.write &&
    options.showReviewHint
  ) {
    lines.push("  Review changes: /antigravity:review --wait");
    lines.push("  Stricter review: /antigravity:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) lines.push(`    ${line}`);
  }
  if (options.showExecutionDetails) pushExecutionDetails(lines, job);
}

export function renderSetupReport(report) {
  const lines = [
    "# Antigravity Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- agy: ${report.agy.detail}`,
    `- models/auth: ${report.models.detail}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    "",
  ];
  if (report.agyConfiguredDefault) {
    const family = MODEL_FAMILY_GROUPS.find((item) => item.id === report.agyConfiguredDefault.family);
    lines.push(
      `agy configured default: ${report.agyConfiguredDefault.model} (${family ? `${family.label} pool` : "unknown family"})`,
      "",
    );
  }
  if (report.models?.models?.length) {
    lines.push("Models by quota family (observed with agy 1.1.18):");
    for (const family of MODEL_FAMILY_GROUPS) {
      lines.push(`- ${family.label} pool:`);
      for (const model of report.models.groups?.[family.id] ?? []) {
        lines.push(`  - ${model.slug} — ${model.label}`);
      }
    }
    if (report.models.groups?.unknown?.length) {
      lines.push("- Unknown family:");
      for (const model of report.models.groups.unknown) lines.push(`  - ${model.slug} — ${model.label}`);
    }
    lines.push("");
  }
  if (report.actionsTaken?.length) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) lines.push(`- ${action}`);
    lines.push("");
  }
  if (report.nextSteps?.length) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) lines.push(`- ${step}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Antigravity ${meta.reviewLabel}`,
      "",
      ...(meta.model ? [`Model used: ${meta.model}`, ""] : []),
      "Antigravity did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`,
    ];
    if (meta.failureMessage) lines.push("", meta.failureMessage);
    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Antigravity ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      ...(meta.model ? [`Model used: ${meta.model}`] : []),
      "Antigravity returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`,
    ];
    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity),
  );
  const lines = [
    `# Antigravity ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ...(meta.model ? [`Model used: ${meta.model}`] : []),
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    "",
  ];
  if (!findings.length) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${formatLineRange(finding)})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) lines.push(`  Recommendation: ${finding.recommendation}`);
    }
  }
  if (data.next_steps.length) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) lines.push(`- ${step}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    const lines = [rawOutput.trimEnd()];
    if (parsedResult.model) lines.push("", `Model used: ${parsedResult.model}`);
    if (parsedResult.verification) {
      lines.push("", "Verification summary:", parsedResult.verification.trim());
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }
  const message =
    String(parsedResult?.failureMessage ?? "").trim() || "Antigravity did not return a final message.";
  return `${message}${parsedResult?.model ? `\n\nModel used: ${parsedResult.model}` : ""}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# Antigravity Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    "",
  ];
  if (report.running.length) {
    appendActiveJobsTable(lines, report.running);
    lines.push("", "Live details:");
    for (const job of report.running) pushJobDetails(lines, job, { showElapsed: true, showLog: true });
    lines.push("");
  }
  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed",
    });
    lines.push("");
  }
  if (report.recent.length) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, { showDuration: true, showLog: job.status === "failed" });
    }
    lines.push("");
  } else if (!report.running.length && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }
  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push(
      "Ending the session will trigger a fresh Antigravity adversarial review and block if it finds issues.",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Antigravity Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true,
    showExecutionDetails: true,
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const conversationId = storedJob?.conversationId ?? job.conversationId ?? null;
  const continuation = conversationId ? `agy --conversation ${conversationId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const rendered = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    const withConversation = conversationId
      ? `${rendered}\nAntigravity conversation ID: ${conversationId}\nContinue in agy: ${continuation}\n`
      : rendered;
    return appendStoredResultMetadata(withConversation, job, storedJob);
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.agy?.response === "string" && storedJob.result.agy.response) ||
    "";
  if (rawOutput) {
    const rendered = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    const withConversation = conversationId
      ? `${rendered}\nAntigravity conversation ID: ${conversationId}\nContinue in agy: ${continuation}\n`
      : rendered;
    return appendStoredResultMetadata(withConversation, job, storedJob);
  }
  if (storedJob?.rendered) {
    const rendered = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    const withConversation = conversationId
      ? `${rendered}\nAntigravity conversation ID: ${conversationId}\nContinue in agy: ${continuation}\n`
      : rendered;
    return appendStoredResultMetadata(withConversation, job, storedJob);
  }

  const lines = [`# ${job.title ?? "Antigravity Result"}`, "", `Job: ${job.id}`, `Status: ${job.status}`];
  if (conversationId) {
    lines.push(`Antigravity conversation ID: ${conversationId}`);
    lines.push(`Continue in agy: ${continuation}`);
  }
  if (job.summary) lines.push(`Summary: ${job.summary}`);
  const executionDetails = [];
  pushExecutionDetails(executionDetails, { ...job, ...storedJob });
  lines.push(...executionDetails.map((line) => line.trimStart()));
  lines.push(
    "",
    job.errorMessage ?? storedJob?.errorMessage ?? "No captured result payload was stored for this job.",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = ["# Antigravity Cancel", "", `Cancelled ${job.id}.`, ""];
  if (job.title) lines.push(`- Title: ${job.title}`);
  if (job.summary) lines.push(`- Summary: ${job.summary}`);
  lines.push("- Check `/antigravity:status` for the updated queue.");
  return `${lines.join("\n").trimEnd()}\n`;
}
