import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  binaryAvailable,
  formatCommandFailure,
  terminateProcessTree,
} from "../plugins/antigravity/scripts/lib/process.mjs";
test("reports missing binaries", () =>
  assert.equal(binaryAvailable("definitely-not-a-binary").available, false));
test("formats command failure", () =>
  assert.match(formatCommandFailure({ command: "x", args: [], status: 2, stderr: "bad" }), /bad/));

test(
  "escalates cancellation to SIGKILL when a process group ignores SIGTERM",
  { skip: process.platform === "win32" },
  async () => {
    const child = spawn(process.execPath, [path.resolve("tests/ignore-term-fixture.mjs")], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await once(child.stdout, "data");
      const closed = once(child, "close");
      const result = await terminateProcessTree(child.pid, {
        gracePeriodMs: 120,
        pollIntervalMs: 10,
      });
      await closed;
      assert.equal(result.method, "process-group");
      assert.equal(result.delivered, true);
      assert.equal(result.escalated, true);
      assert.equal(child.signalCode, "SIGKILL");
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  },
);
