## 1. Shared Request Policy

- [ ] 1.1 Add validated shared OpenAI-compatible base URL, timeout, retry, and maximum-backoff configuration and verify default and custom endpoint parsing.
- [ ] 1.2 Implement one credential resolver with the documented feature-secret to `OPENAI_API_KEY` fallback and verify all enabled features resolve identical inputs consistently.
- [ ] 1.3 Implement shared HTTP status classification, `Retry-After` parsing, capped full-jitter backoff, and retryability-preserving errors; verify 401, 408, 429, and 5xx cases.
- [ ] 1.4 Implement the complete request-attempt executor with abort coverage through body parsing/validation inside breaker execution and verify a post-header stall aborts and trips the breaker.

## 2. Feature Migration

- [ ] 2.1 Migrate entailment to the shared client with breaker and metrics and verify fail-open behavior retains cause telemetry.
- [ ] 2.2 Migrate distillation with an explicit timeout and verify a hung request cannot block all later scheduled runs.
- [ ] 2.3 Migrate extraction, reranking, query expansion, and summarization while retaining their feature schemas/fallbacks; verify existing behavior tests plus HTTP-error breaker tests.
- [ ] 2.4 Move embedding response body handling under the full deadline and preserve classified errors through semantic search; verify 401 remains non-retryable and body timeout is bounded.
- [ ] 2.5 Enforce `max_batch_inputs`, input/result cardinality, and vector dimensions for OpenAI and Azure embeddings and verify ordered multi-batch results and malformed-response rejection.

## 3. Cleanup and Validation

- [ ] 3.1 Remove duplicated base URLs, secret helpers, truncation helpers, and status handling after migrations and verify repository search finds only the shared boundary definitions.
- [ ] 3.2 Add health/startup diagnostics for enabled features missing usable credentials or endpoints and verify contradiction detection no longer fails silently per write.
- [ ] 3.3 Update configuration/README examples and run all provider, pipeline, search, rerank, summarization, and breaker tests plus `npm run lint`, `npm test`, and `npm run build`.
