## Context

The v1 specification requires interoperability across Claude CLI and at least one additional MCP client. This depends on strict tool contracts, predictable error responses, and a deterministic session-start inject resource.

## Goals / Non-Goals

**Goals:**
- Define and implement strict validation wrappers for every v1 tool.
- Standardize output payloads and error envelope behavior across all tool handlers.
- Implement resource handlers including `memory://inject` with explicit budget truncation.
- Implement hybrid search ranking strategy with configurable semantic/fulltext weights.

**Non-Goals:**
- Auth transport and rate-limiting internals.
- Low-level storage migration design.
- UI concerns for non-MCP clients.

## Decisions

1. Central schema registry for tool validation.
Rationale: A single registry ensures uniform validation options (`additionalProperties: false`, bounds, enums) and avoids per-handler drift.
Alternative considered: Inline validation per handler. Rejected due to duplication and higher inconsistency risk.

2. Shared error factory for MCP envelope responses.
Rationale: Standardized `{ error: { code, message, retryable } }` responses are required across handlers and simplify client parsing.
Alternative considered: Handler-specific error formatting. Rejected because it breaks cross-client consistency.

3. Deterministic inject payload assembly pipeline.
Rationale: Ordered composition (categories first, then relevant memories, then truncation) is required for repeatability and tests.
Alternative considered: Opportunistic ranking-only inject. Rejected because it can omit always-required category context.

4. Reciprocal Rank Fusion for hybrid search.
Rationale: RRF combines semantic and fulltext result strengths without requiring score normalization assumptions.
Alternative considered: Linear weighted score summation. Rejected due to unstable calibration between different scoring spaces.

## Risks / Trade-offs

- [Schema strictness causes client breakage] -> Mitigate with clear validation messages and examples for required payload shape.
- [Inject payload truncation loses important detail] -> Mitigate with fixed ordering, summary fallback, and `truncated` metadata.
- [Hybrid ranking surprises users] -> Mitigate with mode override options and configurable default weights.
- [Tool contract sprawl] -> Mitigate with shared validator/error abstractions and contract tests per tool.
