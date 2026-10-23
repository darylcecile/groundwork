---
name: tuna
description: Queue a behavior note with Tuna only when the user explicitly invokes or requests it, or another skill explicitly directs it. Never activate automatically.
argument-hint: "[note to remember]"
disable-model-invocation: true
user-invocable: true
compatibility: Requires Tuna v0.2.0 or newer, a running Tuna service, and the Tuna MCP remember tool.
metadata:
  opencode/autoinvoke: false
---

# Tuna

Use only when the user explicitly invokes or requests Tuna remembering, or another skill explicitly directs it.
Never auto-activate from observed corrections, inferred preferences, or task completion.

## Requirements

Requires Tuna **v0.2.0 or newer**, a running Tuna service, and the Tuna MCP `remember` tool available in this session.
If a requirement is missing or unavailable, tell the user the relevant next step: install or update Tuna, start the service with `tuna start`, or reconnect the harness's Tuna MCP integration.
Do not install, update, start, or reconnect anything automatically.

## Remember a note

1. Preserve the requested behavior, scope, exceptions, and conditions, using the user's wording where practical. Do not invent preferences or attribution.
2. Call Tuna's MCP `remember` tool with:
   - `note` (required): nonblank text, at most **128 KiB**. Preserve its meaning when keeping within the limit; ask for clarification if needed.
   - `harness`, `model`, `session` (optional): include only known source metadata; omit unknown values rather than guessing.

   A clear, authorized request needs no extra confirmation step.
3. Only after a successful response containing `{"queued":true}`, tell the user: “Queued the note in Tuna for later analysis and consolidation.”
4. On an error or a response without `queued: true`, report that queuing was not confirmed and explain any known cause. Do not claim success.

Background analysis and consolidation may reject a queued note. Do not claim it is already a retained preference or published instruction, or promise it will become one.
Leave processing to Tuna's existing background workflow; do not automatically run consolidation.
