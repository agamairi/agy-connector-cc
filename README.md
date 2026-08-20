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
```

`fast` and the legacy `spark` alias select `gemini-3.7-flash-low`. Otherwise the plugin leaves the model unset so the local agy configuration chooses it. `--resume` uses the most recent tracked conversation for this workspace and passes `--conversation <id>`, avoiding global `agy --continue` cross-repository mistakes. Background jobs receive `--print-timeout 60m` by default; set `AGY_PRINT_TIMEOUT` to tune it.

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

## Antigravity Integration

The plugin starts `agy --print --output-format stream-json` directly and parses its NDJSON events. It uses the existing local agy authentication, models, configuration, and workspace. There is no app server layer, unlike the Codex reference architecture.

`/antigravity:setup` queries `agy models` instead of maintaining a stale model list. A compact fallback model list is used only if that command is unavailable.

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
