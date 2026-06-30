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

Restart / reconnect the client so it picks up the new server. You should then see the three `antigravity_*` tools.

## Tools

### `antigravity_execute`
Delegate a development task (writing code, implementing a feature, fixing a bug).

| Field | Required | Description |
|---|---|---|
| `task` | yes | Detailed description of what to do. |
| `model` | yes | `gemini-3.5-pro` (complex reasoning/refactors), `gemini-3.5-flash` (quick tasks), or `gemini-3.0-pro`. |
| `success_criteria` | yes | Explicit conditions `agy` must verify before finishing, e.g. `"npx tsc --noEmit passes"`. |
| `context_files` | no | Array of absolute file paths to point `agy` at the relevant code. |

Returns `{ job_id, status: "running" }`. When done, `antigravity_result` returns a JSON receipt:
`{ status, summary, files_changed, verification_details, failure_reason }`.

### `antigravity_research`
Delegate a codebase research or debugging investigation.

| Field | Required | Description |
|---|---|---|
| `question` | yes | The research question or bug description. |
| `model` | yes | `gemini-3.5-flash` (usually sufficient) or `gemini-3.5-pro`. |

Returns `{ job_id, status: "running" }`. When done, `antigravity_result` returns a concise summary with file paths / line numbers.

### `antigravity_result`
Poll a background job by `job_id`. Returns `{ status: "running" | "done" | "error", … }`. While `running`, wait a bit and poll again — `agy` tasks take minutes. Output is streamed to `<os tmpdir>/agy-jobs/<job_id>.out`.

## Tips for good results

- Give `execute` a **strict, machine-checkable `success_criteria`** (a command that exits 0). The agent is told to verify it before returning.
- Use `pro` for architecture/refactors, `flash` for small edits and most research.
- Provide `context_files` so the agent starts in the right place instead of searching.

## Limitations

- **Jobs are in-memory.** If the server process restarts, in-flight `job_id`s are forgotten (the `.out` files remain on disk).
- **Output files are not auto-cleaned.** `<os tmpdir>/agy-jobs/` grows over time; clear it periodically if needed.
- **No built-in per-job timeout.** A stuck `agy` run stays `running` until it exits.
- Tested on macOS with `agy` 1.0.13 and `@modelcontextprotocol/sdk` 1.29.x. Other platforms/versions are expected to work but are not yet broadly verified.

## License

[MIT](LICENSE) © agamairi
