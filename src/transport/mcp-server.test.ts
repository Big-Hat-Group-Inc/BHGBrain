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
});
