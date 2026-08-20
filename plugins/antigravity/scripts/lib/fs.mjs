import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const ensureAbsolutePath = (cwd, value) => (path.isAbsolute(value) ? value : path.resolve(cwd, value));
export const createTempDir = (prefix = "agy-plugin-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const writeJsonFile = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
export const safeReadFile = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
export function isProbablyText(buffer) {
  return !buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}
export function readStdinIfPiped() {
  return process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
}
