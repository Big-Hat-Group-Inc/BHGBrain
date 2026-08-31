## Why

BHGBrain currently relies on the direct OpenAI embeddings API, which prevents operators from using Azure-hosted embeddings for compliance, residency, network isolation, and centralized billing needs. The Azure Foundry specification also exposes several provider-level contracts that need to be made explicit, especially around startup validation, degraded mode, timeout/retry behavior, and provider-aware health reporting.

## What Changes

- Add a second embedding provider, `azure-foundry`, behind the existing embedding interface with no MCP tool, resource, or protocol changes.
- Extend embedding configuration to support Azure-specific settings, including resource-based endpoint construction, Azure API key lookup, batch size, timeout, retry, and model-aware dimensions validation.
- Define Azure request behavior for authentication, request-body construction, chunking, timeout handling, retryable failures, and sanitized error mapping.
- Preserve current degraded startup ergonomics for missing startup credentials while requiring invalid static Azure configuration to fail fast.
- Make embedding circuit breaker reporting provider-aware so HTTP and CLI health surfaces use the correct breaker key for the active provider.
- Add unit, integration, regression, and documentation coverage for Azure configuration, runtime behavior, migration guidance, and operator expectations.

## Capabilities

### New Capabilities
- `azure-foundry-embedding-provider`: supports Azure OpenAI-compatible embeddings with Azure-specific config validation, request execution, degraded startup handling, and migration-safe runtime behavior.
- `provider-aware-embedding-health`: reports embedding health and circuit breaker state using provider-aware semantics while preserving the existing health payload shape.

### Modified Capabilities

## Impact

- Affected code: `src/config/index.ts`, `src/embedding/azure-foundry.ts`, `src/embedding/index.ts`, `src/index.ts`, `src/cli/index.ts`, `src/health/index.ts`, and Azure embedding tests.
- Affected documentation: `README.md` and operator/upgrade guidance describing Azure configuration, credential handling, compatibility, and rollback expectations.
- External systems: outbound HTTPS calls to Azure OpenAI-compatible `openai/v1` embeddings endpoints using Azure API key authentication.
- MCP/API impact: none; existing tools, resources, and response envelopes remain unchanged.
