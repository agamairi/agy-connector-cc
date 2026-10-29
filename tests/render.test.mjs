import assert from "node:assert/strict";
import test from "node:test";
import {
  formatJobLine,
  renderJobStatusReport,
  renderReviewResult,
  renderStoredJobResult,
} from "../plugins/antigravity/scripts/lib/render.mjs";
test("renders reviews in severity order", () => {
  const text = renderReviewResult(
    {
      parsed: {
        verdict: "needs work",
        summary: "two issues",
        findings: [
          { severity: "low", title: "L", body: "l", file: "a", line_start: 1, line_end: 1 },
          { severity: "high", title: "H", body: "h", file: "b", line_start: 2, line_end: 2 },
        ],
        next_steps: [],
      },
    },
    { reviewLabel: "Review", targetLabel: "working tree" },
  );
  assert.ok(text.indexOf("[high]") < text.indexOf("[low]"));
});

test("renders a clean review without a findings heading", () => {
  const text = renderReviewResult(
    {
      parsed: { verdict: "pass", summary: "No issues found.", findings: [], next_steps: [] },
      rawOutput: '{"verdict":"pass"}',
      parseError: null,
    },
    { reviewLabel: "Review", targetLabel: "working tree" },
  );

  assert.match(text, /No material findings\./);
  assert.doesNotMatch(text, /^Findings:/m);
});

test("renders raw output when the review response cannot be parsed", () => {
  const text = renderReviewResult(
    { parsed: null, rawOutput: "not valid JSON", parseError: "Unexpected token o" },
    { reviewLabel: "Review", targetLabel: "working tree" },
  );

  assert.match(text, /did not return valid structured JSON/);
  assert.match(text, /Raw final message:/);
  assert.match(text, /not valid JSON/);
});
test("includes an agy continuation command", () => {
  assert.match(
    renderStoredJobResult({ conversationId: "abc" }, { rendered: "done" }),
    /agy --conversation abc/,
  );
});

test("formats compact job identity lines", () => {
  assert.equal(
    formatJobLine({ id: "task-1", status: "running", kindLabel: "rescue", title: "Fix auth" }),
    "task-1 | running | rescue | Fix auth",
  );
  assert.equal(formatJobLine({ id: "job-1" }), "job-1 | unknown");
});

test("stored results render touched files and compact token usage", () => {
  const rendered = renderStoredJobResult(
    { id: "task-1", status: "completed", write: true },
    {
      rendered: "finished",
      touchedFiles: ["src/app.js", "tests/app.test.js"],
      usage: { total_tokens: 24670, thinking_tokens: 425 },
    },
  );
  assert.match(rendered, /Files changed: src\/app\.js, tests\/app\.test\.js/);
  assert.match(rendered, /Tokens: 24,670 total tokens \(425 thinking\)/);
});

test("renders the verified-empty and unverified Files changed states", () => {
  const verified = renderStoredJobResult(
    { id: "task-verified", status: "completed", write: true },
    { rendered: "clean", touchedFiles: [], filesChangedVerified: true },
  );
  assert.match(verified, /Files changed: no files modified/);

  // A write job whose git snapshot failed is the only genuinely unknown case.
  const unverified = renderStoredJobResult(
    { id: "task-unverified", status: "completed", write: true },
    { rendered: "clean", touchedFiles: [], filesChangedVerified: false },
  );
  assert.match(unverified, /Files changed: not detected \(agy may have edited via shell commands\)/);

  const job = {
    id: "review-1",
    status: "completed",
    kindLabel: "review",
    write: false,
    touchedFiles: [],
    usage: { total_tokens: 10, thinking_tokens: 0 },
  };
  // Read-only jobs are write-barriered, so they must not hint at unseen shell edits.
  assert.match(renderStoredJobResult(job, { rendered: "clean", ...job }), /Files changed: no files modified/);
  const status = renderJobStatusReport(job);
  assert.match(status, /Files changed: no files modified/);
  assert.doesNotMatch(status, /not detected/);
  assert.match(status, /Tokens: 10 total tokens/);
  assert.doesNotMatch(status, /thinking/);
});

test("usage rendering tolerates absent and partial usage objects", () => {
  const absent = renderStoredJobResult(
    { id: "legacy", status: "completed", write: true },
    { rendered: "legacy" },
  );
  const partial = renderStoredJobResult(
    { id: "partial", status: "completed", write: true },
    { rendered: "partial", usage: { thinking_tokens: 7 } },
  );
  assert.doesNotMatch(absent, /Tokens:/);
  assert.match(partial, /Tokens: 7 thinking tokens/);
});
