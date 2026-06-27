import { describe, it, expect } from 'vitest';
import { buildToolCallResponse } from './mcp-response.js';

describe('buildToolCallResponse', () => {
  it('delivers a successful object result via structuredContent and a text block', () => {
    const result = { ok: true, results: [{ id: 'a' }], degraded: false };
    const res = buildToolCallResponse(result);
    expect(res.structuredContent).toEqual(result);
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.type).toBe('text');
    expect(JSON.parse(res.content[0]!.text)).toEqual(result);
  });

  it('sets isError and omits structuredContent for an error envelope', () => {
    const envelope = { error: { code: 'INVALID_INPUT', message: 'bad', retryable: false } };
    const res = buildToolCallResponse(envelope);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    // Text block is still present so all clients receive the payload.
    expect(JSON.parse(res.content[0]!.text)).toEqual(envelope);
  });

  it('does not attach structuredContent for a non-object (array) result', () => {
    const res = buildToolCallResponse([{ id: 'a' }, { id: 'b' }]);
    expect(res.structuredContent).toBeUndefined();
    expect(res.isError).toBeUndefined();
    expect(Array.isArray(JSON.parse(res.content[0]!.text))).toBe(true);
  });
});
