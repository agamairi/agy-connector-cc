# Antigravity for Claude Code

Use the local Antigravity `agy` CLI from Claude Code for code review, adversarial review, delegated rescue tasks, and context replay.

## What You Get

- `/antigravity:review` for read-only reviews of the working tree or a branch.
- `/antigravity:adversarial-review` for steerable design and risk reviews.
- `/antigravity:rescue` for a dedicated task handoff, optionally write-capable.
- `/antigravity:status`, `/antigravity:result`, and `/antigravity:cancel` for tracked jobs.
- `/antigravity:transfer` to create a new agy conversation seeded with the current Claude transcript.

## Requirements

Node.js 18.18+ and the local `agy` executable must be available on `PATH`. Run `/antigravity:setup` to check the executable, version, and whether `agy models` can reach the authenticated service. This plugin does not install a package or provide an invented login command; `agy install` is the Antigravity CLI flow for configuring its path.

## Install

```text
/plugin marketplace add agamairi/agy-connector-cc
/plugin install antigravity@agamairi-antigravity
/reload-plugins
/antigravity:setup
```

## Usage

### `/antigravity:review`

```text
/antigravity:review --wait
/antigravity:review --base main --background
```

Reviews are read-only. They run agy with `--mode plan`, `--sandbox`, an explicit read-only instruction, and an inline git diff. The CLI receives `--dangerously-skip-permissions` because agy denies every tool call in non-interactive print mode without it — so the write barrier comes from `--mode plan --sandbox`, not from the permission prompt.

This was verified against agy 1.1.15: a read-only run told outright to create a file produced an implementation plan and asked for approval instead, and no file was written. Because that barrier is the only thing separating a review from a write, re-check it after upgrading agy.

### `/antigravity:adversarial-review`

```text
/antigravity:adversarial-review --base main challenge the retry and rollback design
```

This follows the same review targeting but asks agy to challenge assumptions and failure modes.

### `/antigravity:rescue`

```text
/antigravity:rescue --write fix the failing integration test
/antigravity:rescue --resume apply the top fix from the last task
/antigravity:rescue --model fast --effort medium investigate the regression
/antigravity:rescue --model gemini-3.1-pro-high implement the parser fix
/antigravity:rescue --model claude-sonnet-4-6 verify the concurrency design
/antigravity:rescue --success-criteria "npm test passes" implement the fix
```

Write-capable rescue tasks default explicitly to `gemini-3.1-pro-low`; read-only rescue research and reviews default to `gemini-3.7-flash-low`. These are conservative low-tier choices from `agy models`: Pro Low supplies reasoning for edits, while Flash Low keeps read-only work economical. Set `AGY_DEFAULT_MODEL` to override the class defaults globally, or pass `--model` for one run; an explicit flag always wins. `fast` and the legacy `spark` alias select `gemini-3.7-flash-low`.

#### Model families and quotas

Observed on one account at one moment with agy 1.1.18, Antigravity exposed two model families backed by quota pools that exhausted independently:

- **Gemini pool:** `gemini-3.7-flash-{low,medium,high}`, `gemini-3.6-flash-{low,medium,high}`, `gemini-3.5-flash-{low,medium,high}`, and `gemini-3.1-pro-{low,high}`.
- **Claude/GPT pool:** `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, and `gpt-oss-120b-medium`.

This is observed agy 1.1.18 behavior, not a statement of Google policy or a claim about quota sizes, reset rules, pricing, or subscription entitlements. In the observation, Gemini continued to work after Claude and GPT returned `Individual quota reached`; a run with no explicit model also hit the Claude/GPT quota because this machine's agy setting was `Claude Sonnet 4.6 (Thinking)`.

The plugin therefore deliberately defaults to the Gemini family instead of inheriting agy's configured default: `gemini-3.1-pro-low` for write-capable tasks and `gemini-3.7-flash-low` for read-only research and review. Use Gemini for routine or high-volume work. Choose Claude/GPT deliberately for hard reasoning or genuinely correctness-critical work when the expected benefit justifies conserving that observed scarcer pool. A user's explicit model instruction always wins.

Choose a family for one run with `--model <slug|label>`; `--model fast` selects `gemini-3.7-flash-low`. Set `AGY_DEFAULT_MODEL=<slug|label>` to replace both class defaults, while an explicit `--model` still wins. Hitting a quota wall in one family does not establish that the other family is unavailable, so retry with a model from the other pool.

Every write-capable task is instructed to perform the work, verify the success criteria with relevant tests, builds, type-checks, or other checks, and end with a prose `## Verification` section. Use `--success-criteria <text>` to supply exact criteria; otherwise Antigravity must state and verify the criteria it chose. Read-only research uses a lighter evidence-gathering prompt and is not told to run a generic test suite. Result and single-job status output show the reported verification and the model that actually ran.

`--resume` uses the most recent tracked conversation for this workspace and passes `--conversation <id>`, avoiding global `agy --continue` cross-repository mistakes.

### `/antigravity:transfer`

```text
/antigravity:transfer
/antigravity:transfer --source ~/.claude/projects/.../session.jsonl
```

This is a **context replay**, not a native session import: agy has no importer. The command seeds a new conversation with rendered Claude history and prints `agy --conversation <id>`.

### Job commands

```text
/antigravity:status
/antigravity:status task-abc123 --wait --timeout-ms 240000
/antigravity:result task-abc123
/antigravity:cancel task-abc123
```

Jobs are stored per workspace beneath `$CLAUDE_PLUGIN_DATA/state/antigravity`, with a temporary-directory fallback. Results and status surface the agy conversation ID and continuation command.

Every status, result, and cancel read reconciles active records before returning. A missing worker PID is marked `interrupted`; a PID whose process birth identity no longer matches is treated as reused and is never signalled. On platforms where process birth identity cannot be read, a record must exceed both the one-hour safety window and the inactivity limit before its PID is treated as untrustworthy; jobs that keep emitting events remain active. Records without a PID are reaped after five minutes. Reconciliation updates both the job summary and its per-job JSON, so records left behind by crashes, reboots, or older plugin versions repair themselves on the next read.

Active status includes `No output for`. Each agy event refreshes `lastEventAt`; after 15 minutes without output, the process is terminated and the job is marked `stalled`. This applies to foreground and background runs. The independent agy print timeout now defaults to 20 minutes. Configure them separately:

```text
AGY_INACTIVITY_TIMEOUT=15m
AGY_PRINT_TIMEOUT=20m
```

Durations accept `ms`, `s`, `m`, or `h`. A long-running job may exceed 20 minutes only when `AGY_PRINT_TIMEOUT` is raised, and it remains healthy as long as it emits events before the inactivity limit.

## Antigravity Integration

The companion runtime starts `agy --print --output-format stream-json` directly and parses its NDJSON events. Slash commands use the existing local agy authentication, models, configuration, workspace, renderers, review engine, and persistent job records. There is no app server layer, unlike the Codex reference architecture.

`/antigravity:setup` queries `agy models`, groups the result into Gemini, Claude/GPT, and unknown families, and best-effort reports agy's configured default from `~/.gemini/antigravity-cli/settings.json`. It never probes quota availability with live model calls. A fallback model list is used only if `agy models` is unavailable. Normal default-model selection is local and does not add an `agy models` network call to each invocation; only setup and an explicit named `--model` query the live list.

## Typical Flows

```text
/antigravity:review --background
/antigravity:status
/antigravity:result
```

```text
/antigravity:rescue --background --write investigate and fix the CI regression
/antigravity:status
```

## Review Gate

The Stop review gate is opt-in:

```text
/antigravity:setup --enable-review-gate
/antigravity:setup --disable-review-gate
```

> Warning: the review gate can create long-running Claude/agy loops and drain usage limits quickly. Enable it only while actively monitoring the session.

## FAQ

### Does this use a separate runtime or account?

No. It wraps the `agy` installed on this machine and uses its existing configuration and authentication.

### Why does a read-only review auto-approve permissions?

agy denies non-interactive tool calls by default. The plugin needs permission auto-approval for review tool calls, so it layers plan mode, sandboxing, a read-only instruction, and inline diff context. Confirm the behavior of your local agy version for high-assurance use.

### Can I reopen a run in agy?

Yes. `/antigravity:status` and `/antigravity:result` print `agy --conversation <id>` when agy returned a conversation ID.
