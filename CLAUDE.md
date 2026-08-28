# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

The full development guide lives in **[AGENTS.md](./AGENTS.md)** — read it first. It
covers commands, codebase structure, design patterns, configuration (including the two
embedding providers and how config/env resolve), testing, and common gotchas.

@AGENTS.md

---

## MCP surface (canonical lists)

**Tools** — schemas live in `src/tools/schemas.ts` (plus `bootstrap.ts` / `import.ts`),
handlers in `src/tools/index.ts`. Registered: `remember`, `recall`, `forget`, `search`,
`tag`, `collections`, `category`, `backup`, `bootstrap`, `import`, `repair`, `revisions`,
`review`.

**Resources** — `src/resources/index.ts`. Static: `memory://list`, `memory://inject`,
`category://list`, `collection://list`, `health://status`. Templates: `memory://{id}`,
`memory://{id}/revisions`, `memory://inject/{hint}`, `category://{name}`, `collection://{name}`.

Changing either surface means updating the schema/handler *and* `README.md`
(§ "MCP Tools Reference") in the same change.

## Verification

`npm run lint` runs **both** `tsc --noEmit` and `eslint src`. ESLint enforces
`@typescript-eslint/no-explicit-any` as an **error** — casting through `any` will fail
the build, so model the types properly (see the `eliminate-any-type-casting` change).
Run `npm run lint && npm test` before declaring work done.

## Docs to keep in sync when behavior changes

- `README.md` — user-facing reference (tools, env vars, config).
- `README.de.md`, `README.es.md`, `README.fr.md`, `README.zh-CN.md` — translated
  READMEs. They mirror `README.md` section-for-section; a user-facing change that
  edits `README.md` must land in all five, or none.
- `.env.example` — environment variables.
- `AGENTS.md` — developer guide.
- `package.json` `version` — bump on user-visible changes.

## OpenSpec workflow

Change proposals live in `openspec/changes/<change-id>/` (proposal, design, tasks,
specs). **Before implementing a feature, check whether a proposal already exists** —
there are ~40 of them, and several describe work that is only partly landed.

Use the `/opsx:` skills: `/opsx:explore` to think through an idea, `/opsx:propose` to
create a change, `/opsx:apply` to implement its tasks, `/opsx:archive` when it is done.

### Every proposal is mirrored by a Linear issue — keep it current

Open proposals are tracked in the **`bhgbrain`** project on the **`BigHatGroup`** Linear
team: <https://linear.app/bighatgroup/project/bhgbrain-defca0dd2a60>

Issue titles are prefixed with the change id (`<change-id>: <summary>`), so find an
issue with `list_issues` filtered to `project: "bhgbrain"` and `query: "<change-id>"`.

Working a proposal means driving its issue alongside the code — **do not leave the
issue untouched while the tasks file moves.**

1. **Starting** — before the first edit, set the issue to **In Progress**
   (`save_issue` with `state: "In Progress"`). If no issue exists for the change (a
   proposal you just created), create one in the `bhgbrain` project first.
2. **While building** — post a comment on the issue as tasks land, at minimum when a
   meaningful chunk completes or the approach changes. Include the current task count
   (`n / total complete`) so progress is legible without opening the repo. Use
   `save_comment`; do not silently batch every update to the end.
3. **Blocked or descoped** — say so in a comment rather than leaving the issue sitting
   In Progress. If the work moves to a PR and is awaiting review, **In Review** is the
   accurate state.
4. **Complete** — only when *every* task in `tasks.md` is checked off: run
   `/opsx:archive`, then set the issue to **Done**. A partly-implemented proposal stays
   In Progress; do not mark it Done to tidy the board.

Team workflow states are: `Backlog`, `Todo`, `In Progress`, `In Review`, `Done`,
`Canceled`, `Duplicate`.

### Building proposals in bulk

`/build-proposals` (`.claude/skills/build-proposals/`) automates the loop above with a
multi-agent workflow: it surveys every change, ensures each has a Linear issue, then
builds them one at a time — flipping the issue to In Progress, implementing the
unchecked tasks, running lint/tests, and handing off to an independent verifier that
writes the honest outcome back to Linear. Defaults to **all** proposals with unfinished
tasks; takes change ids to narrow the run.

Builds are **sequential by design** — proposals overlap heavily in `src/storage/`,
`src/transport/`, and `src/health/`, so parallel agents in one working tree corrupt each
other's edits.

Note the `openspec` CLI is **not** on PATH here, so read task state from
`openspec/changes/<change-id>/tasks.md` directly rather than via `openspec status`.

## Repo layout notes

- `scripts/azure/` — PowerShell provisioning for Azure AI Foundry embeddings;
  `scripts/qdrant/` — points an install at an external Qdrant cluster. Both are
  user-facing and linked from `README.md`.
- `Dockerfile` / `docker-compose.yml` / `docker-entrypoint.sh` — container deployment.
  Container defaults bind differently from the loopback-only local default; check
  `secure-container-default-binding` before touching them.
- `codeaudit/`, `Research/`, `temp_stage/`, `checklist.md` — historical/working notes,
  not authoritative. Prefer the code and `openspec/changes/` over anything in them.
