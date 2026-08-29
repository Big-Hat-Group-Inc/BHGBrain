# AGENTS.md - BHGBrain Development Guide

## Project Overview

BHGBrain is a persistent, vector-backed memory system for MCP (Model Context Protocol) clients. It provides long-term memory across sessions, repositories, and MCP clients like Claude CLI, Codex, and Gemini.

**Key Technologies:**
- TypeScript with Node.js (>=22.0.0)
- ES modules (`"type": "module"`)
- SQLite for metadata storage (via `node:sqlite`'s `DatabaseSync`, Node's built-in
  native binding — requires Node >=22; WAL journaling, commit-level durability, bundled
  FTS5)
- Qdrant for vector storage (client `@qdrant/js-client-rest` `~1.19.0`; requires Qdrant
  server ≥ 1.10 for the `query` API the adapter uses in `src/storage/qdrant.ts` - keep the
  client range and server floor in `README.md` § Prerequisites in sync with each other)
- OpenAI or Azure Foundry for embeddings (selectable via `embedding.provider`)
- Express.js for HTTP transport
- MCP SDK for stdio transport
- Vitest for testing

## Essential Commands

```bash
# Development
npm run dev              # Run with tsx (development)
npm run build            # Compile TypeScript to dist/
npm run start            # Run compiled code

# Testing
npm test                 # Run all tests once
npm run test:watch       # Run tests in watch mode

# Evaluation
npm run eval              # Golden-set retrieval eval (recall@k/MRR report against src/eval/fixtures)

# Build & Type Checking
npm run lint             # Type check (tsc --noEmit) + eslint src
```

## Versioning

Bump `package.json`'s `version` with `npm version <patch|minor>` (or `major`) —
never hand-edit the field. `npm version` rewrites `package.json` **and**
`package-lock.json`'s root `version` in the same atomic step, which is what keeps
the lockfile from drifting off the manifest (a real drift the project hit: lock
`1.6.0` vs manifest `1.12.0` across six releases, fixed by
`refresh-dependency-and-node-baseline`). It also creates a `v<version>` git tag by
default; pass `--no-git-tag-version` if a commit/tag pair isn't wanted yet. Run it
from a clean working tree with the version-worthy changes already committed.

## Codebase Structure

```
src/
├── index.ts              # Main entry point, MCP server setup
├── config/               # Configuration management with Zod schemas
├── storage/              # SQLite + Qdrant data layer
├── embedding/            # Embedding providers (OpenAI + Azure Foundry)
├── pipeline/             # Write pipeline (extraction → decision → store)
├── bootstrap/            # Onboarding: section definitions, session state
├── search/               # Hybrid semantic + fulltext search
├── tools/                # MCP tool handlers and schemas
├── resources/            # MCP resource handlers
├── prompts/              # MCP prompts (bootstrap-interview, session-context)
├── transport/            # HTTP server and middleware
├── health/               # Health checks, metrics, logging
├── backup/               # Backup/restore with retention
├── errors/               # Error handling utilities
├── domain/               # Domain logic (normalization, schemas)
├── resilience/           # Circuit breakers for external dependencies
├── cli/                  # CLI entry point
└── version.ts            # PACKAGE_VERSION read from package.json at startup
```

## Key Design Patterns

### Dual Transport Support
- **HTTP Transport**: Default mode, Express server with authentication. Serves real
  MCP via the Streamable HTTP transport at `POST/GET/DELETE /mcp` (per-session
  `Server` + `StreamableHTTPServerTransport` pairs keyed by `Mcp-Session-Id`, built
  through `src/transport/mcp-server.ts`'s `buildMcpServer` and managed by
  `McpSessionManager` in `src/transport/mcp-http.ts`), alongside the REST convenience
  endpoints (`POST /tool/:name`, `GET /resource`).
- **Stdio Transport**: MCP stdio protocol for CLI integration — also builds its
  `Server` via `buildMcpServer`, so both transports share identical tool/resource
  handling.
- Configured via `transport.http.enabled` and `--stdio` flag

### Storage Architecture
- **SQLite**: Metadata, collections, audit logs, configuration
- **Qdrant**: Vector embeddings for semantic search
- **StorageManager**: Unified interface coordinating both stores

### Memory Model
```typescript
interface Memory {
  id: UUID;
  namespace: string;     // Isolation boundary
  collection: string;    // Grouping within namespace
  type: 'episodic' | 'semantic' | 'procedural';
  category?: string;     // Persistent policy context
  content: string;       // Normalized text
  summary: string;       // <= 120 chars
  tags: string[];
  source: 'cli' | 'api' | 'agent' | 'import';
  importance: number;    // [0,1]
  // ... timestamps, access tracking, etc.
}
```

### Write Pipeline
1. **Extraction**: Optional AI-powered content analysis
2. **Decision**: ADD/UPDATE/DELETE/NOOP based on deduplication
3. **Storage**: Atomic save to SQLite + Qdrant

## Testing Patterns

- **Framework**: Vitest with globals enabled
- **Structure**: Co-located `.test.ts` files
- **Mocking**: vi.fn() for dependencies
- **Database**: Temporary SQLite per test with proper cleanup
- **Coverage**: V8 provider, excludes test files

Example test structure:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTool } from './index.js';

describe('feature', () => {
  let ctx: ToolContext;
  
  beforeEach(() => {
    ctx = { /* mock context */ };
  });
  
  it('should handle specific case', async () => {
    // Test implementation
  });
});
```

## Configuration System

- **Schema**: Zod validation with defaults (`src/config/index.ts`)
- **Format**: JSON at `{data_dir}/config.json`
- **Location**: Platform-specific data directories
  - Windows: `%LOCALAPPDATA%\BHGBrain`
  - Unix: `~/.bhgbrain`

### Config vs. environment

Most settings (including **embedding provider/model/dimensions**) live **only** in
`config.json`. The environment supplies just two things:

1. **Secrets**, referenced indirectly by `*_api_key_env` keys. The config stores the
   *name* of the env var to read, not the secret itself:
   - `embedding.api_key_env` → defaults to `OPENAI_API_KEY`
   - `embedding.azure.api_key_env` → defaults to `AZURE_FOUNDRY_API_KEY`
   - `qdrant.api_key_env` → null by default; set to `"QDRANT_API_KEY"` for Qdrant Cloud
   - `pipeline.extraction_model_env` → defaults to `BHGBRAIN_EXTRACTION_API_KEY`. Also
     the credential source for multi-query expansion's LLM paraphrase/HyDE phase
     (`search.query_expansion.llm_paraphrase`, see `add-multi-query-expansion`) —
     `LLMQueryExpansionProvider` resolves the same env var, falling back to
     `OPENAI_API_KEY` when it's unset (`src/search/query-expansion.ts`).
2. **Runtime overrides** applied by `applyEnvOverrides()` — a fixed set only:
   `BHGBRAIN_DATA_DIR`, `BHGBRAIN_HTTP_HOST`, `BHGBRAIN_HTTP_PORT`,
   `BHGBRAIN_QDRANT_MODE`, `BHGBRAIN_QDRANT_URL`, `BHGBRAIN_REQUIRE_LOOPBACK`,
   `BHGBRAIN_ALLOW_UNAUTHENTICATED`, `BHGBRAIN_LOG_LEVEL`, plus `BHGBRAIN_DEVICE_ID`.

Setting an env var outside these two categories has **no effect**. See `.env.example`
for the full, documented variable list.

### Embedding providers

Selected via `embedding.provider` in `config.json`:

- **`openai`** (default) — `src/embedding/index.ts`; key from `OPENAI_API_KEY`.
- **`azure-foundry`** — `src/embedding/azure-foundry.ts`; requires
  `embedding.azure.resource_name`. Endpoint is derived as
  `https://<resource_name>.openai.azure.com`; key from `AZURE_FOUNDRY_API_KEY`.
  Note the per-model dimension constraints enforced by the Zod schema
  (e.g. `text-embedding-3-small` ≤ 1536, `text-embedding-3-large` ≤ 3072).

Every `EmbeddingProvider` exposes `provider`/`model`/`dimensions` plus a derived
`identity` string (`formatEmbeddingIdentity`, `<provider>/<model>@<dimensions>`),
stamped on every vector-producing write onto both the `memories.embedding_model`
SQLite column and the Qdrant payload (`StorageManager.writeMemory`/`updateMemory`/
`reconcileVectorsFromSqlite`; see `toQdrantPayload`). The store's expected identity is
tracked in the singleton `embedding_state` SQLite table (`getExpectedEmbeddingIdentity`/
`adoptEmbeddingIdentityIfAbsent`/`setExpectedEmbeddingIdentity`); a mismatch against the
active configuration degrades the `embedding` health component
(`HealthService.checkEmbeddingIdentityMismatch`) and, while
`embedding.refuse_writes_on_model_mismatch` (default `true`) is set, causes
`StorageManager.ensureEmbeddingIdentityCompatible` to refuse vector-producing writes
with a `CONFLICT` naming the `repair` tool's `mode: "re-embed"` path
(`StorageManager.reembedMismatchedVectors`, also reachable via
`bhgbrain repair --re-embed`). See `openspec/changes/stamp-embedding-provenance` and
the README's "Embedding Model Migration" section.

## Error Handling

- **Structured Errors**: Consistent error format with codes
- **MCP Integration**: Errors properly serialized for MCP clients
- **Validation**: Input validation at tool entry points
- **Logging**: Structured logging with Pino

## Security Considerations

- **Authentication**: Bearer token for HTTP transport, compared with a constant-time
  check (`crypto.timingSafeEqual`) to avoid leaking timing information about the secret
- **Rate Limiting**: IP-based with configurable limits, keyed on `req.ip` as derived per
  `security.trust_proxy` (default `false` — direct socket peer, loopback-accurate;
  `true` — honors `X-Forwarded-For`, only safe behind a trusted reverse proxy).
  Limiter state is scoped per middleware/server instance, not module-global, so
  independent instances (including in tests) never share buckets. A request with no
  derivable client IP fails closed (HTTP 400) rather than sharing a fallback bucket.
- **Input Validation**: Size limits, sanitization
- **Network Binding**: Loopback-only by default
- **Audit Logging**: All operations logged

## OpenSpec Integration

This project uses OpenSpec for change management:
- Changes tracked in `openspec/changes/`
- Skills available via `/opsx:` commands
- Each change has: proposal, design, tasks, and specs

When implementing features, check existing OpenSpec changes first:
```bash
openspec list --json
```

## Common Gotchas

1. **ES Modules**: Always use `.js` extensions in imports
2. **Dual Transport**: Test both HTTP and stdio modes
3. **Namespace Scoping**: Operations are namespace-scoped by default
4. **Collection Delete**: Requires `force: true` for non-empty collections
5. **Memory Types**: Use correct type (`episodic`/`semantic`/`procedural`)
6. **Embedding Dimensions**: Must match Qdrant configuration
7. **Zod Validation**: All config must pass Zod schema validation
8. **Fulltext search runs on FTS5/BM25, with a probed LIKE fallback**:
   `node:sqlite`'s bundled SQLite build compiles in the `fts5` virtual-table module
   (`migrate-sqlite-to-native-engine` replaced the old `sql.js` engine, which did not),
   so `SqliteStore.isFts5Available()` probes `true` in normal operation.
   `fullTextSearch` (`src/storage/sqlite.ts`) branches on that probe: when `true` it
   queries the `memories_fts` FTS5 virtual table (`porter unicode61` tokenizer,
   `bm25(memories_fts, 1.0, 2.0, 2.0)` ranking negated so higher rank still means more
   relevant) via `fullTextSearchFts5`; when `false` it falls back unchanged to the
   legacy `LIKE`-based term-frequency matcher via `fullTextSearchLike`, and the
   `sqlite` health component/startup log surface the fallback. `ensureFtsSchema()`
   (called from `openDatabase()`) idempotently migrates a legacy plain `memories_fts`
   table to FTS5 on startup, backfilling from `memories` — the source of truth — inside
   one transaction. User query terms are sanitized into a safe MATCH expression
   (`buildFts5MatchExpression`, double-quoted phrases joined with `AND`) so FTS5
   operator syntax embedded in a query can never be parsed as an operator. See
   `openspec/changes/upgrade-fulltext-to-fts5`.

## Quick Start for New Features

1. Check OpenSpec for existing proposals
2. Create necessary types in domain schemas
3. Add tool handlers in `tools/index.ts`
4. Implement storage operations
5. Add comprehensive tests
6. Update resource handlers if needed
7. Test both transport modes