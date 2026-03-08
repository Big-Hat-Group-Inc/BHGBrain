# BHGBrain v1 Implementation Checklist

Use this checklist to track delivery against `spec.md`.

## 1. Foundation

- [ ] Initialize TypeScript Node 20+ project structure
- [ ] Add MCP server scaffolding (`@modelcontextprotocol/sdk`)
- [ ] Add config loader with OS-specific default config path resolution
- [ ] Add strict config schema validation at startup
- [ ] Create data directory bootstrap (`brain.db`, `qdrant/`, `backups/`)

## 2. Storage Layer

- [ ] Integrate SQLite (`better-sqlite3`) for metadata
- [ ] Create SQLite schema: memories metadata, categories, tags, audit logs, backup metadata
- [ ] Enable SQLite FTS5 tables/indexes for full-text search
- [ ] Integrate Qdrant client/embedded mode abstraction
- [ ] Implement storage migrations/versioning

## 3. Embeddings

- [ ] Implement embedding provider abstraction interface
- [ ] Implement OpenAI `text-embedding-3-small` provider (default)
- [ ] Add optional providers (`text-embedding-3-large`, local Ollama)
- [ ] Enforce embedding-space compatibility checks (no mixed dimensions/models)
- [ ] Return `EMBEDDING_UNAVAILABLE` on embedding failures (no silent fallback)

## 4. Memory Domain + Pipeline

- [ ] Implement memory record model with required fields (including checksum, summary, importance)
- [ ] Implement content normalization + SHA-256 checksum generation
- [ ] Implement extraction phase (toggle via `pipeline.extraction_enabled`)
- [ ] Implement decision phase (`ADD`/`UPDATE`/`DELETE`/`NOOP`)
- [ ] Implement deterministic fallback (checksum + cosine threshold >= 0.92)
- [ ] Implement deterministic merge policy (preserve id/created_at, replace content, union tags)

## 5. Namespace, Collections, Categories

- [ ] Enforce namespace-scoped reads/writes/dedup/search by default
- [ ] Implement collections CRUD semantics
- [ ] Implement persistent category CRUD with slot validation
- [ ] Implement category revision history
- [ ] Exempt categories from decay/deletion logic

## 6. MCP Tools

- [ ] Implement `remember`
- [ ] Implement `recall`
- [ ] Implement `forget`
- [ ] Implement `search` (`semantic`, `fulltext`, `hybrid`)
- [ ] Implement `tag`
- [ ] Implement `collections`
- [ ] Implement `category`
- [ ] Implement `backup`

## 7. MCP Resources + Auto-Inject

- [ ] Implement `memory://list` (cursor pagination)
- [ ] Implement `memory://{id}`
- [ ] Implement `memory://inject?namespace={name}`
- [ ] Implement `category://list` and `category://{name}`
- [ ] Implement `collection://list` and `collection://{name}`
- [ ] Implement `health://status`
- [ ] Implement auto-inject composition order (categories first, then top-K memories)
- [ ] Implement response budgeting + truncation metadata (`truncated`, `total_results`)

## 8. Search and Ranking

- [ ] Implement semantic search over Qdrant
- [ ] Implement full-text search over SQLite FTS5
- [ ] Implement hybrid search with RRF fusion
- [ ] Make fusion weights configurable (`search.hybrid_weights`)

## 9. Transport and Security

- [ ] Implement HTTP+SSE transport
- [ ] Implement stdio transport
- [ ] Enforce bearer auth on HTTP endpoints
- [ ] Default bind to `127.0.0.1`
- [ ] Implement request size limits
- [ ] Implement per-client rate limiting (default 100 req/min)
- [ ] Add token generation and rotation (`bhgbrain server token rotate`)
- [ ] Redact tokens and sensitive previews in logs
- [ ] Add heuristic secret scan to reject likely credentials in memory content

## 10. Validation and Error Contracts

- [ ] Publish strict JSON Schema for each tool input/output
- [ ] Set `additionalProperties: false` on all tool schemas
- [ ] Enforce field bounds and regex constraints (content/query/tag/namespace)
- [ ] Standardize error envelope and error codes across tools
- [ ] Log validation failures at `warn` with redacted previews

## 11. Health, Observability, and Audit

- [ ] Implement `GET /health`
- [ ] Implement component health checks (`sqlite`, `qdrant`, `embedding`)
- [ ] Implement structured JSON logging fields from spec
- [ ] Add optional Prometheus metrics gate (`observability.metrics_enabled`)
- [ ] Implement audit log for all write/delete operations with client context

## 12. Retention and Consolidation

- [ ] Mark stale memories after `retention.decay_after_days`
- [ ] Implement scheduled consolidation job (daily default)
- [ ] Implement stale low-importance candidate detection
- [ ] Implement similarity cluster detection (3+ memories, pairwise >= 0.85)
- [ ] Implement contradiction candidate surfacing from prior DELETE decisions
- [ ] Implement summary refresh for updated content

## 13. Backup and Restore

- [ ] Implement backup creation (SQLite dump + Qdrant snapshot + safe config)
- [ ] Implement backup listing
- [ ] Implement restore workflow with overwrite protections
- [ ] Add `--confirm` support for destructive restore behavior
- [ ] Implement integrity verification (count + checksum)

## 14. Companion CLI (`bhgbrain`)

- [ ] Implement memory commands (`list`, `search`, `show`, `forget`)
- [ ] Implement category commands (`list`, `get`, `set`)
- [ ] Implement backup commands (`create`, `list`, `restore`)
- [ ] Implement server commands (`start`, `stop`, `status`, `token rotate`)
- [ ] Implement maintenance commands (`gc`, `gc --consolidate`, `stats`, `health`, `audit`)

## 15. Testing and Ship Gate

- [ ] Unit tests: validators, dedup logic, ranking logic
- [ ] Integration tests: tool -> embedding -> storage round-trips
- [ ] Contract tests: schema enforcement + error envelope
- [ ] Load tests: concurrent writes + 10k+ memory search
- [ ] Test embedding outage behavior
- [ ] Test concurrent same-namespace writes
- [ ] Test pipeline decision correctness (ADD/UPDATE/DELETE/NOOP)
- [ ] Test backup round-trip fidelity
- [ ] Test auto-inject budget enforcement
- [ ] Test rate limiting and token rotation
- [ ] Verify Windows non-admin install/runtime
- [ ] Verify acceptance criteria 1-14 from `spec.md`

## 16. Release Readiness

- [ ] Package `bhgbrain-server` and `bhgbrain` for npm
- [ ] Document Claude CLI registration (HTTP + stdio)
- [ ] Document Codex/Gemini MCP connection instructions
- [ ] Provide migration notes for embedding model/provider changes
- [ ] Final security review: secrets handling, logging redaction, auth defaults
