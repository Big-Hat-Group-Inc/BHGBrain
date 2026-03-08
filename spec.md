# BHGBrain Application Specification (v1)

> Persistent, vector-backed memory for MCP clients (Claude CLI, Codex, Gemini, and other compliant clients).

## 1. Vision

BHGBrain provides long-term memory across sessions, repositories, and MCP clients.

It supports:
- User-directed writes (`remember this`)
- Agent-directed writes (autonomous capture during work)
- Session-start memory injection (`memory://inject`) so context is available without manual recall

Primary v1 use case:
- Cross-repo policy and architecture continuity for teams working across multiple GitHub organizations.

## 2. Goals and Non-Goals

| Area | v1 Goal |
|---|---|
| Persistence | Memories survive restarts and model changes |
| Retrieval | Semantic recall plus hybrid search |
| Multi-client | Same brain usable from multiple MCP clients |
| Isolation | Namespace boundaries prevent accidental leakage |
| Reliability | Structured errors, health checks, backups, audit logs |

Out of scope for v1:
- Multi-user RBAC
- Encryption at rest
- Working-memory TTL store
- Cloud sync

## 3. Core Domain Model

### 3.1 Memory Types

| Type | Meaning | Example |
|---|---|---|
| `episodic` | Time-bound event or decision | "Debugged reconnect loop on 2026-03-06" |
| `semantic` | General fact or concept | "TypeScript generics can be constrained with `extends`" |
| `procedural` | Workflow or runbook | "Run `ob.sh`, then verify `/healthz`" |

### 3.2 Persistent Categories

Categories are always-injected, versioned policy context.

Built-in slots:
- `company-values`
- `architecture`
- `coding-requirements`
- `custom`

Category behavior:
- Always included in `memory://inject`
- Not relevance-scored
- Revisioned on update
- Exempt from decay/consolidation deletion

### 3.3 Memory Record Schema

```text
id             UUID v4
namespace      string (default: global)
collection     string (default: general)
type           episodic | semantic | procedural
category       optional category name
content        normalized text
summary        <= 120 chars
tags           string[]
source         cli | api | agent | import
checksum       SHA-256(normalized content)
embedding      float[]
importance     number [0,1]
access_count   integer >= 0
last_operation ADD | UPDATE | DELETE | NOOP
merged_from    optional UUID
created_at     ISO 8601
updated_at     ISO 8601
last_accessed  ISO 8601
```

### 3.4 Namespace Rules

- All read/write/dedup operations are namespace-scoped by default.
- Cross-namespace search must be explicit.
- Exact match only for namespace filters (no prefix wildcard by default).

## 4. Write Pipeline

### 4.1 Phase A: Extraction

Input: raw content + optional conversational context.

Output: 1..N atomic memory candidates with inferred fields (`type`, `tags`, `importance`).

Behavior:
- If `pipeline.extraction_enabled = false`, skip extraction and store as a single candidate.
- If extraction model is unavailable, fallback to deterministic mode (Section 4.3).

### 4.2 Phase B: Decision (ADD / UPDATE / DELETE / NOOP)

For each candidate, retrieve top-S similar memories from the same namespace (default `S=10`) and classify:

| Decision | Condition | Effect |
|---|---|---|
| `ADD` | No equivalent memory exists | Insert new memory |
| `UPDATE` | Candidate refines existing fact | Replace content, keep `id`/`created_at`, merge tags |
| `DELETE` | Candidate explicitly invalidates existing fact | Delete stale memory and store correction |
| `NOOP` | Redundant with existing memory | No write, return existing id |

### 4.3 Deterministic Fallback

When LLM extraction/classification is unavailable:
1. Exact dedup by checksum in same namespace
2. Near dedup by cosine similarity among top-N candidates
3. If similarity `>= 0.92`, treat as `UPDATE`; else `ADD`

Deterministic `UPDATE` merge policy:
- Preserve existing `id` and `created_at`
- Replace `content`
- Union tags
- Update `updated_at`

## 5. Retention and Consolidation

Base rules:
- No automatic hard-delete by age in v1
- Memories untouched for `retention.decay_after_days` (default `180`) are marked stale
- Category entries never decay

Consolidation job (scheduled daily by default, or manual `bhgbrain gc --consolidate`):
1. Flag stale low-importance memories (`importance < 0.5`)
2. Detect merge clusters (3+ memories, pairwise similarity >= 0.85)
3. Surface contradiction candidates from prior DELETE decisions
4. Refresh stale summaries after content updates

## 6. Architecture

```text
MCP Clients (Claude/Codex/Gemini/others)
  -> MCP transport (HTTP+SSE primary, stdio fallback)
  -> BHGBrain server
      -> Tools + Resources + Auto-inject engine
      -> Embedding provider abstraction
      -> Qdrant (vectors + payload)
      -> SQLite (metadata, FTS5, categories, audit, backup metadata)
```

### 6.1 Transport and Auth

| Transport | Role | Auth |
|---|---|---|
| HTTP + SSE | Primary, multi-client | Bearer token |
| stdio | Local fallback | None |

HTTP security defaults:
- Bind `127.0.0.1`
- Require `Authorization: Bearer <token>`
- Redact tokens in logs
- Non-loopback bind requires explicit config opt-in
- Rate limit default: `100 req/min/client`
- Max request payload default: `1 MiB`

### 6.2 Embedding Provider Rules

Default provider:
- OpenAI `text-embedding-3-small` (1536 dims)

Supported optional alternatives:
- OpenAI `text-embedding-3-large` (3072)
- Local `nomic-embed-text` via Ollama (dimension configured explicitly)

Hard constraints:
- Never mix embedding spaces in one collection
- Provider/model change requires full re-embed or new collection migration
- Embedding failures must return `EMBEDDING_UNAVAILABLE` (no silent fallback)

### 6.3 Storage and Data Paths

| Component | Technology | Role |
|---|---|---|
| Vector index | Qdrant | ANN search and vector payload filtering |
| Metadata | SQLite (`better-sqlite3`) | Categories, tags, FTS5, audit, backup index |

Default paths:
- Windows: `%LOCALAPPDATA%\\BHGBrain\\`
- macOS/Linux: `~/.bhgbrain/`

Files:
- `brain.db`
- `qdrant/`
- `config.json`
- `backups/`

### 6.4 Health, Logs, and Metrics

Health endpoint (`GET /health` and `health://status`) returns:
- overall status: `healthy | degraded | unhealthy`
- component statuses (`sqlite`, `qdrant`, `embedding`)
- memory count, db size, uptime

Status definitions:
- `degraded`: embedding unavailable, reads still work, writes blocked
- `unhealthy`: sqlite or qdrant unavailable

Logging:
- JSON logs with `timestamp`, `level`, `event`, `duration_ms`, `tool`, `namespace`, `error_code`, `client_id`
- Redact bearer tokens and memory content previews by default

Optional metrics (`observability.metrics_enabled = true`):
- `bhgbrain_tool_calls_total`
- `bhgbrain_tool_duration_seconds`
- `bhgbrain_memory_count`
- `bhgbrain_db_size_bytes`
- `bhgbrain_embedding_latency_seconds`
- `bhgbrain_dedup_merges_total`

### 6.5 Graceful Degradation

| Failure | Behavior |
|---|---|
| Embedding provider down | Reads continue, writes fail with `EMBEDDING_UNAVAILABLE` |
| Qdrant down | Fallback to SQLite FTS5 for `search` (fulltext/hybrid degraded), no vector writes |
| Extraction model down | Deterministic fallback pipeline |
| SQLite lock | Retry up to 3 times with exponential backoff, then `INTERNAL` |

## 7. MCP Contract

### 7.1 Global Contract Requirements

All tools must provide strict JSON Schema with:
- `type`, `properties`, `required`
- `additionalProperties: false`
- proper enum and numeric bounds

Standard error envelope:

```json
{
  "error": {
    "code": "INVALID_INPUT | NOT_FOUND | CONFLICT | AUTH_REQUIRED | RATE_LIMITED | EMBEDDING_UNAVAILABLE | INTERNAL",
    "message": "human-readable summary",
    "retryable": false
  }
}
```

Input validation rules:
- `content` max 100000 chars
- `query` max 500 chars
- name/tag max 100 chars
- max 20 tags/memory; tags regex `^[a-zA-Z0-9-]+$`
- namespace regex `^[a-zA-Z0-9/-]{1,200}$`
- strip disallowed control chars (allow tab/newline)
- reject unknown fields

### 7.2 Tools

`remember`
- Input: `content` (required), optional `namespace`, `collection`, `type`, `tags`, `category`, `importance`, `source`
- Output: `{ id, summary, type, operation, merged_with_id?, created_at }`

`recall`
- Input: `query` (required), optional `namespace`, `collection`, `type`, `tags`, `limit` (1..20, default 5), `min_score` (0..1, default 0.6)
- Output: ordered list of `{ id, content, summary, type, tags, score, created_at, last_accessed }`

`forget`
- Input: `id` (required)
- Output: `{ deleted: true, id }`

`search`
- Input: `query` (required), optional `namespace`, `collection`, `mode` (`semantic|fulltext|hybrid`, default `hybrid`), `limit` (1..50, default 10)
- Output: ranked list with `{ score, semantic_score, fulltext_score }`

Hybrid fusion:
- Method: Reciprocal Rank Fusion (RRF)
- Default weights: semantic `0.7`, fulltext `0.3`
- Config key: `search.hybrid_weights`

`tag`
- Input: `id` (required), optional `add[]`, `remove[]`
- Output: `{ id, tags }`

`collections`
- Input: `action` (`list|create|delete`), optional `name`
- Output:
  - list: `{ collections: [{ name, count }] }`
  - create/delete: `{ ok: true, name }`

`category`
- Input: `action` (`list|get|set|delete`), optional `name`, `slot`, `content`
- Output (`get`): `{ name, slot, content, updated_at, revision }`

`backup`
- Input: `action` (`create|restore|list`), optional `path`
- Output (`create`): `{ path, size_bytes, memory_count, created_at }`
- Archive contents: sqlite dump + qdrant snapshot + config without auth token

### 7.3 Resources

| URI | Description |
|---|---|
| `memory://list` | Cursor-paginated memories (newest first) |
| `memory://{id}` | Full memory details |
| `memory://inject?namespace={name}` | Budgeted session context block |
| `category://list` | Categories with preview |
| `category://{name}` | Category full content |
| `collection://list` | Collections + counts |
| `collection://{name}` | Memories in collection |
| `health://status` | Health snapshot |

### 7.4 Auto-Inject

Client-cooperative flow:
1. Client fetches `memory://inject?namespace=...` at session start
2. Payload is prepended to session context
3. Server may advertise this resource during `initialize`

Payload composition order:
1. All category content (full)
2. Top-K relevant memories from `recall` (default `K=10`, `min_score=0.6`)
3. Truncation to configured budget

Default response budgets:
- inject payload max chars: `30000`
- `recall` max response chars: `50000`
- `search` max response chars: `50000`

Overflow behavior:
- truncate by replacing full content with summaries oldest-first
- set `truncated: true`
- include `total_results`

## 8. Typical Workflows

### 8.1 User-directed memory

```text
User: Remember policy solver uses graph-based rules and never mutates shared state.
Client -> remember(...)
Server -> { id: "...", operation: "ADD", summary: "..." }
```

### 8.2 Agent-directed memory

```text
Agent decides to persist: "Use Zod at all API boundaries"
Client -> remember({ source: "agent", ... })
```

### 8.3 Persistent category

```text
Client -> category({ action: "set", slot: "coding-requirements", name: "Coding Requirements", content: "..." })
```

### 8.4 Backup and restore

```bash
bhgbrain backup create
bhgbrain backup restore --path "C:\\...\\2026-03-06T23-18.bhgb"
```

## 9. Configuration

Config path:
- Windows: `%LOCALAPPDATA%\\BHGBrain\\config.json`
- macOS/Linux: `~/.bhgbrain/config.json`

Example (valid single JSON object):

```json
{
  "data_dir": "%LOCALAPPDATA%\\BHGBrain",
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "api_key_env": "OPENAI_API_KEY"
  },
  "qdrant": {
    "mode": "embedded",
    "embedded_path": "./qdrant",
    "external_url": null
  },
  "transport": {
    "http": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 3721,
      "bearer_token_env": "BHGBRAIN_TOKEN"
    },
    "stdio": {
      "enabled": true
    }
  },
  "defaults": {
    "namespace": "global",
    "collection": "general",
    "recall_limit": 5,
    "min_score": 0.6,
    "auto_inject_limit": 10,
    "max_response_chars": 50000
  },
  "retention": {
    "decay_after_days": 180,
    "max_db_size_gb": 2,
    "max_memories": 500000,
    "warn_at_percent": 80
  },
  "deduplication": {
    "enabled": true,
    "similarity_threshold": 0.92
  },
  "search": {
    "hybrid_weights": {
      "semantic": 0.7,
      "fulltext": 0.3
    }
  },
  "security": {
    "require_loopback_http": true,
    "log_redaction": true,
    "rate_limit_rpm": 100,
    "max_request_size_bytes": 1048576
  },
  "auto_inject": {
    "max_chars": 30000,
    "max_tokens": null
  },
  "observability": {
    "metrics_enabled": false,
    "structured_logging": true,
    "log_level": "info"
  },
  "pipeline": {
    "extraction_enabled": true,
    "extraction_model": "gpt-4o-mini",
    "extraction_model_env": "BHGBRAIN_EXTRACTION_API_KEY",
    "fallback_to_threshold_dedup": true
  },
  "auto_summarize": true
}
```

## 10. CLI and Registration

### 10.1 Claude CLI registration

```bash
claude mcp add bhgbrain \
  --transport http \
  --url http://127.0.0.1:3721 \
  --header "Authorization: Bearer $BHGBRAIN_TOKEN"

claude mcp add bhgbrain -- npx bhgbrain-server --stdio
```

### 10.2 Companion CLI (`bhgbrain`)

```bash
bhgbrain list --limit 20
bhgbrain search "query" --mode hybrid
bhgbrain show <id>
bhgbrain forget <id>

bhgbrain category list
bhgbrain category set "Coding Requirements" --file requirements.md

bhgbrain backup create
bhgbrain backup list
bhgbrain backup restore --path ./my-backup.bhgb

bhgbrain server start
bhgbrain server status
bhgbrain server token rotate

bhgbrain gc
bhgbrain gc --consolidate
bhgbrain stats
bhgbrain health
bhgbrain audit --limit 50
```

## 11. Privacy and Security Requirements

Data egress:
- Remote embedding providers send memory text for embedding.
- Local transport/storage paths remain local.

Required controls:
- Store env var names only, never raw API keys
- Token rotation invalidates prior token immediately
- `--confirm` option for destructive operations (`forget`, overwrite restore)
- Secret-pattern heuristic scan before persistence (reject likely credentials)
- Audit log for all write/delete events with timestamp, namespace, client id

## 12. Acceptance Criteria (v1)

1. All tools enforce strict JSON Schema and reject unknown fields.
2. Namespace isolation is enforced by default in read/write/dedup/search.
3. `memory://inject` works in Claude CLI plus at least one other MCP client.
4. Backup restore passes integrity check (count + checksum).
5. Concurrent writes do not corrupt SQLite or Qdrant state.
6. Windows non-admin installation and runtime are verified.
7. Write pipeline supports extraction + decision, with deterministic fallback.
8. Health endpoint reports sqlite, qdrant, and embedding component state.
9. Response size budgeting is enforced with truncation metadata.
10. Structured logging redacts tokens/content previews by default.
11. HTTP rate limiting defaults to 100 req/min/client.
12. Embedding failures return `EMBEDDING_UNAVAILABLE` only (no silent fallback).
13. Validation rejects oversize payloads and malformed namespace/tag input.
14. Audit log captures all write/delete operations.

## 13. Test Strategy

| Layer | Scope | Tooling |
|---|---|---|
| Unit | Dedup logic, validators, scoring | Vitest |
| Integration | Tool to embedding to storage round-trips | Vitest + fixtures |
| Contract | MCP schema + error behavior | Vitest + schema checks |
| Load | Concurrent writes, 10k+ memory search | k6 or autocannon |

Required scenarios:
- embedding outage behavior
- concurrent same-namespace writes
- ADD/UPDATE/DELETE/NOOP correctness
- backup round-trip fidelity
- inject payload budget enforcement
- rate limit and token rotation behavior
