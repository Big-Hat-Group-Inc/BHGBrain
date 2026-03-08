# BHGBrain

Persistent, vector-backed memory for MCP clients (Claude, Codex, OpenClaw, etc.).

BHGBrain stores memories in SQLite (metadata + fulltext) and Qdrant (semantic vectors), exposing them over MCP via stdio or HTTP. It is designed to give AI agents a durable, searchable second brain across sessions.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Qdrant Setup](#qdrant-setup)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [Environment Variables](#environment-variables)
6. [Running the Server](#running-the-server)
7. [MCP Client Configuration](#mcp-client-configuration)
8. [Bootstrap Prompt](#bootstrap-prompt)
9. [CLI Reference](#cli-reference)
10. [Behavior Notes](#behavior-notes)

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 20.0.0 | LTS recommended |
| Qdrant | ≥ 1.9 | Must be running before starting BHGBrain |
| OpenAI API key | — | For embeddings (`text-embedding-3-small` by default) |

---

## Qdrant Setup

BHGBrain **requires an external Qdrant instance**. Even in the default `embedded` mode, the server connects to `http://localhost:6333` — there is no bundled Qdrant binary. You must run it yourself.

### Option A: Docker (recommended)

```bash
docker run -d \
  --name qdrant \
  --restart unless-stopped \
  -p 6333:6333 \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

Verify it's running:

```bash
curl http://localhost:6333/health
# → {"title":"qdrant - vector search engine","version":"..."}
```

### Option B: Docker Compose

```yaml
services:
  qdrant:
    image: qdrant/qdrant
    restart: unless-stopped
    ports:
      - "6333:6333"
    volumes:
      - qdrant_storage:/qdrant/storage

volumes:
  qdrant_storage:
```

### Option C: Native binary

Download from [https://github.com/qdrant/qdrant/releases](https://github.com/qdrant/qdrant/releases) and run:

```bash
./qdrant
```

### Option D: Qdrant Cloud (external mode)

Set `qdrant.mode` to `external` in your config and point `external_url` at your cloud cluster URL. Set `qdrant.api_key_env` to the env var holding your Qdrant API key.

---

## Installation

```bash
git clone https://github.com/Big-Hat-Group-Inc/BHGBrain.git
cd BHGBrain
npm install
npm run build
```

To install globally as a CLI:

```bash
npm install -g .
bhgbrain --help
```

---

## Configuration

BHGBrain loads config from:

- **Windows:** `%LOCALAPPDATA%\BHGBrain\config.json`
- **Linux/macOS:** `~/.bhgbrain/config.json`

The file is created automatically on first run with defaults. Edit it to customise behaviour.

### Key config fields

```jsonc
{
  // Qdrant connection mode: "embedded" = localhost:6333, "external" = custom URL
  "qdrant": {
    "mode": "embedded",
    "embedded_path": "./qdrant",
    "external_url": null,
    "api_key_env": null
  },

  // Embedding model (OpenAI)
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "api_key_env": "OPENAI_API_KEY",
    "dimensions": 1536
  },

  // HTTP transport (for remote MCP clients or mcporter)
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

  // Memory defaults
  "defaults": {
    "namespace": "global",
    "collection": "general",
    "recall_limit": 5,
    "min_score": 0.6
  }
}
```

See `src/config/index.ts` for the full schema with all defaults.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes (for embeddings) | OpenAI API key. Server starts in **degraded mode** if missing. |
| `BHGBRAIN_TOKEN` | Yes (for HTTP, non-loopback) | Bearer token for HTTP auth. Required on non-loopback bindings unless `security.allow_unauthenticated_http: true`. |
| `BHGBRAIN_EXTRACTION_API_KEY` | No | OpenAI key for the extraction/pipeline model. Falls back to `OPENAI_API_KEY` if not set. |

Generate a token:

```bash
bhgbrain server token
# or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Running the Server

### stdio mode (MCP over stdin/stdout)

```bash
# dev (no build required)
npm run dev

# production
node dist/index.js
```

### HTTP mode

HTTP is enabled by default on `127.0.0.1:3721`. Set `BHGBRAIN_TOKEN` before starting:

```bash
export OPENAI_API_KEY=sk-...
export BHGBRAIN_TOKEN=<your-token>
node dist/index.js
```

Health check (unauthenticated):

```bash
curl http://127.0.0.1:3721/health
```

---

## MCP Client Configuration

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "bhgbrain": {
      "command": "node",
      "args": ["C:/path/to/BHGBrain/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### OpenClaw / mcporter (HTTP transport)

```json
{
  "mcpServers": {
    "bhgbrain": {
      "transport": "http",
      "url": "http://127.0.0.1:3721",
      "env": {
        "BHGBRAIN_TOKEN": "<your-token>"
      }
    }
  }
}
```

---

## Bootstrap Prompt

`BootstrapPrompt.txt` contains a structured interview prompt for building a **work second brain profile** with an AI agent.

Use it when onboarding a new AI assistant or when you want to populate BHGBrain with a rich, structured profile of your work context, entities, tenants, and disambiguation rules.

### How to use it

1. Start a fresh conversation with your AI assistant (Claude, GPT-4, etc.).
2. Paste the entire contents of `BootstrapPrompt.txt` as your first message.
3. Let the agent interview you section by section.
4. At the end, the agent will produce a structured profile you can save to BHGBrain via `bhgbrain.remember` calls (or `mcporter call bhgbrain.remember`).

### What it covers

The interview walks through 10 sections:

| Section | What it captures |
|---|---|
| 1. Identity & role | Name, titles, primary vs client-facing roles |
| 2. Responsibilities | What you own, what you influence |
| 3. Goals | 30-day, quarterly, yearly priorities |
| 4. Communication style | How you want information presented |
| 5. Work patterns | Strategic thinking vs execution windows |
| 6. Tools & systems | Sources of truth, key platforms |
| 7. Company & entity map | Every org, client, product, and relationship |
| 8. GitHub / repo structure | Orgs, repos, who owns what |
| 9. Tenant & environment map | Azure tenants, dev/staging/prod |
| 10. Operating rules | Naming conventions, disambiguation, default assumptions |

The output produces a clean structured profile with all 10 sections plus a disambiguation guide — exactly what BHGBrain needs to answer questions about your work reliably.

---

## CLI Reference

```bash
bhgbrain list                    # List recent memories
bhgbrain search <query>          # Hybrid search
bhgbrain show <id>               # Show full memory
bhgbrain forget <id>             # Delete a memory
bhgbrain stats                   # DB + collection stats
bhgbrain health                  # System health check
bhgbrain gc                      # Garbage collection
bhgbrain gc --consolidate        # GC + consolidation pass
bhgbrain audit                   # Show audit log
bhgbrain category list           # List categories
bhgbrain category get <name>     # Get category content
bhgbrain category set <name>     # Set category content
bhgbrain backup create           # Create backup
bhgbrain backup list             # List backups
bhgbrain backup restore <path>   # Restore from backup
bhgbrain server start            # Start the MCP server
bhgbrain server status           # Check server health
bhgbrain server token            # Generate a new bearer token
```

---

## Behavior Notes

### Collections Delete Semantics

`collections.delete` rejects non-empty collections by default. Use `force: true` to override:

```json
{
  "action": "delete",
  "namespace": "global",
  "name": "general",
  "force": true
}
```

### Backup Restore Activation

`backup.restore` reloads runtime SQLite state before returning success. Restore responses include `activated: true` when restored data is immediately active.

### HTTP Hardening

- `/health` is intentionally unauthenticated for probe compatibility.
- Rate limiting keys on trusted request identity (IP) and ignores `x-client-id` for enforcement.
- `memory://list` enforces `limit` bounds of `1..100`; invalid values return `INVALID_INPUT`.

### Fail-Closed Authentication

- Non-loopback HTTP bindings require a bearer token by default.
- If `BHGBRAIN_TOKEN` is not set and the host is non-loopback, the server refuses to start.
- To explicitly allow unauthenticated external access, set `security.allow_unauthenticated_http: true` in config. A high-visibility warning is logged at startup.

### Degraded Embedding Mode

- If embedding provider credentials are missing at startup, the server starts in **degraded mode** instead of crashing.
- Embedding-dependent operations (semantic search, memory ingestion) return `EMBEDDING_UNAVAILABLE` at request time.
- Health probes report embedding status as `degraded` without making real API calls.

### MCP Response Contracts

- Tool call responses include structured JSON payloads.
- Error responses set `isError: true` in the MCP protocol for client-side routing.
- Parameterized resources (`memory://{id}`, `category://{name}`, `collection://{name}`) are exposed as MCP resource templates via `resources/templates/list`.

### Search and Pagination

- **Collection scoping:** Fulltext and hybrid search respect the caller-provided `collection` filter in both semantic and lexical candidate sets.
- **Stable pagination:** `memory://list` uses composite cursors (`created_at|id`) for deterministic ordering. Rows sharing the same timestamp are not skipped or duplicated across pages.
- **Dependency surfacing:** Semantic search propagates Qdrant failures as explicit errors instead of returning empty results silently.

### Operational Observability

- **Bounded metrics:** Histogram values use a bounded circular buffer (last 1000 samples).
- **Metric semantics:** Histogram metrics emit `_avg` and `_count` suffixes.
- **Atomic writes:** Database and backup file writes use write-to-temp-then-rename to prevent truncated partial files on crash.
- **Deferred flush:** Read-path access metadata (touch counts) uses bounded async batching (5s window) instead of synchronous full-database flushes per request.
- **Cross-store consistency:** SQLite updates are rolled back if the corresponding Qdrant operation fails.
