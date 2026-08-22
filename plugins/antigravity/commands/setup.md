---
description: Check whether the local agy CLI is ready and toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup "$ARGUMENTS"`

Present the setup output exactly as returned. The plugin checks the existing `agy` installation and does not invent an installer or authentication command.
