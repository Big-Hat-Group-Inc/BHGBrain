/** MCP CallTool response shaping, extracted so it can be unit-tested directly. */

import { isErrorEnvelope } from '../errors/index.js';

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
  structuredContent?: Record<string, unknown>;
  // Index signature so the result is assignable to the MCP SDK's permissive
  // CallTool result union (which expects `[x: string]: unknown`).
  [key: string]: unknown;
}

// Re-exported so existing callers importing isErrorEnvelope from this module
// keep working — the actual (strict) definition now lives in
// src/errors/index.ts, shared with the REST and CLI adapters
// (align-runtime-entrypoint-contracts task 2.2; design.md decision 3:
// "Key-presence-only predicates ... were rejected" — this module's own prior
// `'error' in value` check was exactly that anti-pattern).
export { isErrorEnvelope };

/**
 * Builds the MCP CallTool response from a tool handler result. Successful,
 * object-shaped results are delivered via the MCP `structuredContent` field in
 * addition to the JSON text block (retained for clients that do not read
 * structuredContent). Error envelopes set `isError` and are not echoed into
 * structuredContent.
 */
export function buildToolCallResponse(result: unknown): McpToolResponse {
  const isError = isErrorEnvelope(result);
  const response: McpToolResponse = {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    ...(isError ? { isError: true } : {}),
  };
  if (!isError && result !== null && typeof result === 'object' && !Array.isArray(result)) {
    response.structuredContent = result as Record<string, unknown>;
  }
  return response;
}
