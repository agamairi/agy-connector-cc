---
description: Show the stored final output for a finished Antigravity job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result "$ARGUMENTS"`

Present the full command output without summarizing or condensing it. Preserve the job status, complete result, file paths and line numbers, errors or parse errors, Antigravity conversation ID, and continuation command.
