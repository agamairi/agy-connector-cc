---
name: agy-prompting
description: Internal prompting guidance for focused Antigravity rescue handoffs
user-invocable: false
---

# Antigravity Prompting

Use compact, explicit prompts. State the task, expected outcome, constraints, and verification needed. Antigravity has Gemini and Claude/GPT model families backed by separate quota pools in observed agy 1.1.18 behavior. The companion deliberately defaults to Gemini (`gemini-3.1-pro-low` for writes, `gemini-3.7-flash-low` for read-only work). Keep routine and high-volume work on that default. Add `--model` only when the user names a model or hard reasoning or correctness-critical work clearly justifies escalating to Claude/GPT; never silently escalate routine work into the observed scarcer pool. The user's explicit instruction wins over every heuristic. If one family reports quota exhaustion, the other may still work. Pass an explicit `--success-criteria <text>` when the user supplies one. The companion requires write-capable tasks to perform the work, verify it with appropriate tests or checks, and finish with a `## Verification` section. It deliberately gives read-only research a lean evidence-gathering prompt without a generic test requirement. Separate observed facts from hypotheses and keep write-capable requests scoped to the task.
