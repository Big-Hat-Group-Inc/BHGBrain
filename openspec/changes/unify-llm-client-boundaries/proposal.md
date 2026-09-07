## Why

The repository has several independent OpenAI-compatible clients with inconsistent timeouts, base URLs, credentials, retries, status classification, breaker placement, and response handling. The divergence silently disables features and lets HTTP failures count as breaker successes.

## What Changes

- Introduce one shared OpenAI-compatible chat request boundary with configurable base URL, credential resolution, deadline coverage through body consumption, status classification, retry policy, and circuit-breaker integration.
- Migrate extraction, reranking, summarization, query expansion, entailment, and distillation to the shared client.
- Give entailment breaker/metric coverage and distillation an explicit timeout.
- Preserve classified embedding errors in semantic search and keep embedding deadlines active through response validation.
- Honor batching limits, `Retry-After`, capped jittered backoff, and validate provider response dimensions/counts.

## Capabilities

### New Capabilities
- `outbound-ai-request-policy`: Defines uniform configuration, authentication, deadlines, retries, error classification, breaker semantics, metrics, and validation for AI-provider calls.

### Modified Capabilities

## Impact

- Affected code: `src/embedding/`, `src/pipeline/`, `src/search/`, `src/rerank/`, `src/summarization/`, `src/resilience/`, configuration, health, and provider tests.
- Audit coverage: F31-F34, F38, F48, F60, F70, and F89.
- Configuration: adds a shared OpenAI-compatible base URL and fills feature-specific timeout/retry gaps.
