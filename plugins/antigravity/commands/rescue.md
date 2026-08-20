---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Antigravity rescue subagent
argument-hint: '[--background|--wait] [--resume|--fresh] [--model <model|fast>] [--effort <low|medium|high>] [what Antigravity should investigate, solve, or continue]'
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
- `--model` and `--effort` are runtime-selection flags. Preserve them for `task`, but do not treat them as task text.
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
- Leave `--effort` and `--model` unset unless the user explicitly requests them. Map `fast` or `spark` to `gemini-3.7-flash-low`.
- Leave `--resume` and `--fresh` in the forwarded request; the subagent handles that routing.
- If Antigravity is unavailable, stop and tell the user to run `/antigravity:setup`.
- If no request was supplied, ask what Antigravity should investigate or fix.
