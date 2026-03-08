# BHGBrain
Extended Memory System

## Collections Delete Semantics

- `collections.delete` now rejects non-empty collections by default.
- To delete a non-empty collection, call with `force: true`.

Example tool payload:

```json
{
  "action": "delete",
  "namespace": "global",
  "name": "general",
  "force": true
}
```

## Backup Restore Activation

- `backup.restore` now reloads runtime SQLite state before returning success.
- Restore responses include `activated: true` when restored data is active immediately.

## HTTP Hardening

- `/health` is intentionally unauthenticated for probe compatibility.
- Rate limiting keys on trusted request identity (IP) and ignores `x-client-id` for enforcement.
- `memory://list` enforces `limit` bounds of `1..100`; invalid values return `INVALID_INPUT`.

## Fail-Closed Authentication

- Non-loopback HTTP bindings require a bearer token by default.
- If `BHGBRAIN_TOKEN` (or configured env var) is not set and the host is non-loopback, the server refuses to start.
- To explicitly allow unauthenticated external access, set `security.allow_unauthenticated_http: true` in config. A high-visibility warning is logged at startup.

## Degraded Embedding Mode

- If embedding provider credentials are missing at startup, the server starts in **degraded mode** instead of crashing.
- Embedding-dependent operations (semantic search, memory ingestion) return `EMBEDDING_UNAVAILABLE` errors at request time.
- Health probes report embedding status as `degraded` without making real API calls.

## MCP Response Contracts

- Tool call responses include structured JSON payloads.
- Error responses set `isError: true` in the MCP protocol for client-side routing.
- Parameterized resources (`memory://{id}`, `category://{name}`, `collection://{name}`) are exposed as MCP resource templates via `resources/templates/list`, not as concrete resources.

## Search and Pagination

- **Collection scoping**: Fulltext and hybrid search respect the caller-provided `collection` filter in both semantic and lexical candidate sets.
- **Stable pagination**: `memory://list` uses composite cursors (`created_at|id`) for deterministic ordering. Rows sharing the same timestamp are not skipped or duplicated across pages.
- **Dependency surfacing**: Semantic search propagates Qdrant failures as explicit errors instead of returning empty results silently.

## Operational Observability

- **Bounded metrics**: Histogram values use a bounded circular buffer (last 1000 samples) to prevent unbounded memory growth in long-running processes.
- **Metric semantics**: Histogram metrics emit `_avg` (average of recent window) and `_count` (sample count) suffixes.
- **Atomic writes**: Database and backup file writes use write-to-temp-then-rename to prevent truncated partial files on crash.
- **Deferred flush**: Read-path access metadata (touch counts) uses bounded async batching (5s window) instead of synchronous full-database flushes per request.
- **Cross-store consistency**: SQLite updates are rolled back if the corresponding Qdrant operation fails, maintaining consistency between stores.
