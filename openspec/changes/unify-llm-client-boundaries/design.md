## Context

Embedding and six chat features each construct provider URLs, secret lookup, fetch deadlines, status handling, breaker calls, and response parsing independently. Only the embedding request helper currently classifies statuses and retries, while its timeout ends before body consumption. See `proposal.md` and `specs/outbound-ai-request-policy/spec.md`.

## Goals / Non-Goals

**Goals:**
- Centralize transport policy while preserving feature-specific request and response schemas.
- Keep deadline, classification, breaker, retry, and telemetry semantics uniform.
- Support validated OpenAI-compatible endpoints and existing secret fallback behavior.

**Non-Goals:**
- Replacing feature prompts or model choices.
- Adding a general provider abstraction beyond the existing OpenAI-compatible and Azure embedding shapes.

## Decisions

1. Create a low-level request executor that owns the complete attempt lifecycle.
- The breaker closure includes fetch, body read, HTTP classification, JSON parsing, and a caller-provided response validator; the abort timer clears only in `finally` after all work.
- Wrapping bare fetch was rejected because HTTP errors resolve successfully and reset breaker failures.

2. Keep feature adapters responsible for payloads and typed schemas.
- Extraction, rerank, summarization, expansion, entailment, and distillation pass endpoint suffix, body, and validator to the shared executor.
- One monolithic chat service with feature switches was rejected because prompt/schema ownership would become coupled.

3. Resolve endpoint and credentials once through validated configuration helpers.
- A shared LLM base URL defaults to OpenAI; Azure embedding retains its derived endpoint. Feature-specific secret names fall back to `OPENAI_API_KEY` where documented.
- Seven literal URLs and feature-local fallback rules were rejected as drift-prone.

4. Retry only classified transient failures.
- Retry policy handles 408, 429, selected 5xx, network errors, and timeouts; it honors `Retry-After` and uses capped full jitter. Other 4xx responses return immediately as non-retryable.
- Retrying every failure was rejected because invalid credentials and payloads cannot self-heal.

5. Validate embedding cardinality and dimensions before returning ordered vectors.
- The provider's `max_batch_inputs` is applied in the adapter, which reassembles validated batches in input order.
- Trusting array casts was rejected because short responses can silently misassociate vectors.

6. Preserve original classified errors at feature boundaries.
- Semantic search and fail-open features log/meter the original code and retryability before returning their contract-specific degraded result.
- Replacing all errors with a generic retryable embedding error was rejected.

## Risks / Trade-offs

- [Shared transport changes six features at once] -> Migrate one adapter at a time behind contract tests and keep old helpers until parity is proven.
- [Retries increase latency] -> Cap attempts and elapsed delay inside the existing feature deadline.
- [Custom gateways vary in response details] -> Keep strict minimum schemas with clear invalid-provider-response errors.

## Migration Plan

1. Add shared config, credential resolver, status classifier, retry parser, and request executor with focused tests.
2. Migrate entailment and distillation first to close their missing safeguards.
3. Migrate rerank, extraction, query expansion, and summarization.
4. Move embedding body handling/batching onto the same policy primitives without changing Azure endpoint derivation.
5. Remove duplicated helpers and literal provider URLs after parity tests pass.
