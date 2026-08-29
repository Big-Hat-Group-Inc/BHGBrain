import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolContext } from '../tools/index.js';
import type { ResourceHandler } from '../resources/index.js';

const handleToolMock = vi.fn();

vi.mock('../tools/index.js', () => ({
  handleTool: handleToolMock,
}));

describe('buildMcpServer', () => {
  beforeEach(() => {
    handleToolMock.mockReset();
  });

  it('returns a distinct Server instance on every call', async () => {
    const { buildMcpServer } = await import('./mcp-server.js');
    const ctx = {} as ToolContext;
    const resources = { handle: vi.fn() } as unknown as ResourceHandler;

    const a = buildMcpServer(ctx, resources);
    const b = buildMcpServer(ctx, resources);

    expect(a).not.toBe(b);
  });

  it('CallTool handler delegates to handleTool and shapes the MCP response', async () => {
    const { buildMcpServer } = await import('./mcp-server.js');
    const ctx = {} as ToolContext;
    const resources = { handle: vi.fn() } as unknown as ResourceHandler;
    handleToolMock.mockResolvedValue({ ok: true, id: 'mem-1' });

    const server = buildMcpServer(ctx, resources);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({ name: 'remember', arguments: { content: 'hello' } });

    expect(handleToolMock).toHaveBeenCalledWith(ctx, 'remember', { content: 'hello' });
    expect(JSON.stringify(result.structuredContent)).toContain('mem-1');

    await client.close();
    await server.close();
  });

  it('ReadResource handler delegates to resources.handle', async () => {
    const { buildMcpServer } = await import('./mcp-server.js');
    const ctx = {} as ToolContext;
    const handle = vi.fn(async (uri: string) => ({ uri, items: [] }));
    const resources = { handle } as unknown as ResourceHandler;

    const server = buildMcpServer(ctx, resources);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.readResource({ uri: 'memory://list' });

    expect(handle).toHaveBeenCalledWith('memory://list');
    expect(result.contents[0]?.uri).toBe('memory://list');
    expect(JSON.stringify(result.contents[0]?.text)).toContain('memory://list');

    await client.close();
    await server.close();
  });

  it('rejects an unknown tool name as a JSON-RPC InvalidParams protocol error, not an isError tool result (task 3.1/3.2)', async () => {
    const { buildMcpServer } = await import('./mcp-server.js');
    const ctx = {} as ToolContext;
    const resources = { handle: vi.fn() } as unknown as ResourceHandler;

    const server = buildMcpServer(ctx, resources);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    await expect(client.callTool({ name: 'does-not-exist', arguments: {} }))
      .rejects.toMatchObject({ code: -32602 });
    expect(handleToolMock).not.toHaveBeenCalled();

    await client.close();
    await server.close();
  });

  it('normalizes a single remember result to { results: [...] } on the MCP path (task 2.3)', async () => {
    const { buildMcpServer } = await import('./mcp-server.js');
    const ctx = {} as ToolContext;
    const resources = { handle: vi.fn() } as unknown as ResourceHandler;
    handleToolMock.mockResolvedValue({ id: 'mem-1', summary: 's', type: 'semantic', operation: 'ADD', created_at: 'now' });

    const server = buildMcpServer(ctx, resources);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({ name: 'remember', arguments: { content: 'hello' } });

    expect(result.structuredContent).toEqual({
      results: [{ id: 'mem-1', summary: 's', type: 'semantic', operation: 'ADD', created_at: 'now' }],
    });

    await client.close();
    await server.close();
  });

  it('normalizes a multi-candidate remember array result to { results: [...] } on the MCP path (task 2.3)', async () => {
    const { buildMcpServer } = await import('./mcp-server.js');
    const ctx = {} as ToolContext;
    const resources = { handle: vi.fn() } as unknown as ResourceHandler;
    const candidates = [
      { id: 'mem-1', summary: 's1', type: 'semantic', operation: 'ADD', created_at: 'now' },
      { id: 'mem-2', summary: 's2', type: 'semantic', operation: 'ADD', created_at: 'now' },
    ];
    handleToolMock.mockResolvedValue(candidates);

    const server = buildMcpServer(ctx, resources);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({ name: 'remember', arguments: { content: 'hello' } });

    expect(result.structuredContent).toEqual({ results: candidates });

    await client.close();
    await server.close();
  });

  it('does not envelope a remember error result — isError stays as-is', async () => {
    const { buildMcpServer } = await import('./mcp-server.js');
    const ctx = {} as ToolContext;
    const resources = { handle: vi.fn() } as unknown as ResourceHandler;
    handleToolMock.mockResolvedValue({ error: { code: 'INVALID_INPUT', message: 'bad', retryable: false } });

    const server = buildMcpServer(ctx, resources);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({ name: 'remember', arguments: { content: 'hello' } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();

    await client.close();
    await server.close();
  });

  it('lists both MCP prompts and serves prompts/get (task 4.1/4.2)', async () => {
    const { buildMcpServer } = await import('./mcp-server.js');
    const ctx = {} as ToolContext;
    const handle = vi.fn(async () => ({ content: 'inject block' }));
    const resources = { handle } as unknown as ResourceHandler;

    const server = buildMcpServer(ctx, resources);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const list = await client.listPrompts();
    expect(list.prompts.map(p => p.name).sort()).toEqual(['bootstrap-interview', 'session-context']);

    const got = await client.getPrompt({ name: 'session-context', arguments: {} });
    expect(JSON.stringify(got.messages)).toContain('inject block');

    await client.close();
    await server.close();
  });

  it('declares resources.listChanged and prompts capabilities (task 1.2)', async () => {
    const { buildMcpServer } = await import('./mcp-server.js');
    const ctx = {} as ToolContext;
    const resources = { handle: vi.fn() } as unknown as ResourceHandler;

    const server = buildMcpServer(ctx, resources);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    expect(server.getClientCapabilities).toBeDefined();
    expect(client.getServerCapabilities()).toMatchObject({
      resources: { listChanged: true },
      prompts: {},
    });

    await client.close();
    await server.close();
  });

  it('reports serverInfo.version equal to package.json version (task 1.1)', async () => {
    const { buildMcpServer, MCP_SERVER_VERSION } = await import('./mcp-server.js');
    const { PACKAGE_VERSION } = await import('../version.js');
    const ctx = {} as ToolContext;
    const resources = { handle: vi.fn() } as unknown as ResourceHandler;

    const server = buildMcpServer(ctx, resources);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    expect(MCP_SERVER_VERSION).toBe(PACKAGE_VERSION);
    expect(client.getServerVersion()?.version).toBe(PACKAGE_VERSION);

    await client.close();
    await server.close();
  });
});
