import fs from "node:fs";
import path from "node:path";
export const loadPromptTemplate = (rootDir, name) =>
  fs.readFileSync(path.join(rootDir, "prompts", `${name}.md`), "utf8");
export const interpolateTemplate = (template, variables) =>
  template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => (Object.hasOwn(variables, key) ? variables[key] : ""));

export function buildTaskPrompt(task, options = {}) {
  const text = String(task ?? "").trim() || "Continue the prior task.";
  if (!options.write) {
    return [
      "You are a read-only research agent. Investigate the task and return a concise, evidence-backed answer.",
      `<task>\n${text}\n</task>`,
      [
        "Search the codebase and read the necessary files. Include file paths and line numbers where relevant.",
        "Do not edit files or run write commands. Do not run tests, builds, or type-checks merely as generic",
        "verification; run a command only when it is directly needed to answer the research question.",
      ].join(" "),
    ].join("\n\n");
  }

  const suppliedCriteria = String(options.successCriteria ?? "").trim();
  const criteria = suppliedCriteria
    ? suppliedCriteria
    : "Choose concrete success criteria appropriate to the task, state them explicitly, and verify against them.";
  return [
    "You are an autonomous executor agent. Complete the task fully, then verify your work before finishing.",
    `<task>\n${text}\n</task>`,
    `<success_criteria>\n${criteria}\n</success_criteria>`,
    [
      "INSTRUCTIONS:",
      "1. Perform the task using your available tools.",
      "2. Verify that the success criteria were met. Run the relevant tests, builds, type-checks, or other",
      "   commands where applicable; do not merely claim success.",
      "3. End your response with a prose section headed exactly `## Verification`. State the criteria you",
      "   verified, the commands or checks used, and the outcome. If no criteria were supplied, include the",
      "   criteria you chose. Keep the response as readable prose rather than machine-only output.",
    ].join("\n"),
  ].join("\n\n");
}
