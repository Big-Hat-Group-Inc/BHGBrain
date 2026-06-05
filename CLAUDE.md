# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

The full development guide lives in **[AGENTS.md](./AGENTS.md)** — read it first. It
covers commands, codebase structure, design patterns, configuration (including the two
embedding providers and how config/env resolve), testing, and common gotchas.

@AGENTS.md

---

## MCP tools (canonical list)

Tool schemas live in `src/tools/schemas.ts` (plus `bootstrap.ts` / `import.ts`). The
registered tools are: `remember`, `recall`, `forget`, `search`, `tag`, `collections`,
`category`, `backup`, `bootstrap`, `import`, `repair`. Keep `src/tools/schemas.ts`,
`README.md` (§ "MCP Tools Reference"), and any new handler in sync when changing tools.

## Docs to keep in sync when behavior changes

- `README.md` — user-facing reference (tools, env vars, config).
- `.env.example` — environment variables.
- `AGENTS.md` — developer guide.
- `package.json` `version` — bump on user-visible changes.
- `openspec/changes/` — check for an existing proposal before implementing a feature.
