import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";

async function withIsolatedHome(callback) {
  const home = makeTempDir();
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const moduleUrl = new URL(
      `../plugins/antigravity/scripts/lib/claude-session-transfer.mjs?home=${encodeURIComponent(home)}`,
      import.meta.url,
    );
    const moduleExports = await import(moduleUrl);
    return await callback({ home, ...moduleExports });
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("rejects a jsonl outside ~/.claude/projects", async () => {
  await withIsolatedHome(({ home, resolveClaudeSessionPath }) => {
    fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    const outside = path.join(os.tmpdir(), `escape-${Date.now()}.jsonl`);
    fs.writeFileSync(outside, "{}\n");
    try {
      assert.throws(() => resolveClaudeSessionPath(process.cwd(), { source: outside }), /only from/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

test("accepts a real transcript inside ~/.claude/projects", async () => {
  await withIsolatedHome(({ home, resolveClaudeSessionPath }) => {
    const dir = path.join(home, ".claude", "projects", "xfer-probe");
    fs.mkdirSync(dir, { recursive: true });
    const inside = path.join(dir, "s.jsonl");
    fs.writeFileSync(inside, "{}\n");
    assert.equal(resolveClaudeSessionPath(process.cwd(), { source: inside }), fs.realpathSync(inside));
  });
});

test("rejects a symlink that escapes the projects dir", async () => {
  await withIsolatedHome(({ home, resolveClaudeSessionPath }) => {
    const target = path.join(os.tmpdir(), `secret-${Date.now()}.jsonl`);
    fs.writeFileSync(target, "{}\n");
    try {
      const dir = path.join(home, ".claude", "projects", "xfer-link");
      fs.mkdirSync(dir, { recursive: true });
      const link = path.join(dir, "link.jsonl");
      fs.symlinkSync(target, link);
      assert.throws(() => resolveClaudeSessionPath(process.cwd(), { source: link }), /only from/);
    } finally {
      fs.rmSync(target, { force: true });
    }
  });
});

// Regression: a real Claude session measured 1.9 MB against a 512 KB argv ceiling, so an
// uncapped replay makes /antigravity:transfer fail outright on any non-trivial session.
test("caps the rendered transcript and keeps the most recent turns", async () => {
  await withIsolatedHome(({ home, renderTranscriptAsPrompt }) => {
    const dir = path.join(home, ".claude", "projects", "xfer-size");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "big.jsonl");
    const lines = [];
    for (let i = 0; i < 400; i += 1)
      lines.push(JSON.stringify({ type: "user", message: { content: `msg-${i} ${"x".repeat(400)}` } }));
    fs.writeFileSync(file, lines.join("\n") + "\n");

    const rendered = renderTranscriptAsPrompt(file, 16 * 1024);
    assert.ok(Buffer.byteLength(rendered, "utf8") < 20 * 1024, "stays within budget");
    assert.match(rendered, /earlier message\(s\) omitted/);
    assert.ok(rendered.includes("msg-399"), "keeps the newest message");
    assert.ok(!rendered.includes("msg-0 "), "drops the oldest message");
  });
});
