## Context

`AzureFoundrySpec.md` defines an internal embedding-provider expansion for BHGBrain: keep the existing MCP contract intact while allowing embeddings to run against Azure OpenAI-compatible `openai/v1` endpoints. The current system already centers the embedding subsystem around a provider factory, a degraded provider for missing startup credentials, circuit breaker integration, shared health reporting, and metrics collection.

This change crosses configuration, embedding runtime behavior, server/CLI startup wiring, health reporting, documentation, and tests. It also carries external integration constraints: the supported Azure endpoint is resource-name-driven, authentication is API-key based, and operators need conservative migration guidance because embedding spaces are not guaranteed to be interchangeable across providers.

## Goals / Non-Goals

**Goals:**
- Add `azure-foundry` as a second internal embedding provider without changing MCP tools, resources, or response-envelope contracts.
- Validate Azure configuration strictly at startup, including resource naming, model-aware dimensions, and batch-size bounds.
- Preserve degraded startup behavior for missing startup credentials while failing fast on invalid static Azure configuration.
- Define consistent Azure request behavior for auth headers, request body shape, chunking, timeout handling, retry behavior, and sanitized error mapping.
- Make breaker wiring and health reporting provider-aware across both server and CLI entrypoints.
- Document migration, compatibility, credential handling, and rollback expectations for operators.

**Non-Goals:**
- Entra ID or token-based Azure authentication.
- Support for alternate endpoint families such as deployment-scoped URLs or `services.ai.azure.com`.
- Marketplace, Cohere, or multimodal embedding providers.
- Hot credential rotation without restart or reload.
- Client-side token counting, truncation, or migration to the `openai` npm SDK.
- A broad refactor that forces OpenAI and Azure providers to share an extracted helper in this change.

## Decisions

1. Keep Azure support as an internal provider swap, not an MCP surface change.
- Decision: provider selection remains behind the existing embedding abstraction and does not alter tool schemas, resource shapes, or transport contracts.
- Rationale: the specification is explicit that Azure support is infrastructure-level behavior, not a protocol feature.
- Alternative considered: exposing provider-specific MCP settings or tools. Rejected because it would broaden the change far beyond embedding integration.

2. Use resource-name-driven endpoint construction with API-key authentication.
- Decision: Azure configuration supplies `embedding.azure.resource_name`, which is converted into `https://<resource>.openai.azure.com/openai/v1`, and requests authenticate with the `api-key` header.
- Rationale: this matches the supported Azure OpenAI-compatible v1 path, keeps validation simple, and avoids arbitrary URL drift.
- Alternative considered: allowing arbitrary base URLs or bearer-token auth. Rejected because the spec intentionally narrows scope to the documented Azure embeddings path.

3. Separate invalid static config, missing startup secret, and runtime outage behavior.
- Decision: invalid Azure config fails startup, a missing Azure API key at startup degrades to `DegradedEmbeddingProvider`, and runtime Azure failures remain provider errors managed through retry and the circuit breaker.
- Rationale: each failure class has different operator meaning, and the system already uses degraded mode for missing startup credentials.
- Alternative considered: degrading on every constructor or runtime error. Rejected because it would hide real configuration bugs and conflate startup/operator problems with transient outages.

4. Make the provider responsible for Azure-specific request execution.
- Decision: the Azure provider owns request-body construction, dimensions inclusion/omission, batch chunking, `AbortController` timeout handling, exponential-backoff retries, response ordering, and sanitized error mapping.
- Rationale: Azure's 2048-input limit, deployment-name semantics, and retry/error behavior are provider concerns and should not leak into callers.
- Alternative considered: pushing chunking or retry logic upward into the pipeline or a shared transport helper. Rejected because it would couple provider constraints to unrelated layers.

5. Make health and breaker reporting provider-aware through a shared key helper.
- Decision: the active embedding breaker key is derived from provider selection and used consistently by server startup, CLI startup, and health reporting, while health probes still bypass the breaker and rely on the existing cache behavior.
- Rationale: the health payload should stay stable while reporting the correct active breaker identity.
- Alternative considered: continuing to hardcode `openai_embedding`. Rejected because it misreports runtime state when Azure is the active provider.

6. Treat migration guidance as compatibility-sensitive, not transparent.
- Decision: documentation and tasks explicitly call out deployment-name semantics, collection compatibility rules, canary migration, and rollback behavior.
- Rationale: matching dimensions alone is insufficient proof of interchangeable embeddings across providers.
- Alternative considered: documenting provider switches as drop-in. Rejected because it would overstate retrieval compatibility and create operator risk.

## Risks / Trade-offs

- [Azure rate limits and regional quotas vary more than direct OpenAI defaults] -> Mitigation: keep timeout, retry, and batch-size settings configurable with conservative defaults.
- [Embedding spaces may differ across providers even when the model family and dimensions appear similar] -> Mitigation: require migration guidance to recommend canary validation and reindexing when compatibility is uncertain.
- [Maintaining OpenAI-compatible logic in separate provider implementations can drift over time] -> Mitigation: keep shared expectations explicit in specs and leave helper extraction as a focused follow-up change.
- [Real health probes depend on upstream availability and credentials] -> Mitigation: preserve the 30-second health cache and document probe behavior clearly for operators.

## Migration Plan

1. Extend the embedding configuration schema and provider factory to accept `embedding.provider = "azure-foundry"` and Azure-specific config.
2. Implement Azure provider request behavior and provider-aware breaker-key wiring for server and CLI entrypoints.
3. Add unit, integration, and regression coverage for config validation, request execution, degraded startup, and provider-aware health reporting.
4. Update documentation to cover Azure configuration, credential rotation, compatibility rules, canary rollout, and rollback.
5. Operators migrate by switching configuration, restarting BHGBrain, validating retrieval quality in a canary namespace or collection, and rolling back by restoring the previous OpenAI configuration if needed.

## Open Questions

- Should a later refactor extract shared OpenAI-compatible request helpers so `OpenAIEmbeddingProvider` and `AzureFoundryEmbeddingProvider` cannot drift on dimensions, retry, and error mapping behavior?
