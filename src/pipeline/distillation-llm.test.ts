import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DistillationLLMClient, DistillationLLMError } from './distillation-llm.js';
import type { BrainConfig } from '../config/index.js';

function config(): BrainConfig {
  return {
    pipeline: {
      extraction_model: 'gpt-4o-mini',
      extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
    },
  } as unknown as BrainConfig;
}

const MEMORIES = [
  { content: 'We deployed via GitHub Actions.', updated_at: '2026-01-01T00:00:00.000Z' },
  { content: 'CI switched to GitHub Actions.', updated_at: '2026-01-02T00:00:00.000Z' },
  { content: 'Actions runner pinned to node20.', updated_at: '2026-01-03T00:00:00.000Z' },
];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('DistillationLLMClient', () => {
  let originalKey: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalKey = process.env.BHGBRAIN_EXTRACTION_API_KEY;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    } else {
      process.env.BHGBRAIN_EXTRACTION_API_KEY = originalKey;
    }
    global.fetch = originalFetch;
  });

  it('succeeds and truncates an oversized summary', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    const longSummary = 'x'.repeat(200);
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify({ content: 'We deploy via GitHub Actions.', summary: longSummary }) } }],
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new DistillationLLMClient(config());
    const result = await client.distill(MEMORIES);

    expect(result.content).toBe('We deploy via GitHub Actions.');
    expect(result.summary.length).toBe(120);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' });
  });

  it('skips with reason no_key and makes no network call when the key is missing', async () => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new DistillationLLMClient(config());
    await expect(client.distill(MEMORIES)).rejects.toMatchObject({ reason: 'no_key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a non-2xx response as reason llm_error', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    global.fetch = vi.fn(async () => jsonResponse({ error: 'boom' }, false, 500)) as unknown as typeof fetch;

    const client = new DistillationLLMClient(config());
    const err = await client.distill(MEMORIES).catch(e => e);
    expect(err).toBeInstanceOf(DistillationLLMError);
    expect(err.reason).toBe('llm_error');
  });

  it('surfaces malformed JSON content as reason llm_error', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    global.fetch = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'not json at all {' } }],
    })) as unknown as typeof fetch;

    const client = new DistillationLLMClient(config());
    await expect(client.distill(MEMORIES)).rejects.toMatchObject({ reason: 'llm_error' });
  });

  it('surfaces a response missing required fields as reason llm_error', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    global.fetch = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify({ content: 'only content, no summary' }) } }],
    })) as unknown as typeof fetch;

    const client = new DistillationLLMClient(config());
    await expect(client.distill(MEMORIES)).rejects.toMatchObject({ reason: 'llm_error' });
  });
});
