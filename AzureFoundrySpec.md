# Azure AI Foundry / Azure OpenAI-Compatible Embedding Provider - Application Specification

**Status:** Complete (revised after architecture, Azure, and MCP review, updated post-implementation feedback)
**Date:** 2026-03-22
**Component:** `src/embedding/`
**Affects:** config schema, embedding provider, shared OpenAI-compatible request behavior, health checks, documentation, tests
**MCP surface:** No new MCP tools, resources, or protocol shape changes

---

## 1. Purpose and Scope

BHGBrain currently supports one embedding provider: the direct OpenAI API at `https://api.openai.com/v1`. Some operators need Azure-hosted inference for compliance, data residency, network isolation, procurement, or centralized billing. This specification adds a second embedding provider named `azure-foundry` that targets the Azure OpenAI-compatible `openai/v1` embeddings endpoint exposed by Azure AI Foundry / Azure OpenAI resources.

This is an **internal provider change**, not an MCP protocol feature. Existing `remember`, `recall`, and search-related behavior should continue to work through the same tool and resource interfaces. The only intended product-level change is that embedding-backed operations can run against Azure-hosted embeddings when `embedding.provider = "azure-foundry"`.

This spec also tightens several areas that the Azure provider makes impossible to ignore: startup validation, request timeout behavior, retry behavior, secret handling, health reporting, migration guidance, and breaker naming consistency.

---

## 2. Terminology and Azure Background

### 2.1 Terminology Used in This Spec

To avoid confusion between Microsoft marketing names and implementation details, this document uses the following terminology consistently:

- **Azure AI Foundry**: the broader Microsoft platform and portal experience.
- **Azure OpenAI-compatible v1 endpoint**: the HTTP API surface used by this provider.
- **Resource**: the Azure resource that exposes the endpoint.
- **Deployment**: the named model deployment used in the `model` request field.
- **`azure-foundry`**: the BHGBrain configuration value for this provider. This is an internal product/config name, not the canonical Microsoft service name.

The implementation should prefer the terms **Azure AI Foundry** and **Azure OpenAI-compatible v1 endpoint** in documentation. Avoid treating `azure-foundry` as the formal service name.

### 2.2 Supported Endpoint Shape

The implementation defined by this spec supports exactly one configured base URL shape:

```text
https://<resource>.openai.azure.com/openai/v1
```

Embedding requests are sent to:

```text
POST https://<resource>.openai.azure.com/openai/v1/embeddings
```

This is the supported implementation path because it:

- aligns with Microsoft's current OpenAI-compatible v1 guidance,
- avoids dated `api-version` query parameters,
- maps cleanly onto BHGBrain's existing `fetch()`-based embedding provider shape,
- reduces configuration complexity for operators.

The following are **documented for context but out of scope for implementation in this change**:

- deployment-scoped endpoints such as `.../openai/deployments/<deployment>/embeddings?api-version=...`,
- configuring `services.ai.azure.com` as the primary base domain,
- the deprecated Azure AI Inference beta SDK surface.

If Microsoft documentation continues to show alternate domains that are accepted by some clients, BHGBrain should still standardize on `openai.azure.com` in this implementation to keep validation, error handling, and operator docs simple.

### 2.3 Authentication

Microsoft's broader Azure OpenAI v1 documentation describes both API key and token-based patterns, but the Azure embeddings how-to currently documents **API key authentication** for embeddings. This spec therefore treats API key authentication as the supported implementation for this embedding provider.

For raw `fetch()` calls, the provider should send:

```http
api-key: <key>
Content-Type: application/json
```

Important implementation and security decisions:

- The Azure API key is loaded **once during provider construction** and cached in memory, matching the current `OpenAIEmbeddingProvider` pattern.
- Missing credentials at startup should trigger degraded mode, not a later call-time surprise.
- Key rotation requires a process restart or explicit configuration reload. This spec does not add hot credential reload.
- The key, request headers, and full upstream error bodies must never be logged verbatim.

### 2.4 Deployment Semantics

Azure requests use the **deployment name** in the `model` field. Operators must not assume that the deployment name always matches the public model family name.

Examples:

- Deployment name: `text-embedding-3-small`
- Deployment name: `embeddings-prod`
- Underlying model family: `text-embedding-3-small`

The provider should treat `config.embedding.model` as the deployment identifier sent to Azure. Documentation should explicitly call this out because many runtime `400` and `404` issues are caused by confusing model family names with deployment names.

### 2.5 Embedding Models in Scope

This spec covers Azure OpenAI-compatible embedding deployments only.

| Deployment family | Native dimensions | Supports `dimensions` request field | Notes |
|---|---:|---|---|
| `text-embedding-3-small` | 1536 | Yes | Recommended default. Good quality/storage balance. |
| `text-embedding-3-large` | 3072 | Yes | Higher quality, higher storage unless reduced. |
| `text-embedding-ada-002` | 1536 | No | Legacy; fixed-size output. |

The following are **not** in scope for this provider even if they are available somewhere in Azure AI Foundry:

- Cohere / marketplace embedding models,
- multimodal embedding endpoints,
- endpoints that require different request bodies or fields such as `input_type`.

### 2.6 Limits and Operational Constraints

Azure's documented embedding constraints currently include:

- maximum **2048 inputs** per embedding request,
- maximum **8192 tokens** per input for current OpenAI embedding models,
- deployment- and region-specific quota / tokens-per-minute limits.

Implementation requirements for BHGBrain:

- The provider must **chunk oversized input batches** according to a configurable maximum, defaulting to `2048`.
- This change does **not** add client-side tokenization. Oversize individual inputs may still be rejected by Azure and should surface as a sanitized provider error.
- This document intentionally does **not** hardcode Azure pricing because pricing changes by region, SKU, and commercial agreement. Operator docs should point to live Azure pricing sources instead.

---

## 3. MCP and System Architecture Impact

This change does **not** alter BHGBrain's MCP contract.

Specifically:

- No new MCP tools are introduced.
- No existing tool argument schemas change.
- No new MCP resources or resource templates are introduced.
- No MCP session or thread mapping behavior changes.
- No namespace, collection, or memory semantics change.

The provider sits entirely behind the existing storage / write-pipeline / search layers. The new trust boundary is an outbound HTTPS call to Azure, but that does not create a new MCP-facing protocol concern.

Error handling should continue to use the existing `BrainError` / envelope model rather than introducing provider-specific response envelopes.

---

## 4. Current BHGBrain Baseline (Must Stay Accurate)

The draft implementation spec must remain anchored to the repository's current behavior:

- `OpenAIEmbeddingProvider` currently uses raw `fetch()`.
- It caches the API key during construction rather than re-reading `process.env` on every request.
- `embedBatch()` records the `embedding_embed_batch_ms` histogram.
- `healthCheck()` performs a real authenticated embedding call and returns `true` / `false`.
- `createEmbeddingProvider()` currently degrades when credentials are unavailable at startup.
- `HealthService` caches embedding health for 30 seconds.
- `src/index.ts` and `src/cli/index.ts` currently hardcode `openai_embedding` in the breaker map.

This Azure provider should align with those patterns unless the spec explicitly changes them. The spec should **not** claim that Azure request handling is identical to current OpenAI behavior when that is not true. In particular, the current OpenAI provider does not yet send a `dimensions` field in the request body.

---

## 5. Design Goals and Non-Goals

### 5.1 Goals

- Add a second embedding provider with minimal disruption to the rest of the system.
- Preserve MCP-facing behavior and wire contracts.
- Fail fast on invalid static configuration.
- Degrade only for missing startup credentials, preserving current operator ergonomics.
- Avoid leaking credentials or sensitive upstream response data.
- Support explicit request timeout, retry, and batch chunking behavior.
- Provide honest migration guidance instead of overstating cross-provider equivalence.
- Keep HTTP and CLI health reporting consistent.

### 5.2 Non-Goals

This change does **not** include:

- Entra ID authentication for embeddings,
- multi-provider federation or provider-per-collection routing,
- marketplace/Cohere embedding support,
- deployment-scoped endpoint support,
- migration to the `openai` npm package for embeddings,
- client-side token counting or truncation.

---

## 6. Configuration Schema Changes

### 6.1 Proposed Config Shape

```jsonc
{
  "embedding": {
    // Existing providers: "openai" or new provider: "azure-foundry"
    "provider": "azure-foundry",

    // Azure deployment name (sent in the request body as `model`)
    "model": "text-embedding-3-small",

    // Expected vector size stored in Qdrant and returned by the provider
    "dimensions": 1536,

    // Shared OpenAI-compatible provider behavior
    "request_timeout_ms": 30000,
    "max_batch_inputs": 2048,
    "retry": {
      "max_attempts": 3,
      "backoff_ms": 1000
    },

    // Existing OpenAI-only key env var. Ignored when provider = "azure-foundry".
    "api_key_env": "OPENAI_API_KEY",

    "azure": {
      // Resource used to build:
      // https://<resource_name>.openai.azure.com/openai/v1
      "resource_name": "my-foundry-resource",

      // Env var containing the Azure API key
      "api_key_env": "AZURE_FOUNDRY_API_KEY"
    }
  }
}
```

### 6.2 Zod Schema Update

In `src/config/index.ts`, extend the embedding schema and validate the Azure-specific sub-object explicitly.

```typescript
const AzureEmbeddingSchema = z.object({
  resource_name: z.string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'resource_name must contain only lowercase letters, numbers, and hyphens'),
  api_key_env: z.string().default('AZURE_FOUNDRY_API_KEY'),
});

embedding: z.object({
  provider: z.enum(['openai', 'azure-foundry']).default('openai'),
  model: z.string().default('text-embedding-3-small'),
  api_key_env: z.string().default('OPENAI_API_KEY'),
  dimensions: z.number().int().positive().default(1536),
  request_timeout_ms: z.number().int().positive().default(30000),
  max_batch_inputs: z.number().int().min(1).max(2048).default(2048),
  retry: z.object({
    max_attempts: z.number().int().min(1).max(5).default(3),
    backoff_ms: z.number().int().positive().default(1000),
  }).default({}),
  azure: AzureEmbeddingSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.provider === 'azure-foundry' && !value.azure) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'embedding.azure is required when embedding.provider = "azure-foundry"',
      path: ['azure'],
    });
  }

  if (value.provider === 'azure-foundry') {
    if (value.model === 'text-embedding-ada-002' && value.dimensions !== 1536) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'text-embedding-ada-002 requires dimensions = 1536',
        path: ['dimensions'],
      });
    }

    if (value.model === 'text-embedding-3-small' && value.dimensions > 1536) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'text-embedding-3-small supports at most 1536 dimensions',
        path: ['dimensions'],
      });
    }

    if (value.model === 'text-embedding-3-large' && value.dimensions > 3072) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'text-embedding-3-large supports at most 3072 dimensions',
        path: ['dimensions'],
      });
    }
  }
}).default({}),
```

Validation rules:

- `embedding.azure` is required when `provider = "azure-foundry"`.
- `embedding.azure.resource_name` must be DNS-safe and non-empty.
- `embedding.max_batch_inputs` must not exceed `2048`.
- `embedding.dimensions` must be compatible with the selected model family.
- The top-level `embedding.api_key_env` remains the OpenAI-provider field and is ignored for Azure.
- Invalid static configuration is a **startup error**, not a degraded-mode case.

### 6.3 Environment Variables and Secret Handling

| Variable | Required When | Description |
|---|---|---|
| `AZURE_FOUNDRY_API_KEY` | `provider = "azure-foundry"` | Azure API key used for the OpenAI-compatible embeddings endpoint. |

Operational guidance:

- Store the key in a managed secret store such as Azure Key Vault, Kubernetes secrets, or another deployment-time secret injection mechanism.
- Do not commit example values to source control.
- Rotating the key requires restarting or reloading the BHGBrain process because the provider caches credentials at construction.

---

## 7. Implementation Design

### 7.1 New Class: `AzureFoundryEmbeddingProvider`

Create `src/embedding/azure-foundry.ts` implementing the existing `EmbeddingProvider` interface:

```typescript
export class AzureFoundryEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly maxBatchInputs: number;
  private readonly retryMaxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly breaker?: CircuitBreaker;
  private readonly metrics?: MetricsCollector;

  constructor(config: BrainConfig, breaker?: CircuitBreaker, metrics?: MetricsCollector);

  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
}
```

### 7.2 Construction and Startup Behavior

Construction rules are intentionally strict:

- If `provider = "azure-foundry"` and `embedding.azure.resource_name` is invalid or missing, startup should fail.
- If `provider = "azure-foundry"` and the required Azure API key env var is missing, startup should fall back to `DegradedEmbeddingProvider`, matching the current OpenAI-provider ergonomics.
- Runtime HTTP failures do **not** replace the provider instance with degraded mode. They surface as errors and are handled through the circuit breaker.

This distinction matters:

- **Bad static config**: fail fast.
- **Missing startup secret**: degrade.
- **Runtime provider outage**: trip breaker and surface request errors.

### 7.3 Base URL Construction

```typescript
this.baseUrl = `https://${config.embedding.azure!.resource_name}.openai.azure.com/openai/v1`;
```

The spec intentionally does **not** support arbitrary Azure base URLs in this change. Keeping the provider resource-name-driven simplifies validation, docs, and failure diagnosis.

### 7.4 Authentication Header

```typescript
private getAuthHeaders(): Record<string, string> {
  return {
    'api-key': this.apiKey,
    'Content-Type': 'application/json',
  };
}
```

Implementation notes:

- Cache `this.apiKey` in the constructor after reading the configured env var.
- Never include the key value in thrown errors or logs.
- It is acceptable to mention the **env var name** in startup diagnostics because it is not secret.

### 7.5 Request Body and Dimensions Handling

The Azure request body is OpenAI-compatible, but it is **not automatically identical to BHGBrain's current OpenAI provider implementation** because `dimensions` support matters here.

Required request shape:

```json
{
  "model": "<deployment-name>",
  "input": ["text1", "text2"],
  "dimensions": 1536
}
```

Rules:

- Always send `model` as the deployment name from config.
- Always send `input` as an array for batch consistency.
- Send `dimensions` for models that support reduced dimensions.
- Omit `dimensions` for `text-embedding-ada-002`.

Recommended helper:

```typescript
function shouldIncludeDimensions(model: string): boolean {
  return model === 'text-embedding-3-small' || model === 'text-embedding-3-large';
}
```

### 7.6 Shared OpenAI-Compatible Logic

The Azure provider exposes a design gap that already exists in the current OpenAI provider: BHGBrain documents configurable dimensions, but the current OpenAI implementation does not send them upstream.

To avoid long-term divergence, this spec chooses the following path:

- If Azure support is added with model-aware `dimensions` handling, timeout handling, and retry handling, the project should extract or share common OpenAI-compatible request logic between the OpenAI and Azure providers.
- This can be implemented as a base class or a shared helper module.
- If the team decides **not** to refactor OpenAI in the same change, then Azure support must be clearly documented as the first provider to honor reduced-dimension request settings.

A small shared helper is preferable to two slowly diverging providers. The initial implementation of Azure provider does not extract a shared helper, but implements its own request logic; this is acceptable and leaves room for future refactoring.

### 7.7 Request Execution: Chunking, Timeout, and Retry

`embedBatch()` must:

1. Split the input into chunks of `max_batch_inputs`.
2. For each chunk, send a POST request to `/embeddings`.
3. Apply timeout control with `AbortController`.
4. Retry only when the error is plausibly transient.
5. Preserve result ordering across chunks.

Pseudo-shape:

```typescript
for (const chunk of chunkInputs(texts, this.maxBatchInputs)) {
  const response = await this.requestWithRetry(chunk, useBreaker);
  const embeddings = await this.parseEmbeddingsResponse(response);
  results.push(...embeddings);
}
```

Timeout and retry requirements:

- Default timeout: `30000ms`.
- Retryable conditions:
  - network errors,
  - timeout / abort errors,
  - HTTP `429`,
  - HTTP `5xx`.
- Non-retryable conditions:
  - HTTP `400`,
  - HTTP `401`,
  - HTTP `403`,
  - HTTP `404`.
- Retries should use exponential backoff derived from `retry.backoff_ms`: each retry attempt waits `retry.backoff_ms * 2^(attempt-1)` milliseconds, where `attempt` is the retry number starting from 1.
- Maximum retry attempts are controlled by `retry.max_attempts` (default 3).

### 7.8 Response Parsing and Error Mapping

Successful responses should be parsed and sorted by `index`, matching the current provider behavior.

Failure mapping should remain compatible with the existing error model instead of inventing Azure-only error codes:

- `400`, `401`, `403`, `404` → `embeddingUnavailable('Azure embeddings request rejected (HTTP ${status})')`
- `429` → `rateLimited('Azure embeddings rate limited')`
- `5xx` → `embeddingUnavailable('Azure embedding provider error ${status}')`
- Network errors, timeouts → `embeddingUnavailable('Azure embedding provider unreachable')`
- Other 4xx statuses → `embeddingUnavailable('Azure embeddings client error ${status}')`

Security and observability notes:

- Respect `config.security.log_redaction` when logging upstream errors.
- Do not include full upstream bodies in user-facing errors by default.
- If short body snippets are logged for debugging, they must be sanitized and truncated.

### 7.9 Circuit Breaker and Metrics

The Azure provider should mirror the current OpenAI-provider resilience behavior:

- `embed()` and `embedBatch()` go through `breaker.execute()` when a breaker is provided.
- `healthCheck()` bypasses the breaker.
- `embedBatch()` records `embedding_embed_batch_ms` in a `finally` block.

This spec does **not** require adding labeled metrics because the current `MetricsCollector` API does not expose labels in its public methods. If provider-specific metrics become necessary, they can be added later via distinct metric names rather than labels.

### 7.10 Health Check

The provider health check should perform a real authenticated embedding call against a single short string and return `true` / `false` without throwing. This mirrors the existing OpenAI-provider pattern and has an important benefit: invalid credentials are detected by the health probe itself.

No change is required to `HealthService` caching semantics. The existing 30-second embedding health cache remains appropriate and avoids excessive upstream probe traffic.

---

## 8. Degraded Mode and Error Boundaries

The degraded-mode rules should be explicit:

- **Missing Azure API key env var at startup** -> return `DegradedEmbeddingProvider`.
- **Invalid static Azure config** -> throw and fail startup.
- **Runtime HTTP / network failures** -> do not swap providers; surface errors and allow the breaker to manage availability.

This keeps startup diagnostics honest while preserving today's graceful behavior when secrets are absent.

---

## 9. Health Endpoint and Circuit Breaker Key Changes

The health snapshot should report an embedding breaker key that matches the active provider.

| Provider | Circuit breaker key |
|---|---|
| `openai` | `openai_embedding` |
| `azure-foundry` | `azure_foundry_embedding` |

A shared helper is recommended:

```typescript
export function getEmbeddingBreakerKey(provider: BrainConfig['embedding']['provider']): string {
  return provider === 'azure-foundry'
    ? 'azure_foundry_embedding'
    : 'openai_embedding';
}
```

Use this helper in **both**:

- `src/index.ts`
- `src/cli/index.ts`

The health endpoint payload shape should remain unchanged. Only the breaker key value becomes provider-aware.

---

## 10. Migration and Compatibility

### 10.1 Compatibility Rules

When switching from `openai` to `azure-foundry`, compatibility depends on more than the provider name.

Safe rule set:

- **Same deployment family + same output dimensions** may allow collection reuse.
- **Different model family or different dimensions** requires new collections.
- **Mixed embedding spaces in the same collection are unsupported**, even if dimensions happen to match.

This spec intentionally avoids promising that vectors are always "identical" across providers. Even when both providers expose the same nominal model family, deployment configuration, model version rollout, or service behavior can change retrieval quality. Operators should validate on a representative corpus before treating a provider switch as a zero-risk swap.

### 10.2 Recommended Migration Procedure

1. Inventory existing collections and confirm their configured dimensions.
2. Create a canary namespace or collection using `azure-foundry`.
3. Run representative `remember` and `recall` workflows.
4. Compare retrieval quality, latency, and health behavior.
5. Switch the primary config and restart BHGBrain.
6. Keep the previous OpenAI credential available during the rollback window.

### 10.3 Rollback

Rollback is configuration-driven:

- switch `embedding.provider` back to `openai`,
- restart the process,
- reuse collections only if the model family and dimensions remain compatible,
- otherwise revert to the pre-switch collection or namespace.

No automatic data migration is part of this change.

---

## 11. Testing Plan

### 11.1 Unit Tests (`src/embedding/azure-foundry.test.ts`)

| Test case | Description |
|---|---|
| `constructs correct base URL` | Builds `https://<resource>.openai.azure.com/openai/v1` from `resource_name` |
| `reads api key at construction time` | Constructor caches the Azure API key from the configured env var |
| `sends api-key header` | Uses `api-key`, not `Authorization`, in raw `fetch()` mode |
| `includes dimensions for v3 models` | Sends configured `dimensions` for `text-embedding-3-small` / `text-embedding-3-large` |
| `omits dimensions for ada-002` | Excludes the field for `text-embedding-ada-002` |
| `chunks batches larger than max_batch_inputs` | Splits large requests and preserves result order |
| `aborts on timeout` | Uses `AbortController` and maps timeout failures correctly |
| `retries retryable failures only` | Retries `429`, `5xx`, timeouts, and network failures; not `400` / `401` / `403` / `404` |
| `maps 429 to rateLimited` | Surfaces rate limiting via the existing error model |
| `wraps calls with circuit breaker` | Verifies `breaker.execute()` is used for normal requests |
| `healthCheck bypasses circuit breaker` | Matches current provider behavior |
| `healthCheck returns false on auth failure` | Invalid credentials make the probe fail cleanly |
| `records embedding_embed_batch_ms in finally` | Metrics are recorded on both success and failure |
| `factory degrades on missing startup key` | Missing Azure API key returns `DegradedEmbeddingProvider` |
| `invalid azure config fails startup` | Missing `azure` config or invalid `resource_name` is not silently degraded |
| `breaker key helper returns provider-aware names` | CLI and server can share the same mapping |

### 11.2 Integration Tests

- Provision an Azure embedding deployment such as `text-embedding-3-small`.
- Start BHGBrain with `provider: "azure-foundry"`.
- Verify `remember` stores vectors successfully.
- Verify `recall` returns relevant semantic results.
- Verify the health endpoint reports the provider-aware breaker key.
- Verify wrong credentials produce degraded startup or failed health checks as expected.
- Verify switching back to `provider: "openai"` restores the prior path.

### 11.3 MCP Regression Checks

Because this is an internal provider change, regression checks should explicitly confirm that MCP behavior is unchanged:

- `ListTools` output is unchanged.
- `ListResources` / `ReadResource` behavior is unchanged.
- Embedding-related failures still return the existing error-envelope shape.
- No HTTP vs stdio divergence is introduced by provider selection.

---

## 12. Documentation Updates

### 12.1 README.md

Update the README to:

- document `embedding.provider = "azure-foundry"`,
- document the `embedding.azure` sub-object,
- explain that `model` is the Azure deployment name,
- explain that `AZURE_FOUNDRY_API_KEY` is required,
- explain migration compatibility caveats instead of promising universal identity between providers,
- explain that this change does not add new MCP tools or resources.

### 12.2 Upgrade Notes

Update the existing `### 1.3 → 1.4` entry to include Azure embedding provider:

- New embedding provider: `azure-foundry`
- New config object: `embedding.azure`
- No MCP protocol change
- Reindexing is required when model family or dimensions differ
- Rotation of Azure credentials requires restart or reload

### 12.3 Operator Notes

Add operator-facing guidance for:

- secret storage and rotation,
- private endpoint / VNet recommendations for regulated deployments,
- canary migration before production cutover,
- expected health-cache behavior.

---

## 13. Security, Performance, and Operations Guidance

### 13.1 Security

- Never log API keys, headers, or full upstream request/response bodies.
- Honor `config.security.log_redaction` in all provider logging.
- Prefer managed secret injection over manual local env setup in production.
- For regulated deployments, prefer private endpoints / private networking rather than public internet exposure.
- Because credentials are cached at startup, rotation procedures must include a process restart or reload.

### 13.2 Performance

- Default to `text-embedding-3-small` unless retrieval evaluation justifies a larger model.
- Use batch chunking to avoid hard API-limit failures.
- Keep timeout and retry settings conservative to avoid head-of-line blocking.
- Remember that `text-embedding-3-large` with reduced dimensions can still change retrieval behavior; dimension count alone is not the full compatibility story.
- The 30-second health cache in `HealthService` is intentional and should remain documented so operators understand probe timing.

### 13.3 Observability

At minimum, log or expose:

- provider initialization (without secrets),
- degraded startup due to missing credentials,
- authentication failures,
- repeated rate limits,
- breaker-open conditions,
- health status changes.

---
## 14. Best Practice Patterns for Azure Foundry Coding

This section consolidates key implementation patterns derived from the specification to ensure consistent, secure, and resilient Azure Foundry integrations.

### 14.1 Configuration & Validation

- **Fail-fast validation**: Invalid static configuration (missing resource name, invalid dimensions) should cause immediate startup failure, not runtime errors
- **Strict schema validation**: Use Zod-like validation with model-aware dimension checks (e.g., `ada-002` requires exactly 1536 dimensions)
- **Environment-based secrets**: Load API key once at construction from environment variables, never hardcode

### 14.2 Security & Credentials

- **Never log secrets**: API keys, headers, and full upstream error bodies must be redacted
- **Credential caching**: Cache keys in memory at startup; rotation requires restart/reload
- **Private endpoints**: For regulated deployments, prefer VNet/private networking over public internet exposure

### 14.3 API Integration Patterns

- **Standard endpoint construction**: Use `https://<resource>.openai.azure.com/openai/v1` as the canonical base URL
- **Deployment vs. model**: Treat `model` field as Azure deployment name, not underlying model family
- **Request chunking**: Automatically split batches exceeding Azure's per-request limits (max 2048 inputs)
- **Dimensions-aware requests**: Include `dimensions` field for v3 models, omit for legacy models like `ada-002`

### 14.4 Resilience & Error Handling

- **Circuit breaker pattern**: Use provider-aware breaker keys (`azure_foundry_embedding`)
- **Retry strategy**: Retry only transient failures (network errors, 429, 5xx) with exponential backoff
- **Timeout control**: Use `AbortController` with configurable timeout (default 30s)
- **Error mapping**: Map Azure-specific HTTP errors to consistent internal error types, sanitize messages
- **Degraded mode**: Degrade only for missing startup credentials; runtime failures surface as errors

### 14.5 Observability & Health

- **Real health checks**: Perform authenticated embedding calls, cache results (30s), bypass circuit breaker for probes
- **Metrics**: Record latency histograms (`embedding_embed_batch_ms`) for batch operations
- **Provider-aware monitoring**: Health endpoints report provider-specific breaker keys

### 14.6 Migration & Compatibility

- **No cross-provider assumptions**: Vectors are not guaranteed identical; validate retrieval quality before cutover
- **Clear compatibility rules**: Same model family + dimensions may allow collection reuse; otherwise reindex
- **Canary migration**: Test with isolated namespace/collection before production switch

### 14.7 Testing & Documentation

- **Comprehensive unit tests**: Cover base‑URL construction, auth headers, batch chunking, error mapping, retry logic
- **Integration tests**: Use real Azure deployments to verify end‑to‑end flows
- **Operator guidance**: Document secret rotation, private endpoints, migration procedures, and rollback steps

---
## 15. Files Changed

| File | Change |
|---|---|
| `src/config/index.ts` | Add `azure-foundry` provider config, Azure sub-schema, timeout/retry/batch config, validation rules |
| `src/embedding/azure-foundry.ts` | New provider implementation |
| `src/embedding/azure-foundry.test.ts` | New unit tests |
| `src/embedding/index.ts` | Factory update, `getEmbeddingBreakerKey` helper, and Azure provider import |
| `src/index.ts` | Provider-aware breaker key wiring |
| `src/cli/index.ts` | Provider-aware breaker key wiring |
| `README.md` | Config reference, migration notes, operator guidance |
| `src/health/index.ts` | No payload-shape change required; behavior should remain compatible |

If a shared OpenAI-compatible helper or base class is extracted, add it under `src/embedding/` rather than introducing a new top-level subsystem.

---

## 16. Implementation Status

**Complete**: As of current repository state, all components specified in this document have been implemented and validated:

- ✅ Full provider implementation in `src/embedding/azure-foundry.ts` 
- ✅ Configuration schema with validation in `src/config/index.ts`
- ✅ Circuit breaker key helper and factory integration in `src/embedding/index.ts`
- ✅ Provider-aware health check reporting in `src/index.ts` and `src/cli/index.ts`
- ✅ Comprehensive unit tests covering all specification requirements
- ✅ All tests pass (confirmed via `npm test`)
- ✅ Type checking passes (confirmed via `npx tsc --noEmit`)

---

## 17. Out of Scope

- Entra ID authentication for embeddings
- Marketplace / Cohere embedding providers  
- Deployment-scoped Azure endpoint support
- `services.ai.azure.com` as a first-class configured base domain
- Migration to the `openai` npm package for embeddings
- Multi-provider federation or per-collection provider routing
- Automatic data migration between embedding spaces
- Client-side token counting / truncation

---

## 18. Future Enhancements Considered

Based on the implementation, potential areas for future enhancement include:

- Sharing common OpenAI-compatible request logic between `OpenAIEmbeddingProvider` and `AzureFoundryEmbeddingProvider`
- Client-side token counting to pre-validate input lengths before sending requests
- Enhanced metrics collection with provider-specific labeling
- Entra ID authentication option
- Support for additional Azure embedding models

However, these are beyond the scope of this specification.

---

## 19. References

- [Azure OpenAI embeddings how-to](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/embeddings)
- [Azure OpenAI v1 API lifecycle](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)
- [Foundry Models endpoints overview](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints)
- [Migration from Azure AI Inference to OpenAI-compatible SDKs](https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/model-inference-to-openai-migration)
- [Models sold directly by Azure](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure)
- [Cohere model deployment guidance on Azure](https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/deploy-models-cohere-embed)