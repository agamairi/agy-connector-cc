---
description: Replay the current Claude Code session as context in a new Antigravity conversation
argument-hint: '[--source <claude-jsonl>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" transfer "$ARGUMENTS"`

Present the output exactly as returned. Preserve the Antigravity conversation ID and `agy --conversation <id>` command. This is a context replay, not a native session import.
