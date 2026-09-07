import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_TOOL_DEFINITIONS, MCP_TOOL_NAMES } from './schemas.js';
import { handleTool, type ToolContext } from './index.js';
import { buildMcpServer } from '../transport/mcp-server.js';
import type { ResourceHandler } from '../resources/index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { WritePipeline } from '../pipeline/index.js';
import type { SearchService } from '../search/index.js';
import type { BackupService } from '../backup/index.js';
import type { HealthService } from '../health/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type pino from 'pino';

function bareCtx(): ToolContext {
  return {
    config: {} as ToolContext['config'],
    storage: {} as StorageManager,
    embedding: {} as EmbeddingProvider,
    pipeline: {} as WritePipeline,
    search: {} as SearchService,
    backup: {} as BackupService,
    health: {} as HealthService,
    metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
  };
}

describe('MCP_TOOL_DEFINITIONS (task 2.1)', () => {
  it('has exactly 16 tools', () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(16);
  });

  it('every tool has a non-empty title and an annotations block', () => {
    for (const tool of MCP_TOOL_DEFINITIONS) {
      expect(tool.title, `${tool.name} is missing a title`).toBeTruthy();
      expect(tool.annotations, `${tool.name} is missing annotations`).toBeDefined();
      expect(tool.annotations.openWorldHint).toBe(false);
    }
  });

  it('recall and search are readOnlyHint and omit destructive/idempotent hints', () => {
    for (const name of ['recall', 'search']) {
      const tool = MCP_TOOL_DEFINITIONS.find(t => t.name === name)!;
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect('destructiveHint' in tool.annotations).toBe(false);
      expect('idempotentHint' in tool.annotations).toBe(false);
    }
  });

  it('forget, collections, category, backup, and revisions declare destructiveHint: true', () => {
    for (const name of ['forget', 'collections', 'category', 'backup', 'revisions']) {
      const tool = MCP_TOOL_DEFINITIONS.find(t => t.name === name)!;
      expect(tool.annotations.destructiveHint, `${name} should be destructiveHint: true`).toBe(true);
    }
  });

  it('recall, search, and remember declare an outputSchema; other tools do not', () => {
    for (const name of ['recall', 'search', 'remember']) {
      const tool = MCP_TOOL_DEFINITIONS.find(t => t.name === name)!;
      expect(tool.outputSchema, `${name} should declare outputSchema`).toBeDefined();
    }
    for (const tool of MCP_TOOL_DEFINITIONS) {
      if (['recall', 'search', 'remember'].includes(tool.name)) continue;
      expect((tool as { outputSchema?: unknown }).outputSchema).toBeUndefined();
    }
  });
});

describe('collection/category name charset (fix-collection-name-collision)', () => {
  // `collection` and `category.name` are embedded directly in a Qdrant
  // collection name (`QdrantStore.collectionName`); a literal `.` or `/`
  // used to pass schema validation and could collide two distinct values
  // onto the same physical Qdrant collection. Both must now be rejected at
  // the input boundary instead of silently colliding downstream.
  it("rejects a literal dot in remember's collection with INVALID_INPUT", async () => {
    const result = await handleTool(bareCtx(), 'remember', { content: 'x', collection: 'a.b' }, 'c1') as { error: { code: string } };
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it("rejects a slash in remember's collection with INVALID_INPUT", async () => {
    const result = await handleTool(bareCtx(), 'remember', { content: 'x', collection: 'a/b' }, 'c1') as { error: { code: string } };
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('rejects a slash in collections.name with INVALID_INPUT', async () => {
    const result = await handleTool(bareCtx(), 'collections', { action: 'create', name: 'a/b' }, 'c1') as { error: { code: string } };
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it("rejects a literal dot in category's name with INVALID_INPUT", async () => {
    const result = await handleTool(bareCtx(), 'category', { action: 'set', name: 'a.b', slot: 'custom', content: 'x' }, 'c1') as { error: { code: string } };
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});

describe('MCP_TOOL_NAMES lockstep with dispatch (task 3.2)', () => {
  it('every name in MCP_TOOL_NAMES has a dispatch case (does not return "Unknown tool")', async () => {
    for (const name of MCP_TOOL_NAMES) {
      const result = await handleTool(bareCtx(), name, {}, 'c1') as { error?: { message?: string } };
      // Any dispatch-reachable tool fails on input validation (bare {} args)
      // rather than falling through to the "Unknown tool" default arm.
      expect(result.error?.message, `${name} unexpectedly hit the "Unknown tool" arm`).not.toMatch(/^Unknown tool:/);
    }
  });

  it('an unknown name through dispatch surfaces "Unknown tool" (REST backstop, task 3.1 note)', async () => {
    const result = await handleTool(bareCtx(), 'does-not-exist', {}, 'c1') as { error: { code: string; message: string } };
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/^Unknown tool:/);
  });
});

// strengthen-verification-and-code-boundaries task 2.4: the block above only
// checks one direction (every schema name reaches a dispatch case). A tool
// added straight to `dispatch`'s switch without a matching schema/
// registration would still work when called directly — invisible in
// `tools/list`, unvalidated, undocumented — and nothing above would catch
// it (see design.md decision 4, "a one-direction check ... hidden
// dispatch-only tools still escape it"). The tests below close that gap in
// both directions across every surface a tool name is registered on:
// dispatch's own case list (source-scanned, since `dispatch`'s `toolName`
// parameter is plain `string`, not a literal union TS could exhaustiveness-
// check for us), the real MCP `tools/list` declaration, and the REST
// `/tool/:name` endpoint.
describe('tool name parity across dispatch, schemas, MCP declarations, and REST (task 2.4)', () => {
  // Source-scanned rather than imported: `dispatch` in ./index.ts is
  // intentionally unexported (it's an internal routing detail, not part of
  // the module's public surface), so its case labels are the one part of
  // this parity chain not already reachable through an export. Regexing the
  // switch statement's own source is the direct way to see what dispatch
  // actually declares, independent of what MCP_TOOL_NAMES claims.
  function dispatchCaseNames(): string[] {
    const indexTsPath = join(dirname(fileURLToPath(import.meta.url)), 'index.ts');
    const source = readFileSync(indexTsPath, 'utf-8');
    const dispatchStart = source.indexOf('async function dispatch(');
    expect(dispatchStart, 'dispatch() not found in tools/index.ts — has it been renamed?').toBeGreaterThanOrEqual(0);
    const dispatchEnd = source.indexOf('\n}', source.indexOf('switch (toolName) {', dispatchStart));
    expect(dispatchEnd, 'could not locate the end of dispatch()\'s switch statement').toBeGreaterThan(dispatchStart);
    const switchBody = source.slice(dispatchStart, dispatchEnd);
    return [...switchBody.matchAll(/case '([\w-]+)':/g)].map(m => m[1]!);
  }

  it('every dispatch case has a registered schema (the direction the lockstep test above does not cover)', () => {
    const caseNames = dispatchCaseNames();
    expect(caseNames.length, 'source-scan found no cases at all — the regex likely no longer matches dispatch\'s shape').toBeGreaterThan(0);
    for (const name of caseNames) {
      expect(MCP_TOOL_NAMES.has(name), `dispatch has a case for "${name}" with no matching MCP_TOOL_NAMES/MCP_TOOL_DEFINITIONS registration`).toBe(true);
    }
  });

  it('dispatch cases and MCP_TOOL_NAMES are the exact same set, not just each subset of the other', () => {
    const caseNames = new Set(dispatchCaseNames());
    expect(caseNames).toEqual(new Set(MCP_TOOL_NAMES));
  });

  it('the real MCP tools/list declaration exposes exactly MCP_TOOL_NAMES', async () => {
    const server = buildMcpServer(bareCtx(), { handle: vi.fn() } as unknown as ResourceHandler);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'parity-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();

    expect(new Set(tools.map(t => t.name))).toEqual(new Set(MCP_TOOL_NAMES));

    await client.close();
    await server.close();
  });

  it('the REST /tool/:name route has no separate allowlist that could drift from dispatch (source-scanned)', () => {
    // Structural, not behavioral: confirms `req.params.name` is passed
    // straight into `handleTool` with nothing in between that could filter
    // or remap it — i.e. REST has no allowlist array of its own to fall out
    // of sync with `MCP_TOOL_NAMES`/dispatch, unlike a hand-maintained list
    // would. Every tool name's REST behavior is therefore already covered by
    // the dispatch-level assertions above, and separately exercised
    // end-to-end (one representative tool, over real HTTP) in
    // transport/http.test.ts.
    const httpTsPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'transport', 'http.ts');
    const source = readFileSync(httpTsPath, 'utf-8');
    const routeStart = source.indexOf("app.post('/tool/:name'");
    expect(routeStart, "POST /tool/:name route not found in transport/http.ts — has it moved or been renamed?").toBeGreaterThanOrEqual(0);
    const routeEnd = source.indexOf('});', routeStart);
    const routeBody = source.slice(routeStart, routeEnd);
    expect(routeBody).toMatch(/handleTool\(ctx, req\.params\.name,/);
  });
});
