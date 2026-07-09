# agy-connector-cc

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that lets any MCP client delegate **coding** and **research** tasks to the [Antigravity](https://antigravity.google) (`agy`) CLI, which runs as a **background autonomous agent**.

It implements an **orchestrator / executor** pattern: your primary agent (the MCP client) stays in control and offloads heavy, long-running work — sweeping refactors, multi-file edits, deep codebase research — to `agy`. Instead of streaming thousands of lines of terminal output back, `agy` returns a compact, structured JSON receipt, which keeps the orchestrator's context small.

## Why a job model?

`agy` runs are agentic and routinely take **minutes**. Running one synchronously inside a single MCP tool call exceeds the client's request timeout and drops the stdio connection (`-32000 Connection closed`).

This server avoids that: `antigravity_execute` and `antigravity_research` **spawn `agy` in the background and return a `job_id` immediately**. The client then polls `antigravity_result(job_id)` until the job is no longer `running`. Every MCP call returns fast, so long delegations never time out.

```
client → antigravity_execute(task, model, success_criteria)  →  { job_id, status: "running" }
client → antigravity_result(job_id)   →  { status: "running", partial_output_tail }   (poll…)
client → antigravity_result(job_id)   →  { status: "done", result: { …JSON receipt… } }
```

## ⚠️ Security

This server runs `agy` with **`--dangerously-skip-permissions`** — i.e. it launches a **fully autonomous coding agent with no per-action approval prompts**. Once connected, your MCP client can make `agy` read, write, and execute on your machine **without confirmation**.

- Only enable this connector in environments you trust, on repositories you're willing to let an autonomous agent modify.
- Treat the connected MCP client as having the same power over your machine that you've granted `agy`.
- Consider running it inside a container/VM or a disposable working copy if you're experimenting.

This is the connector's intended behavior (unattended delegation), but you should turn it on deliberately.

## Prerequisites

- **Node.js ≥ 18**
- The **Antigravity `agy` CLI**, installed and on your `PATH`, and **authenticated** (run `agy` once interactively to log in). Verify with:
  ```bash
  agy --version
  ```

## Install

```bash
git clone https://github.com/agamairi/agy-connector-cc.git
cd agy-connector-cc
npm install
```

## Configure your MCP client

Add the server to your client's MCP configuration. Most clients use a JSON block like this (use the **absolute path** to `server.mjs`):

```json
{
  "mcpServers": {
    "agy-connector": {
      "command": "node",
      "args": ["/absolute/path/to/agy-connector-cc/server.mjs"]
    }
  }
}
```

Restart / reconnect the client so it picks up the new server. You should then see the six `antigravity_*` tools.

## Tools

Valid `model` values are the exact labels printed by `agy models` — the CLI takes the display label as-is, not a slug:

- `Gemini 3.5 Flash (Low)`
- `Gemini 3.5 Flash (Medium)`
- `Gemini 3.5 Flash (High)`
- `Gemini 3.1 Pro (Low)`
- `Gemini 3.1 Pro (High)`
- `Claude Sonnet 4.6 (Thinking)`
- `Claude Opus 4.6 (Thinking)`
- `GPT-OSS 120B (Medium)`

Run `agy models` on your own install to confirm — this list depends on your Antigravity subscription/tier.

### `antigravity_execute`
Delegate a development task (writing code, implementing a feature, fixing a bug).

| Field | Required | Description |
|---|---|---|
| `task` | yes | Detailed description of what to do. |
| `model` | yes | Exact label from `agy models`. A Flash tier for quick tasks; Gemini 3.1 Pro / Claude Sonnet 4.6 (Thinking) for moderate reasoning; Claude Opus 4.6 (Thinking) for complex, correctness-critical work. |
| `success_criteria` | yes | Explicit conditions `agy` must verify before finishing, e.g. `"npx tsc --noEmit passes"`. |
| `context_files` | no | Array of absolute file paths to point `agy` at the relevant code. |
| `cwd` | no | Absolute working directory to run `agy` in (the repo/project to operate on). Defaults to the server's current directory. |

Returns `{ job_id, status: "running" }`. When done, `antigravity_result` / `antigravity_wait` returns a JSON receipt:
`{ status, summary, files_changed, verification_details, failure_reason }`.

### `antigravity_research`
Delegate a codebase research or debugging investigation.

| Field | Required | Description |
|---|---|---|
| `question` | yes | The research question or bug description. |
| `model` | yes | Exact label from `agy models`. A Flash tier is usually sufficient; a Pro/Thinking tier for deep or ambiguous investigations. |
| `cwd` | no | Absolute working directory to run `agy` in. Defaults to the server's current directory. |

Returns `{ job_id, status: "running" }`. When done, returns a concise summary with file paths / line numbers.

### `antigravity_result`
Poll a background job by `job_id` (non-blocking). Returns `{ status: "running" | "done" | "error" | "cancelled", … }`. While `running`, wait a bit and poll again — `agy` tasks take minutes. Output is streamed to `<os tmpdir>/agy-jobs/<job_id>.out`.

### `antigravity_wait`
Bounded long-poll. Blocks until the job finishes **or** `timeout_seconds` elapses (default 25, **capped at 50s** to stay under the MCP request timeout), then returns the same shape as `antigravity_result`. Prefer this over sleep+poll loops; if it returns `running`, call it again.

| Field | Required | Description |
|---|---|---|
| `job_id` | yes | The job to wait on. |
| `timeout_seconds` | no | Max seconds to block (default 25, capped at 50). |

### `antigravity_cancel`
Terminate a running job by `job_id` (SIGTERM to the `agy` process). Returns the resulting status; no-op if the job already finished.

### `antigravity_list`
List all jobs the server knows about (in-memory; cleared on restart), each with `status`, `kind`, `model`, `cwd`, `exit_code`, and `created`. Useful to recover a `job_id` or see what's in flight.

## Tips for good results

- Give `execute` a **strict, machine-checkable `success_criteria`** (a command that exits 0). The agent is told to verify it before returning.
- Use `Gemini 3.1 Pro` or `Claude Sonnet 4.6 (Thinking)` for architecture/refactors, a Flash tier for small edits and most research, and `Claude Opus 4.6 (Thinking)` for complex, correctness-critical work.
- Provide `context_files` so the agent starts in the right place, and `cwd` to point it at the right repo.
- Use `antigravity_wait` instead of your own sleep+poll loop.

## Using it from an agent (e.g. Claude Code)

The tools work best when the orchestrating agent knows *when* and *how* to delegate. Drop a block like this into your project's `AGENTS.md` (or the agent's system prompt / rules file) so the client uses the connector correctly instead of guessing:

````md
## Delegating to Antigravity (agy-connector)

You have an `agy-connector` MCP server exposing `antigravity_execute`,
`antigravity_research`, `antigravity_result`, `antigravity_wait`,
`antigravity_cancel`, and `antigravity_list`. Use it to offload heavy work to the
Antigravity (`agy`) CLI and keep your own context small.

### When to delegate
- `antigravity_execute` — large or sweeping code changes, multi-file refactors,
  implementing a feature, or fixing a bug, where you can state a concrete,
  machine-checkable success condition.
- `antigravity_research` — deep codebase questions or root-causing across many
  files, when you only need the conclusion, not the raw file contents.
- Do small, surgical edits yourself — delegation overhead isn't worth it for those.

### How to delegate (async — never block)
1. Call `antigravity_execute` / `antigravity_research` with the `cwd` of the repo
   to operate on. It returns a `job_id` immediately and does NOT block; `agy` runs
   in the background.
2. Wait for it with `antigravity_wait(job_id, timeout_seconds: 30)` — it blocks up
   to ~30s and returns as soon as the job finishes. If it comes back `running`,
   call it again. (Or poll `antigravity_result(job_id)` yourself between other
   work.) `agy` tasks usually take 1–5 minutes — don't give up early.
3. When `status` is `"done"`/`"error"`, read the result and act on it.
4. Use `antigravity_cancel(job_id)` to stop a job that's gone wrong, and
   `antigravity_list` to recover a `job_id` or see what's in flight.

### Write good requests
- `model`: exact label from `agy models`. Gemini 3.1 Pro / Claude Sonnet 4.6
  (Thinking) for complex reasoning/refactors, Claude Opus 4.6 (Thinking) for
  correctness-critical work, a Flash tier for simple edits and most research.
- `success_criteria` (execute): make it a command that exits 0
  (e.g. "`npx tsc --noEmit` passes", "`pytest -q` passes"). `agy` is instructed to
  verify it before returning a SUCCESS receipt.
- `context_files`: pass absolute paths to the relevant files so `agy` starts in
  the right place instead of searching.

### Verify — don't trust blindly
- For `execute`, confirm the receipt's `status` is `SUCCESS`, and re-run the
  `success_criteria` yourself when it matters.
- If the receipt is `FAILURE` or `NEEDS_CLARIFICATION`, delegate again with a
  tighter task description or more `context_files` — don't silently accept it.
````

> Tip: keep the delegated task **self-contained**. `agy` starts fresh with no
> memory of your conversation, so spell out file paths, the goal, and the
> acceptance check in the `task` itself.

## Limitations

- **Jobs are in-memory.** If the server process restarts, known `job_id`s are forgotten (the `.out` files remain on disk). `antigravity_list` only sees jobs from the current process lifetime.
- **Output files are not auto-cleaned.** `<os tmpdir>/agy-jobs/` grows over time; clear it periodically if needed.
- **No *automatic* per-job timeout.** A stuck `agy` run stays `running` until it exits or you `antigravity_cancel` it.
- Tested on macOS with `agy` 1.0.13 and `@modelcontextprotocol/sdk` 1.29.x. Other platforms/versions are expected to work but are not yet broadly verified.

## License

[MIT](LICENSE) © agamairi
