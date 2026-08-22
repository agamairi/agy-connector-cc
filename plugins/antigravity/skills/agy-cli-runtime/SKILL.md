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

Use `--write` only for write-capable requests. `--resume` resumes the newest tracked conversation in this workspace; `--fresh` begins a new one. Antigravity has Gemini and Claude/GPT model families which, in observed agy 1.1.18 behavior, use separate quota pools that can exhaust independently. The companion deliberately defaults to Gemini: `gemini-3.1-pro-low` for writes and `gemini-3.7-flash-low` for read-only work. Leave model and effort unset unless the user requests them or the task clearly warrants escalation. Routine and high-volume work should stay on Gemini; pass a Claude/GPT model only for hard reasoning or genuinely correctness-critical work, not as a silent routine escalation into the observed scarcer pool. The user's explicit model instruction always wins. Accepted effort values are `low`, `medium`, and `high`; `fast` and `spark` map to `gemini-3.7-flash-low`. A quota wall in one family does not establish that the other is unavailable. Forward `--success-criteria <text>` unchanged when supplied. The companion forces write-capable runs to verify their success criteria and report a `## Verification` section while keeping read-only research lean. Strip Claude-side `--background` and `--wait` before calling `task`. If the call fails or Antigravity cannot be invoked, return nothing.
