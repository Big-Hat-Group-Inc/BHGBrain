# AGENTS.md - BHGBrain Development Guide

## Project Overview

BHGBrain is a persistent, vector-backed memory system for MCP (Model Context Protocol) clients. It provides long-term memory across sessions, repositories, and MCP clients like Claude CLI, Codex, and Gemini.

**Key Technologies:**
- TypeScript with Node.js (>=20.0.0)
- ES modules (`"type": "module"`)
- SQLite for metadata storage (via sql.js)
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

# Build & Type Checking
npm run lint             # Type check (tsc --noEmit) + eslint src
```

## Codebase Structure

```
src/
├── index.ts              # Main entry point, MCP server setup
├── types.d.ts            # TypeScript declarations for sql.js
├── config/               # Configuration management with Zod schemas
├── storage/              # SQLite + Qdrant data layer
├── embedding/            # Embedding providers (OpenAI + Azure Foundry)
├── pipeline/             # Write pipeline (extraction → decision → store)
├── bootstrap/            # Onboarding: section definitions, session state
├── search/               # Hybrid semantic + fulltext search
├── tools/                # MCP tool handlers and schemas
├── resources/            # MCP resource handlers
├── transport/            # HTTP server and middleware
├── health/               # Health checks, metrics, logging
├── backup/               # Backup/restore with retention
├── errors/               # Error handling utilities
├── domain/               # Domain logic (normalization, schemas)
├── resilience/           # Circuit breakers for external dependencies
└── cli/                  # CLI entry point
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
   - `pipeline.extraction_model_env` → defaults to `BHGBRAIN_EXTRACTION_API_KEY`
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
2. **Type Differences**: sql.js types are declared in `types.d.ts`
3. **Dual Transport**: Test both HTTP and stdio modes
4. **Namespace Scoping**: Operations are namespace-scoped by default
5. **Collection Delete**: Requires `force: true` for non-empty collections
6. **Memory Types**: Use correct type (`episodic`/`semantic`/`procedural`)
7. **Embedding Dimensions**: Must match Qdrant configuration
8. **Zod Validation**: All config must pass Zod schema validation
9. **sql.js has no FTS5**: the pinned `sql.js` distribution (`^1.12.0`, currently
   resolving 1.14.1) does **not** compile in the SQLite `fts5` virtual-table module —
   `CREATE VIRTUAL TABLE ... USING fts5` throws `no such module: fts5`, and the wasm
   binary carries no `fts5`/`SQLITE_ENABLE_FTS5` symbols. `SqliteStore.isFts5Available()`
   probes this at startup (always `false` today) and `HealthService` surfaces the
   fallback in the `sqlite` health component's `message`; fulltext search
   (`fullTextSearch` in `src/storage/sqlite.ts`) still runs the legacy `LIKE`-based
   matcher unconditionally. See `openspec/changes/upgrade-fulltext-to-fts5` before
   assuming an FTS5/BM25 index exists — it doesn't, on this dependency.

## Quick Start for New Features

1. Check OpenSpec for existing proposals
2. Create necessary types in domain schemas
3. Add tool handlers in `tools/index.ts`
4. Implement storage operations
5. Add comprehensive tests
6. Update resource handlers if needed
7. Test both transport modes