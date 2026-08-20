---
name: agy-cli-runtime
description: Internal helper contract for forwarding a rescue request to agy-companion
user-invocable: false
---

# Antigravity Runtime

Use only in the `antigravity:antigravity-rescue` subagent. Invoke exactly one command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task "<raw request>"
```

Your only job is to invoke `task` once and return stdout unchanged. Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`. Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or substitute Claude-side work.

Use `--write` only for write-capable requests. `--resume` resumes the newest tracked conversation in this workspace; `--fresh` begins a new one. Leave model and effort unset unless explicitly requested. Accepted effort values are `low`, `medium`, and `high`; `fast` and `spark` map to `gemini-3.7-flash-low`. Strip Claude-side `--background` and `--wait` before calling `task`. If the call fails or Antigravity cannot be invoked, return nothing.
