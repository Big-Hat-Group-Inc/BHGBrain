# AGENTS.md - BHGBrain Development Guide

## Project Overview

BHGBrain is a persistent, vector-backed memory system for MCP (Model Context Protocol) clients. It provides long-term memory across sessions, repositories, and MCP clients like Claude CLI, Codex, and Gemini.

**Key Technologies:**
- TypeScript with Node.js (>=20.0.0)
- ES modules (`"type": "module"`)
- SQLite for metadata storage (via sql.js)
- Qdrant for vector storage
- OpenAI for embeddings
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
npm run lint             # TypeScript type checking (no emit)
```

## Codebase Structure

```
src/
├── index.ts              # Main entry point, MCP server setup
├── types.d.ts            # TypeScript declarations for sql.js
├── config/               # Configuration management with Zod schemas
├── storage/              # SQLite + Qdrant data layer
├── embedding/            # OpenAI embedding provider
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
└── cli/                  # CLI entry point
```

## Key Design Patterns

### Dual Transport Support
- **HTTP Transport**: Default mode, Express server with authentication
- **Stdio Transport**: MCP stdio protocol for CLI integration
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

- **Schema**: Zod validation with defaults
- **Format**: JSON at `{data_dir}/config.json`
- **Environment**: Supports env var references (e.g., `OPENAI_API_KEY`)
- **Location**: Platform-specific data directories
  - Windows: `%LOCALAPPDATA%\BHGBrain`
  - Unix: `~/.bhgbrain`

## Error Handling

- **Structured Errors**: Consistent error format with codes
- **MCP Integration**: Errors properly serialized for MCP clients
- **Validation**: Input validation at tool entry points
- **Logging**: Structured logging with Pino

## Security Considerations

- **Authentication**: Bearer token for HTTP transport
- **Rate Limiting**: IP-based with configurable limits
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

## Quick Start for New Features

1. Check OpenSpec for existing proposals
2. Create necessary types in domain schemas
3. Add tool handlers in `tools/index.ts`
4. Implement storage operations
5. Add comprehensive tests
6. Update resource handlers if needed
7. Test both transport modes