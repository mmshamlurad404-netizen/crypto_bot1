---
name: lean-context
description: "Context-window discipline for large codebases. Use when a project has 50+ files, when exploring unfamiliar code, before reading any file over 200 lines, when a task touches many files, or when a session feels context-heavy. Enforces an access ladder (grep counts before sliced reads before full reads), subagent delegation for bulk reading, an on-disk project map, and checkpoint files so raw file contents and stale history never occupy the window."
version: 1.0.0
---

# Lean Context

Complete tasks in large projects while spending the minimum context that preserves correctness. Compress noise ruthlessly; keep load-bearing facts verbatim. The success metric is tokens-per-task, not tokens-per-request — context saved now that forces re-exploration later is a net loss.

## Non-negotiable rules

1. **Context is the scarcest resource.** Every tool result stays in the window for the rest of the session. Treat each read as a purchase.
2. **Cheapest rung first.** Never skip rungs on the access ladder below.
3. **State lives on disk, not in the transcript.** Findings go in `.context/` files. Re-reading a 40-line file beats carrying 4,000 lines of stale history.
4. **One line per fact.** Relay findings as `path:line — fact`. Never paste code that already exists on disk; reference it.
5. **Bulk reading happens in subagents.** If more than ~3 files must be scanned to answer a question, delegate the scan and accept only the conclusion.

## The access ladder

Before touching any file, take the cheapest rung that answers the current question:

| Rung | Action | Typical cost |
|------|--------|--------------|
| 0 | Check the project map (`.context/map.md`) if it exists | ~free |
| 1 | List names: Glob, `ls` | tiny |
| 2 | Count/locate: `grep -c`, `grep -l`, `grep -n`, `wc -l` | tiny |
| 3 | Slice: Read with `offset`+`limit` (≤80 lines around the hit) | small |
| 4 | Full Read — only when the file is < ~400 lines AND most of it matters | medium |
| 5 | Subagent fan-out (Explore agent) over many files; keep only its summary | summary only |
| 6 | Full read of a large file | expensive — last resort |

Rule of thumb: 1 line of code ≈ 10 tokens. A 2,000-line read ≈ 20k tokens, permanently spent.

## The project map (`.context/map.md`)

A single compressed file that replaces re-exploration across sessions:

- Build it once per project by delegating to an Explore subagent, so bulk file reading happens outside this context window. Build prompt and template: [Project Map Guide](references/project-map.md).
- Reload it with one Read at session start instead of re-scanning the repo.
- Update incrementally: fix the one `path — purpose` line affected by a change; never regenerate wholesale.
- Cap at ~300 lines. Beyond that, split into `.context/maps/<area>.md` plus an index. Add `.context/` to `.gitignore` if the repo owner prefers it untracked.

## Junk filter — never read, never list

`node_modules`, `.git`, `dist`/`build`/`out`, `.next`, `vendor`, `coverage`, `__pycache__`, lock files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`), `*.min.*`, `*.map`, generated API clients, binaries, images, fonts, data fixtures over ~1k lines. Exclude these in every listing command, not after the fact.

## Delegation

- **Trigger:** any question answerable only by scanning more than ~3 files ("how does auth work", "where are payments validated", "build the map").
- **Contract:** give the subagent the exact question, the scope, and a hard output format — `path:line — fact` lines, a line cap, no pasted code. Prompt templates: [Techniques Cookbook](references/techniques.md).
- **Parallelize** independent research questions as multiple Agent calls in one message.
- **Relay conclusions** to the user in prose; do not re-paste subagent output.

## Checkpointing (`.context/state.md`)

At every milestone (task start, before risky changes, after a debugging breakthrough, before context could be summarized away), write or update:

```
## Intent    — what the user wants, one sentence
## Touched   — path — what changed — status (done/wip/blocked)
## Decisions — choice + why + rejected alternative (one line each)
## Verified  — facts proven true, with path:line
## Open      — unanswered questions, hypotheses
## Next      — the single next action
```

Trust this file over conversation memory after any gap; re-verify nothing already listed under Verified.

## Compress vs keep verbatim

**Keep verbatim, never paraphrase:** error messages and stack traces, exact paths/identifiers/signatures, config values, diff hunks being edited, direct user quotes.
**Compress or drop:** file bodies once understood, directory listings, repeated tool output, process narration, anything already on disk (reference it instead).

## Anti-patterns

- Reading a whole file to find one symbol.
- Full Read of a 1,000+ line file "to be thorough" — delegate or slice.
- Re-reading a file after Edit/Write succeeded; verify with tests or grep instead.
- Exploring solo when a subagent could return the answer.
- Re-deriving facts already recorded in the map or state file.
- Carrying dead ends: once a hypothesis is disproved, record one line in Decisions and move on.

## When not to compress

Exactness tasks — security review, merge-conflict resolution, off-by-one debugging, verbatim migration — need exact content. Slice by function instead of summarizing, but never summarize the region being changed.

## References

- [Project Map Guide](references/project-map.md) — subagent build prompt, template, update and split rules.
- [Techniques Cookbook](references/techniques.md) — grep one-liners, slice recipes, delegation prompts, checkpoint format, cost tables.
