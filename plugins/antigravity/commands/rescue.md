---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Antigravity rescue subagent
argument-hint: '[--background|--wait] [--resume|--fresh] [--model <model|fast>] [--effort <low|medium|high>] [--success-criteria <text>] [what Antigravity should investigate, solve, or continue]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `antigravity:antigravity-rescue` subagent via the `Agent` tool (`subagent_type: "antigravity:antigravity-rescue"`), forwarding the raw user request as the prompt. `antigravity:antigravity-rescue` is a subagent, not a skill—do not call `Skill(antigravity:antigravity-rescue)` or `Skill(antigravity:rescue)`. The final user-visible response must be Antigravity's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the subagent in the background.
- If the request includes `--wait`, run the subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as task text.
- `--model`, `--effort`, and `--success-criteria` are runtime flags. Preserve them for `task`, but do not treat them or the success-criteria value as task text.
- If the request includes `--resume` or `--fresh`, do not ask whether to continue; the user already chose.
- Otherwise, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task-resume-candidate --json`.
- If that helper reports `available: true`, use `AskUserQuestion` exactly once with:
  - `Continue current Antigravity conversation`
  - `Start a new Antigravity conversation`
- For a clear follow-up such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Antigravity conversation (Recommended)` first. Otherwise put `Start a new Antigravity conversation (Recommended)` first.
- If the user chooses continue, add `--resume`; if they choose a new conversation, add `--fresh`.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Antigravity companion stdout verbatim. Do not paraphrase, summarize, rewrite, or add commentary.
- Do not ask the subagent to inspect files, monitor jobs, poll status, fetch results, cancel, summarize output, or do follow-up work of its own.
- Antigravity has Gemini and Claude/GPT model families. Observed with agy 1.1.18, they use separate quota pools that can exhaust independently. The companion defaults to Gemini: `gemini-3.1-pro-low` for write-capable tasks and `gemini-3.7-flash-low` for read-only work.
- Leave `--effort` and `--model` unset unless the user requests them or the task clearly warrants escalation. Routine and high-volume work should stay on the Gemini default; pass a Claude/GPT model only for hard reasoning or genuinely correctness-critical work. Do not silently spend the observed scarcer Claude/GPT pool on routine work. The user's explicit model instruction always wins over this heuristic.
- Both families can be selected explicitly, for example `--model gemini-3.1-pro-high` or `--model claude-sonnet-4-6`. Map `fast` or `spark` to `gemini-3.7-flash-low`. A quota error from one family does not establish that the other is unavailable.
- Forward `--success-criteria <text>` unchanged when supplied. Write-capable tasks are always instructed to verify their work and end with a `## Verification` section; read-only research stays lean and does not gain a generic test requirement.
- Leave `--resume` and `--fresh` in the forwarded request; the subagent handles that routing.
- If Antigravity is unavailable, stop and tell the user to run `/antigravity:setup`.
- If no request was supplied, ask what Antigravity should investigate or fix.
