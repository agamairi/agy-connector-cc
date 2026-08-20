import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "agy-plugin-test-"));
export const fixturePath = path.resolve("tests/fake-agy-fixture.mjs");

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true,
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Antigravity Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
}
