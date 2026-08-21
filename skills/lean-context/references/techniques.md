# Techniques Cookbook

Concrete recipes implementing the lean-context rules. Commands are Git Bash / POSIX; adapt flags to the platform.

## 1. Grep-first workflows

Locate before reading, every time:

```bash
# Where is this defined? (then slice-read around one hit)
grep -rn --include='*.ts' -E 'function createUser|const createUser|def createUser' src | head -10

# Who uses it? (file list first, never content)
grep -rl 'createUser' src --include='*.ts'

# Per-file locations, capped
grep -rn 'createUser' src --include='*.ts' | head -20

# Does this config/flag exist anywhere?
grep -rn 'FEATURE_FLAG' --include='*.json' --include='*.yaml' --include='*.env*' . | grep -v node_modules | head -10
```

Cap everything: `| head -N`, `grep -m N`. An uncapped grep over a big repo is a full-read in disguise.

## 2. Sliced reading

After a `grep -n` hit at line N, read a window, not a file:
- Read tool: `offset = max(1, N - 20)`, `limit = 60`.
- Bash equivalent: `sed -n '120,180p' file`.
- Table of contents of a large file first, then slice to the function:

```bash
grep -nE '^(export )?(async )?(function|class|def) |^const [A-Z]' src/big/file.ts | head -30
```

## 3. Extraction one-liners (answers without reads)

```bash
# Endpoints across the repo
grep -rhoE "(get|post|put|patch|delete)\(['\"][^'\"]+" src --include='*.ts' | sort -u | head -30

# Declared dependencies, not the lock file
node -e "const p=require('./package.json');console.log(Object.keys({...p.dependencies,...p.devDependencies}).join(' '))"

# Biggest source files (know what NOT to read)
find src -name '*.ts' -o -name '*.js' | xargs wc -l | sort -rn | head -15

# TODO/FIXME debt map
grep -rn 'TODO\|FIXME' src --include='*.ts' | head -20

# Repo shape, junk excluded
find . -maxdepth 2 -type d -not -path '*/node_modules*' -not -path '*/.git*' -not -path '*/dist*' | head -40
```

## 4. Subagent delegation prompts

Research (any question needing >3 files scanned):

```
Question: <exact question, e.g. "where and how is auth token expiry validated?">
Scope: <dirs/files>. Ignore: node_modules, dist, tests unless required.
Output format: one line per finding, `path:line — fact`. Max 30 lines.
No code blocks except single signatures. End with a 2-3 sentence conclusion.
Do not describe your process.
```

Dispatch independent questions as multiple Agent calls in one message. Relay the conclusion in prose; record durable facts in `.context/state.md` (Verified) so the finding survives summarization.

## 5. Edit without re-reading

- Anchor Edit `old_string` on unique text from a slice already in context.
- After Edit/Write succeeds, trust it — verify behavior with tests, build, or a targeted `grep -n`, never a re-read.

## 6. Diffs over files

```bash
git diff --stat            # what changed, how much
git diff -- <path>         # exact hunks — review these, not whole files
git log --oneline -10      # recent intent
git show <sha> --stat      # one change's footprint
```

## 7. Checkpoint file (`.context/state.md`)

```
# State — <date>
## Intent    — fix 401 on /api/auth/login (prod only)
## Touched   — src/auth/issuer.ts — clock-skew window widened — done
## Decisions — validate exp with 30s leeway (rejected: NTP sync, out of scope)
## Verified  — src/auth/issuer.ts:41 — exp checked before sig cache lookup
## Open      — why does only prod fail? timezone of signer?
## Next      — add regression test with skewed clock
```

Update at task start, before risky edits, after breakthroughs, and before any context-compaction boundary. Read it before trusting stale conversation memory.

## 8. Cost table (approx tokens)

| Action | Cost |
|--------|------|
| `grep -l` across repo | 0.1–1k |
| `grep -n` one pattern | 0.2–2k |
| 60-line slice | ~0.7k |
| Full read, 400-line file | ~5k |
| Full read, 2,000-line file | ~20k |
| 50 files read inside a subagent | ~0 to this window; summary ~1k |
| Project map load (300 lines) | ~4k |

## 9. Failure modes to avoid

- **Over-compression:** paraphrasing an error message loses the exact string needed for `grep`. Keep verbatim what you would search for.
- **Map worship:** a stale map is a wrong map; if the last update predates a big refactor, regenerate.
- **Delegation theater:** dispatching a subagent for a one-file lookup costs more (latency + summary) than a slice read. The trigger is >3 files.
- **Checkpoint drift:** state.md not updated after a decision is a decision lost — one line at the moment, not a reconstruction later.

## 10. When exactness beats compression

Security review, conflict resolution, off-by-one debugging, verbatim migration: read the exact regions (slice by function), quote exactly in notes, and only summarize the parts you are not changing.
