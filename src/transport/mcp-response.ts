/** MCP CallTool response shaping, extracted so it can be unit-tested directly. */

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
  structuredContent?: Record<string, unknown>;
  // Index signature so the result is assignable to the MCP SDK's permissive
  // CallTool result union (which expects `[x: string]: unknown`).
  [key: string]: unknown;
}

export function isErrorEnvelope(value: unknown): value is { error: unknown } {
  return value != null && typeof value === 'object' && 'error' in value;
}

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
