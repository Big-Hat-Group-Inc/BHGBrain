---
name: build-proposals
description: Implement OpenSpec proposals end-to-end with a multi-agent workflow, keeping each proposal's Linear issue in sync (In Progress while working, Done when genuinely complete, a progress comment when not). Defaults to every proposal with unfinished tasks. Use when the user wants to build, implement, work through, or catch up on OpenSpec proposals.
---

Implement OpenSpec proposals with an orchestrated fan-out, and keep the Linear board
honest about what actually landed.

**This skill's instructions constitute explicit opt-in to the Workflow tool** (ultracode
multi-agent orchestration). Call `Workflow` as described below — do not implement the
proposals inline in the main loop. Each proposal gets its own agent context, which is
the point: 20+ proposals will not fit in one context window.

---

## Input

`/build-proposals [all | <change-id> ...] [--include-complete] [--no-commit]`

- **Default (no argument) is `all`** — every change in `openspec/changes/` whose
  `tasks.md` has at least one unchecked box.
- One or more change ids restricts the run to those changes.
- `--include-complete` also mirrors already-finished proposals into Linear as `Done`
  issues (board becomes a complete record). Off by default — a fully-checked proposal
  with no issue is normally just history.
- `--no-commit` leaves everything uncommitted in one pile. Off by default; see
  **Git handling**.

Announce the resolved target list and count before starting, e.g.
`Building 21 proposals (all): fix-qdrant-client-search-removal, …`

---

## Before calling Workflow

Do these in the main loop — they are cheap, and getting them wrong wastes a large run.

1. **Resolve the target list.** Read the checkbox counts directly from the filesystem —
   the `openspec` CLI is **not** on PATH in this repo, so do not depend on it:

   ```bash
   cd openspec/changes && for d in */; do d=${d%/}; \
     total=$(grep -cE '^\s*- \[[ xX]\]' "$d/tasks.md" 2>/dev/null || echo 0); \
     done_c=$(grep -cE '^\s*- \[[xX]\]' "$d/tasks.md" 2>/dev/null || echo 0); \
     echo "$d|$done_c/$total"; done
   ```

   A change with no `tasks.md` cannot be built — list it as skipped and say why.

2. **Order the list by Linear priority** (Urgent → High → Medium → Low, then by fewest
   remaining tasks). A long run can be interrupted; the valuable work should land first.

3. **Create a working branch** if on `main` (see **Git handling**).

4. **Pass the ordered list to Workflow as `args`** — as a real JSON array, not a
   stringified one.

---

## Git handling

Implementation makes real code changes across many files. Default behavior:

- Create one branch for the run: `git checkout -b openspec/build-<n>` where `<n>` makes
  it unique (workflow scripts cannot call `Date.now()` — generate the name in the main
  loop before invoking Workflow, and pass it in `args`).
- **Each proposal commits its own work** before the next one starts. Per-proposal
  commits are what make a 20-proposal run reviewable and revertible; one giant
  uncommitted diff is not. Message form:

  ```
  feat(<change-id>): <what landed>

  OpenSpec change: <change-id>
  Linear: BIG-nn
  ```
- Do not push and do not open a PR unless the user asks.
- `--no-commit` skips committing; warn that later proposals will be hard to separate.

---

## Concurrency rule (important)

**Implementation is sequential, not parallel.** Proposals overlap heavily in the files
they touch (`src/storage/`, `src/transport/`, `src/health/` recur across many changes),
and parallel agents in one working tree will clobber each other. The survey phase fans
out because it is read-only; the build loop is a plain `for … await`.

If the user explicitly asks for parallel builds, use `isolation: 'worktree'` per agent
and tell them the results land in separate worktrees needing manual merge.

---

## Linear rules

The project is **`bhgbrain`** on team **`BigHatGroup`**. Issue titles are prefixed with
the change id, so an issue is found with `list_issues` filtered to
`project: "bhgbrain"`, `query: "<change-id>"`. See `CLAUDE.md` § "OpenSpec workflow" —
this skill automates exactly that convention.

Subagents must load the Linear tools before calling them:

```
ToolSearch("select:mcp__linear__list_issues,mcp__linear__save_issue,mcp__linear__save_comment")
```

Per proposal:

| When | Action |
|---|---|
| No issue exists | Create one in the `bhgbrain` project, titled `<change-id>: <summary>`, body carrying the "Why" from `proposal.md` and the task count |
| Work starts | Set state **In Progress** — before the first edit, not after |
| Every task checked + `npm run lint` and `npm test` pass + verifier confirms | Set state **Done**, and comment the closing status (what landed, final task count, lint/test result) |
| Anything less | **Leave it In Progress** and comment: what was completed, what remains (the specific unchecked tasks), and why it stopped |

**Never mark Done to tidy the board.** Done means the tasks file is fully checked, the
suite is green, and a verifier that did not write the code agreed. A proposal that got
80% done is In Progress with an honest comment.

---

## The workflow

Call `Workflow` with a script shaped like this. Adapt it — do not treat it as sacred —
but keep the three properties that make it correct: parallel read-only survey,
**sequential** build loop, and a verifier separate from the implementer.

```js
export const meta = {
  name: 'build-proposals',
  description: 'Implement OpenSpec proposals and keep their Linear issues in sync',
  phases: [
    { title: 'Survey', detail: 'read tasks.md, find or create the Linear issue' },
    { title: 'Build', detail: 'one proposal at a time, in priority order' },
    { title: 'Verify', detail: 'independent check, then the Linear status write' },
  ],
}

const SURVEY = {
  type: 'object',
  properties: {
    changeId: { type: 'string' },
    issueKey: { type: 'string', description: 'e.g. BIG-92' },
    total: { type: 'number' },
    remaining: { type: 'number' },
    summary: { type: 'string', description: 'one line: what this change does' },
    blocked: { type: 'string', description: 'empty unless it cannot be built' },
  },
  required: ['changeId', 'issueKey', 'total', 'remaining', 'summary', 'blocked'],
}

const BUILD = {
  type: 'object',
  properties: {
    changeId: { type: 'string' },
    tasksChecked: { type: 'number' },
    tasksTotal: { type: 'number' },
    lintPassed: { type: 'boolean' },
    testsPassed: { type: 'boolean' },
    committed: { type: 'boolean' },
    landed: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['changeId', 'tasksChecked', 'tasksTotal', 'lintPassed', 'testsPassed',
             'committed', 'landed', 'remaining', 'notes'],
}

const VERDICT = {
  type: 'object',
  properties: {
    changeId: { type: 'string' },
    genuinelyComplete: { type: 'boolean' },
    overclaimed: { type: 'array', items: { type: 'string' },
                   description: 'tasks checked off but not actually implemented' },
    linearState: { type: 'string', description: 'Done | In Progress' },
    comment: { type: 'string', description: 'what was posted to the issue' },
  },
  required: ['changeId', 'genuinelyComplete', 'overclaimed', 'linearState', 'comment'],
}

const targets = args.changes          // [{changeId, remaining, total}, …] in priority order
const branch = args.branch
const commit = args.commit !== false

phase('Survey')
const surveyed = (await parallel(targets.map(t => () => agent(`
Read openspec/changes/${t.changeId}/proposal.md and tasks.md.

Then load the Linear tools:
ToolSearch("select:mcp__linear__list_issues,mcp__linear__save_issue")

Find this change's issue: list_issues with project "bhgbrain", query "${t.changeId}".
Issue titles are prefixed with the change id. If none exists, create one on team
"BigHatGroup" in project "bhgbrain", titled "${t.changeId}: <short summary>", with the
proposal's Why section and the task count in the body. Set priority from the severity
the proposal describes.

Do NOT change the issue state and do NOT edit any code. Report the issue key.
`, { label: `survey:${t.changeId}`, phase: 'Survey', schema: SURVEY })))).filter(Boolean)

const buildable = surveyed.filter(s => !s.blocked && s.remaining > 0)
log(`${buildable.length} buildable, ${surveyed.length - buildable.length} skipped`)

// SEQUENTIAL — proposals share files; parallel builds corrupt the working tree.
const results = []
for (const s of buildable) {
  phase('Build')
  const built = await agent(`
Implement OpenSpec change "${s.changeId}" on branch ${branch}.

FIRST: load Linear tools and set the issue ${s.issueKey} to state "In Progress".
ToolSearch("select:mcp__linear__save_issue")

Then read openspec/changes/${s.changeId}/{proposal,design}.md and specs/, and work
through every unchecked task in tasks.md:
- Make the code change the task actually describes.
- Follow AGENTS.md and CLAUDE.md. ESLint bans \`any\` as an error.
- Check the box \`- [ ]\` -> \`- [x]\` only after the change is really made.
- If a task is ambiguous or its premise is wrong, LEAVE IT UNCHECKED and explain in notes.

Then run \`npm run lint\` and \`npm test\`. Fix what you broke. If a failure predates
your work, say so in notes rather than papering over it.
${commit ? `Finally commit your work: \`git add -A && git commit\` with subject
"feat(${s.changeId}): <what landed>" and a body citing the change id and ${s.issueKey}.` : 'Do not commit.'}

Report honestly. A partial result reported accurately is worth more than a false
"complete" — a verifier reads the diff next.
`, { label: `build:${s.changeId}`, phase: 'Build', schema: BUILD })

  phase('Verify')
  const verdict = await agent(`
You did NOT write this code. Verify the implementation of "${s.changeId}" and then
write the outcome to Linear issue ${s.issueKey}.

The builder claims ${built?.tasksChecked ?? 0}/${built?.tasksTotal ?? s.total} tasks
checked, lint ${built?.lintPassed ? 'pass' : 'FAIL'}, tests ${built?.testsPassed ? 'pass' : 'FAIL'}.

1. Read openspec/changes/${s.changeId}/tasks.md and \`git show --stat HEAD\` /
   \`git diff HEAD~1\` for the commit. For each task marked [x], confirm the diff
   actually contains that change. List any that are checked but not implemented.
2. Run \`npm run lint\` and \`npm test\` yourself. Do not trust the report.
3. Load Linear tools:
   ToolSearch("select:mcp__linear__save_issue,mcp__linear__save_comment")
4. Write the outcome to ${s.issueKey}:
   - ALL tasks genuinely checked AND lint green AND tests green -> set state "Done"
     and comment the closing status (what landed, N/N tasks, lint+test result).
   - Otherwise -> LEAVE state "In Progress" and comment: what was completed, the
     specific tasks that remain unchecked, any tasks that were overclaimed, and why
     it stopped. Do not mark Done to tidy the board.

Report what you actually wrote to the issue.
`, { label: `verify:${s.changeId}`, phase: 'Verify', schema: VERDICT })

  results.push({ survey: s, built, verdict })
  log(`${s.changeId}: ${verdict?.linearState ?? 'unknown'} (${built?.tasksChecked ?? '?'}/${built?.tasksTotal ?? '?'})`)
}

return {
  branch,
  completed: results.filter(r => r.verdict?.genuinelyComplete).map(r => r.survey.changeId),
  partial: results.filter(r => r.verdict && !r.verdict.genuinelyComplete).map(r => r.survey.changeId),
  skipped: surveyed.filter(s => s.blocked || s.remaining === 0)
                   .map(s => ({ changeId: s.changeId, why: s.blocked || 'already complete' })),
}
```

---

## Reporting back

When the workflow returns, give the user a table: change id → Linear issue → final
state → tasks landed / total. Then state plainly:

- Which proposals are **Done** and archived-ready (offer `/opsx:archive`).
- Which are **In Progress** and what remains in each.
- Anything **skipped**, with the reason.
- The branch name and commit count, so they can review the diff.

If any verifier found overclaimed tasks (checked but not implemented), surface that
prominently — it means a tasks file is lying and the next run will skip real work.

## Guardrails

- Read `CLAUDE.md` and `AGENTS.md` before building. `npm run lint` is type-check **and**
  ESLint, and `@typescript-eslint/no-explicit-any` is an error.
- A user-facing change must update all five READMEs (`README.md` + de/es/fr/zh-CN) and
  bump `package.json` version — several proposals are docs-only and consist of exactly
  this.
- Do not archive a change (`/opsx:archive`) inside the workflow. Archiving moves
  directories and would race the survey data; do it afterward, per proposal, once the
  user has looked at the diff.
- Never leave an issue In Progress with no comment explaining where it stopped.
