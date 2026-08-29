import { describe, it, expect, vi } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MCP_PROMPT_DEFINITIONS, handleGetPrompt } from './index.js';
import { TOTAL_SECTIONS, BOOTSTRAP_SECTIONS } from '../bootstrap/sections.js';
import type { ResourceHandler } from '../resources/index.js';

function mockResources(handle: ReturnType<typeof vi.fn>): ResourceHandler {
  return { handle } as unknown as ResourceHandler;
}

describe('MCP_PROMPT_DEFINITIONS', () => {
  it('declares exactly bootstrap-interview and session-context', () => {
    const names = MCP_PROMPT_DEFINITIONS.map(p => p.name).sort();
    expect(names).toEqual(['bootstrap-interview', 'session-context']);
  });
});

describe('handleGetPrompt: bootstrap-interview', () => {
  it('returns an overview of all sections when no section argument is given', async () => {
    const result = await handleGetPrompt(mockResources(vi.fn()), 'bootstrap-interview', undefined);

    expect(result.messages).toHaveLength(1);
    const text = result.messages[0]!.content as { type: 'text'; text: string };
    expect(text.type).toBe('text');
    for (const section of BOOTSTRAP_SECTIONS) {
      expect(text.text).toContain(section.title);
    }
    expect(text.text).toContain('bootstrap');
  });

  it('returns the specific section questions when a valid section is given', async () => {
    const result = await handleGetPrompt(mockResources(vi.fn()), 'bootstrap-interview', { section: '2' });

    const text = result.messages[0]!.content as { type: 'text'; text: string };
    const section2 = BOOTSTRAP_SECTIONS.find(s => s.section === 2)!;
    expect(text.text).toContain(section2.title);
    for (const q of section2.questions) {
      expect(text.text).toContain(q);
    }
  });

  it('rejects an out-of-range section as InvalidParams', async () => {
    await expect(
      handleGetPrompt(mockResources(vi.fn()), 'bootstrap-interview', { section: String(TOTAL_SECTIONS + 1) }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects a non-integer section as InvalidParams', async () => {
    await expect(
      handleGetPrompt(mockResources(vi.fn()), 'bootstrap-interview', { section: 'not-a-number' }),
    ).rejects.toBeInstanceOf(McpError);
  });
});

describe('handleGetPrompt: session-context', () => {
  it('returns the memory://inject block with no hint', async () => {
    const handle = vi.fn(async () => ({ content: 'block content', truncated: false }));
    const result = await handleGetPrompt(mockResources(handle), 'session-context', undefined);

    expect(handle).toHaveBeenCalledWith('memory://inject');
    const text = result.messages[0]!.content as { type: 'text'; text: string };
    expect(text.text).toContain('block content');
  });

  it('returns the memory://inject/{hint} block when a hint is given', async () => {
    const handle = vi.fn(async () => ({ content: 'hinted block', truncated: false }));
    const result = await handleGetPrompt(mockResources(handle), 'session-context', { hint: 'auth service' });

    expect(handle).toHaveBeenCalledWith('memory://inject/auth%20service');
    const text = result.messages[0]!.content as { type: 'text'; text: string };
    expect(text.text).toContain('hinted block');
  });
});

describe('handleGetPrompt: unknown prompt', () => {
  it('rejects an unknown prompt name as InvalidParams', async () => {
    await expect(
      handleGetPrompt(mockResources(vi.fn()), 'does-not-exist', undefined),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});
