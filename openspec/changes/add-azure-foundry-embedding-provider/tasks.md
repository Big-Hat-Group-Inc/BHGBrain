## 1. Configuration and provider selection

- [x] 1.1 Extend `src/config/index.ts` to support `embedding.provider = "azure-foundry"`, Azure-specific config, timeout/retry/batch settings, and model-aware validation rules.
- [x] 1.2 Update the embedding factory to construct `AzureFoundryEmbeddingProvider`, degrade only for missing startup credentials, and expose a provider-aware embedding breaker-key helper.

## 2. Azure provider runtime behavior

- [x] 2.1 Implement `src/embedding/azure-foundry.ts` with resource-name-driven base URL construction, Azure `api-key` authentication, deployment-name request semantics, and model-aware `dimensions` handling.
- [x] 2.2 Implement batch chunking, timeout control, retryable-failure backoff, ordered response assembly, and sanitized Azure error mapping in the Azure embedding provider.
- [x] 2.3 Ensure missing startup credentials degrade provider construction, invalid static config fails fast, runtime Azure failures remain normal provider errors, and `healthCheck()` performs a real authenticated probe that returns a boolean result.

## 3. Provider-aware health and entrypoint wiring

- [x] 3.1 Update `src/index.ts` and `src/cli/index.ts` to use the provider-aware embedding breaker key without changing the existing health payload shape.
- [x] 3.2 Preserve existing embedding health-cache behavior and ensure embedding health probes bypass the circuit breaker for both OpenAI and Azure providers.

## 4. Tests and documentation

- [x] 4.1 Add Azure embedding unit coverage for config validation, base URL construction, auth headers, dimensions handling, batch chunking, timeout/retry behavior, error mapping, degraded startup, and provider-aware breaker keys.
- [x] 4.2 Add integration or regression coverage confirming provider-aware health reporting and unchanged MCP tool, resource, and error-envelope behavior when switching providers.
- [x] 4.3 Update `README.md` upgrade and operator guidance for Azure configuration, deployment-name semantics, compatibility rules, secret rotation, canary rollout, and rollback.

## 5. Validation

- [x] 5.1 Run `npm run lint` to confirm type-safe Azure provider wiring.
- [x] 5.2 Run `npm test` to verify unit and regression coverage for Azure provider behavior.
- [x] 5.3 Run `npm run build` to confirm the OpenSpec-backed implementation remains buildable end to end.
