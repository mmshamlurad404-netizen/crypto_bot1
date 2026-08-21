# Project Map Guide

The project map (`.context/map.md`) is a ≤300-line compressed model of the repo. It costs ~4k tokens to load and replaces tens of thousands of tokens of repeated exploration. Build it once; maintain it incrementally.

## When to build

- Starting the first substantive task in a project that has no map.
- Catching yourself exploring the same area a second time in one session.
- After a refactor large enough that section headings no longer match reality (then rebuild, don't patch).

Skip building for small tasks in small repos (< ~30 files) — the map would cost more than it saves.

## How to build (delegated — the whole point)

Bulk reading must happen in a subagent so only the finished map enters this context window. Create `.context/` first, then dispatch one Explore agent (search breadth: very thorough) with this prompt, adjusted to the stack:

```
Build a compressed project map for <ABSOLUTE ROOT>. Explore the codebase thoroughly,
but NEVER include file contents in your answer — only conclusions.

Exclude entirely: node_modules, .git, dist, build, out, .next, vendor, coverage,
__pycache__, lock files, *.min.*, *.map, generated clients, binaries, fixtures >1k lines.

Return EXACTLY this structure inside ONE fenced markdown block:

# Project Map — <name>
Updated: YYYY-MM-DD

## Shape
Directory tree, depth 2-3, junk excluded, one short annotation per directory.

## Commands
build: ... | test: ... | run: ... | lint: ...   (read package.json / Makefile / CI config)

## Inventory
path — one-line purpose
(only files whose purpose is not obvious from the path; cap at the ~60 most important)

## Key symbols
path:line symbol — what it does
(entry points, central dispatch tables, domain invariants; cap ~25)

## Data flow
≤10 lines: request/entry → ... → storage, naming real files.

## Conventions & gotchas
- quirks, naming rules, known traps, test requirements

HARD LIMITS: ≤300 lines total. One line per file in Inventory. No code, no samples,
no explanations of your process — the block only.
```

Save the block verbatim to `.context/map.md` (Write tool). Sanity-check with `wc -l` — if over 300 lines, tell the subagent to cut to the essentials and re-run rather than trimming by hand.

## Update discipline (incremental, cheap)

| Event | Action | Cost |
|-------|--------|------|
| File added/removed/renamed | add/fix/delete its Inventory line | seconds |
| File's purpose changed | rewrite that one line | seconds |
| New symbol became load-bearing | add one Key-symbols line | seconds |
| Refactor moved directories | regenerate via subagent | one delegation |
| Map is 2+ sessions stale and untrusted | regenerate via subagent | one delegation |

Never re-read the repo to update the map — the edit being made already tells you what changed.

## Splitting

At >300 lines, split by subsystem: `.context/maps/<area>.md` (frontend, api, db, infra...), each ≤200 lines with the same section structure minus Commands (keep those in the index). The index `.context/map.md` shrinks to: Shape, Commands, area → file pointers, Conventions. Load only the area map a task touches.

## Notes

- Committing `.context/` shares the map with teammates and future sessions; add to `.gitignore` if the owner prefers.
- Monorepos: one map per package is usually better than one giant map.
- The map is a navigation aid, not documentation for humans — terse `path:line — fact` lines are correct.
