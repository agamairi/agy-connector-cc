import fs from "node:fs";
import path from "node:path";
export const loadPromptTemplate = (rootDir, name) =>
  fs.readFileSync(path.join(rootDir, "prompts", `${name}.md`), "utf8");
export const interpolateTemplate = (template, variables) =>
  template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => (Object.hasOwn(variables, key) ? variables[key] : ""));
