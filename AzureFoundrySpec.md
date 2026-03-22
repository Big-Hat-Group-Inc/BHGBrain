# Azure Foundry Models Embedding Provider - Application Specification

**Status:** Draft
**Date:** 2026-03-22
**Component:** `src/embedding/`
**Affects:** config schema, embedding provider, health checks, documentation

---

## 1. Motivation

BHGBrain currently supports only the direct OpenAI embedding API (`https://api.openai.com/v1`). Enterprise and government deployments often require Azure-hosted inference for compliance, data residency, and unified billing. Microsoft Foundry Models exposes an OpenAI-compatible REST surface for embeddings, making this a low-friction addition.

This specification defines how BHGBrain adds Azure Foundry Models as a second embedding provider alongside the existing OpenAI provider.

---

## 2. Azure Foundry Models - Technical Background

### 2.1 Endpoint Format

Azure Foundry Models supports two endpoint styles for embeddings. Both accept the same OpenAI-compatible request body.

| Style | URL Pattern |
|---|---|
| **OpenAI/v1 (recommended)** | `https://<resource>.openai.azure.com/openai/v1/embeddings` |
| **Deployment-scoped** | `https://<resource>.openai.azure.com/openai/deployments/<deployment>/embeddings?api-version=2024-10-21` |

> The Azure AI Inference beta SDK and its `https://<resource>.services.ai.azure.com/models` endpoint are deprecated (retiring May 30, 2026). This spec targets the stable OpenAI/v1 surface only.

### 2.2 Authentication

| Method | Header | Notes |
|---|---|---|
| **API Key** | `api-key: <key>` | Simplest. Key obtained from Azure Portal. |
| **Entra ID (keyless)** | `Authorization: Bearer <token>` | Token scope: `https://ai.azure.com/.default`. Recommended for production. |

### 2.3 Request / Response

The request body is identical to the OpenAI embeddings API:

```json
POST /openai/v1/embeddings
{
  "model": "text-embedding-3-small",
  "input": ["The ultimate answer to the question of life"],
  "dimensions": 1536
}
```

Response:

```json
{
  "object": "list",
  "data": [
    {
      "index": 0,
      "object": "embedding",
      "embedding": [0.017196655, ..., -0.015777588]
    }
  ],
  "model": "text-embedding-3-small",
  "usage": {
    "prompt_tokens": 9,
    "total_tokens": 9
  }
}
```

### 2.4 Available Embedding Models

| Model | Dimensions | Max Tokens | MTEB Score | Notes |
|---|---|---|---|---|
| `text-embedding-3-large` | 3072 (reducible) | 8192 | 64.6 | Best quality. Supports `dimensions` param to reduce output. |
| `text-embedding-3-small` | 1536 (reducible) | 8192 | 62.3 | Good cost/quality balance. Same model BHGBrain uses today via OpenAI. |
| `text-embedding-ada-002` | 1536 (fixed) | 8192 | 61.0 | Legacy. Does not support `dimensions` param. |
| `Cohere-embed-v3-english` | 1024 | 512 | - | Supports `input_type` (document/query). Marketplace model. |
| `Cohere-embed-v3-multilingual` | 1024 | 512 | - | 100+ languages. Supports `input_type`. Marketplace model. |

### 2.5 Limits

- Maximum **2048 inputs** per batch request.
- Maximum **8192 tokens** per input (OpenAI models); 512 tokens for Cohere models.
- Rate limits are configured per-deployment in the Azure Portal.

---

## 3. Recommended Model Configurations

### 3.1 Default / General Use

```jsonc
{
  "embedding": {
    "provider": "azure-foundry",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

Same model and dimensions BHGBrain already defaults to. Zero-friction migration from direct OpenAI - existing Qdrant collections remain compatible with no re-indexing.

### 3.2 High-Quality Retrieval

```jsonc
{
  "embedding": {
    "provider": "azure-foundry",
    "model": "text-embedding-3-large",
    "dimensions": 3072
  }
}
```

Best retrieval accuracy. Requires creating new Qdrant collections (dimension mismatch with existing 1536d collections).

### 3.3 High-Quality Retrieval (Compact)

```jsonc
{
  "embedding": {
    "provider": "azure-foundry",
    "model": "text-embedding-3-large",
    "dimensions": 1536
  }
}
```

Uses the `text-embedding-3-large` model but reduces output to 1536 dimensions via the `dimensions` request parameter. Better quality than `text-embedding-3-small` at the same storage cost. Compatible with existing 1536d Qdrant collections if switching from `text-embedding-3-small` (however, mixing embedding spaces in the same collection is not recommended - see [Embedding Model Compatibility](#7-migration--compatibility)).

### 3.4 Multilingual

```jsonc
{
  "embedding": {
    "provider": "azure-foundry",
    "model": "Cohere-embed-v3-multilingual",
    "dimensions": 1024
  }
}
```

Best option for multi-language memory stores. Requires new Qdrant collections (1024d). Cohere models are marketplace deployments and may have different billing.

---

## 4. Configuration Schema Changes

### 4.1 New Config Values

Add `"azure-foundry"` to the `embedding.provider` enum and introduce Azure-specific fields:

```jsonc
{
  "embedding": {
    // "openai" (default, existing) or "azure-foundry"
    "provider": "azure-foundry",

    // Model deployment name in Azure Foundry
    "model": "text-embedding-3-small",

    // Vector dimensions (must match Qdrant collection)
    "dimensions": 1536,

    // --- Azure-specific fields (ignored when provider = "openai") ---

    "azure": {
      // Azure Foundry resource name (the <resource> in the URL)
      "resource_name": "my-foundry-resource",

      // API version for deployment-scoped endpoints (optional, default shown)
      "api_version": "2024-10-21",

      // Authentication method: "api_key" or "entra_id"
      "auth_method": "api_key",

      // Env var holding the Azure API key (used when auth_method = "api_key")
      "api_key_env": "AZURE_FOUNDRY_API_KEY",

      // Env var holding the Entra ID bearer token (used when auth_method = "entra_id")
      // The application is responsible for token refresh; BHGBrain reads this env var on each request.
      "entra_token_env": "AZURE_FOUNDRY_TOKEN"
    }
  }
}
```

### 4.2 Zod Schema Update

In `src/config/index.ts`, extend the embedding schema:

```typescript
embedding: z.object({
  provider: z.enum(['openai', 'azure-foundry']).default('openai'),
  model: z.string().default('text-embedding-3-small'),
  api_key_env: z.string().default('OPENAI_API_KEY'),
  dimensions: z.number().int().positive().default(1536),
  azure: z.object({
    resource_name: z.string().min(1),
    api_version: z.string().default('2024-10-21'),
    auth_method: z.enum(['api_key', 'entra_id']).default('api_key'),
    api_key_env: z.string().default('AZURE_FOUNDRY_API_KEY'),
    entra_token_env: z.string().default('AZURE_FOUNDRY_TOKEN'),
  }).optional(),
}).default({}),
```

Validation rule: when `provider` is `"azure-foundry"`, the `azure` object is required and `azure.resource_name` must be non-empty.

### 4.3 Environment Variables

| Variable | Required When | Description |
|---|---|---|
| `AZURE_FOUNDRY_API_KEY` | `auth_method = "api_key"` | API key from the Azure Portal for the Foundry resource. |
| `AZURE_FOUNDRY_TOKEN` | `auth_method = "entra_id"` | Entra ID bearer token with scope `https://ai.azure.com/.default`. Must be refreshed externally. |

---

## 5. Implementation Design

### 5.1 New Class: `AzureFoundryEmbeddingProvider`

Create `src/embedding/azure-foundry.ts` implementing the existing `EmbeddingProvider` interface:

```typescript
export class AzureFoundryEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly authMethod: 'api_key' | 'entra_id';
  private readonly apiKeyEnv: string;
  private readonly entraTokenEnv: string;
  private readonly breaker?: CircuitBreaker;
  private readonly metrics?: MetricsCollector;

  constructor(config: BrainConfig, breaker?: CircuitBreaker, metrics?: MetricsCollector);

  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
}
```

#### Base URL Construction

```typescript
// OpenAI/v1 compatible endpoint (recommended by Microsoft)
this.baseUrl = `https://${config.embedding.azure.resource_name}.openai.azure.com/openai/v1`;
```

#### Authentication Header

```typescript
private getAuthHeaders(): Record<string, string> {
  if (this.authMethod === 'entra_id') {
    const token = process.env[this.entraTokenEnv];
    if (!token) throw embeddingUnavailable('Entra ID token not found');
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  const apiKey = process.env[this.apiKeyEnv];
  if (!apiKey) throw embeddingUnavailable('Azure API key not found');
  return {
    'api-key': apiKey,
    'Content-Type': 'application/json',
  };
}
```

#### Request Body

The request body is identical to the existing OpenAI provider:

```json
{
  "model": "<deployment-name>",
  "input": ["text1", "text2"],
  "dimensions": 1536
}
```

The `dimensions` field is included only when the model supports it (OpenAI v3 models). For `text-embedding-ada-002` and Cohere models, omit it.

#### Circuit Breaker and Metrics

Thread the existing `CircuitBreaker` and `MetricsCollector` identically to `OpenAIEmbeddingProvider`:

- `embed()` and `embedBatch()` route through `this.breaker.execute()` when a breaker is provided.
- `healthCheck()` bypasses the breaker (consistent with OpenAI provider behavior).
- Record `embedding_embed_batch_ms` histogram on each batch call.

### 5.2 Factory Update

Extend `createEmbeddingProvider()` in `src/embedding/index.ts`:

```typescript
export function createEmbeddingProvider(
  config: BrainConfig,
  options?: { breaker?: CircuitBreaker; metrics?: MetricsCollector },
): EmbeddingProvider {
  switch (config.embedding.provider) {
    case 'openai':
      try {
        return new OpenAIEmbeddingProvider(config, options?.breaker, options?.metrics);
      } catch {
        return new DegradedEmbeddingProvider(config);
      }
    case 'azure-foundry':
      try {
        return new AzureFoundryEmbeddingProvider(config, options?.breaker, options?.metrics);
      } catch {
        return new DegradedEmbeddingProvider(config);
      }
    default:
      throw new Error(`Unknown embedding provider: ${config.embedding.provider}`);
  }
}
```

### 5.3 Shared Base Class (Optional Refactor)

Both `OpenAIEmbeddingProvider` and `AzureFoundryEmbeddingProvider` share nearly identical `embedBatch()` logic (fetch, parse, sort by index, record metrics). Consider extracting a shared `BaseOpenAICompatibleProvider` that both classes extend, differing only in:

- `getBaseUrl()` - returns the provider-specific URL
- `getAuthHeaders()` - returns provider-specific auth headers
- `shouldIncludeDimensions()` - whether to send the `dimensions` field

This keeps the provider code DRY without over-abstracting.

### 5.4 Health Check

The Azure Foundry provider health check embeds a single short string (same as the OpenAI provider) and returns `true`/`false`. It bypasses the circuit breaker and never throws.

### 5.5 Degraded Mode

If the required Azure credentials are missing at startup (`resource_name` empty, or env var not set), `createEmbeddingProvider()` catches the error and returns the existing `DegradedEmbeddingProvider`. No changes needed to degraded mode behavior.

---

## 6. Health Endpoint Changes

The `circuitBreakers` object in the health snapshot currently reports `openai_embedding`. When the Azure Foundry provider is active, the key should reflect the actual provider:

| Provider | Circuit Breaker Key |
|---|---|
| `openai` | `openai_embedding` |
| `azure-foundry` | `azure_foundry_embedding` |

Update `src/index.ts` where the breaker map is constructed for `HealthService`:

```typescript
const breakerKey = config.embedding.provider === 'azure-foundry'
  ? 'azure_foundry_embedding'
  : 'openai_embedding';

const healthService = new HealthService(storage, embedding, config, {
  [breakerKey]: embeddingBreaker,
  qdrant: qdrantBreaker,
});
```

---

## 7. Migration & Compatibility

### 7.1 Switching Providers with Existing Data

BHGBrain locks embedding model and dimensions at collection creation time (see existing "Embedding Model Compatibility" behavior note). When switching from `openai` to `azure-foundry`:

- **Same model + same dimensions** (e.g., `text-embedding-3-small` at 1536d on both): Existing collections remain compatible. The vectors are identical regardless of whether they originate from OpenAI direct or Azure Foundry - both run the same underlying model.
- **Different model or dimensions**: New collections are required. Writing to existing collections with mismatched dimensions returns a `CONFLICT` error (existing behavior, no changes needed).

### 7.2 Rollback

Switching `provider` back to `"openai"` in `config.json` restores the original behavior. No data migration is needed as long as the same model and dimensions are used.

---

## 8. Testing Plan

### 8.1 Unit Tests (`src/embedding/azure-foundry.test.ts`)

| Test Case | Description |
|---|---|
| `constructs correct base URL` | Verify URL is `https://<resource>.openai.azure.com/openai/v1` |
| `sends api-key header for api_key auth` | Verify `api-key` header, no `Authorization` header |
| `sends Bearer token for entra_id auth` | Verify `Authorization: Bearer <token>` header |
| `includes dimensions in request body` | For v3 models, `dimensions` field is present |
| `embedBatch sorts by index` | Results are ordered by response index, not insertion order |
| `circuit breaker wraps fetch calls` | Verify breaker.execute is called |
| `healthCheck bypasses circuit breaker` | Health check does not use breaker |
| `throws embeddingUnavailable on HTTP error` | Non-200 responses produce correct error code |
| `throws embeddingUnavailable when credentials missing` | Missing env var at call time produces correct error |
| `factory returns DegradedProvider on missing resource_name` | Startup without config falls back gracefully |

### 8.2 Integration Tests

- Deploy `text-embedding-3-small` in an Azure Foundry resource.
- Run BHGBrain with `provider: "azure-foundry"` and verify:
  - `remember` tool stores memories with vectors.
  - `recall` tool returns semantically relevant results.
  - `health` endpoint reports `embedding: healthy` with correct breaker key.
  - Switching back to `provider: "openai"` (same model) works without re-indexing.

---

## 9. Documentation Updates

### 9.1 README.md

- Add `"azure-foundry"` to the `embedding.provider` enum description in the Configuration Reference.
- Add the full `azure` config sub-object with inline comments.
- Add a subsection under Configuration or a new "Embedding Providers" section explaining both providers.
- Add `AZURE_FOUNDRY_API_KEY` and `AZURE_FOUNDRY_TOKEN` to the Environment Variables table.

### 9.2 Upgrading Section

Add a `### 1.4 -> 1.5` entry:

- **New embedding provider**: `azure-foundry` - use Azure Foundry Models for embedding instead of direct OpenAI.
- **No migration required** if using the same model and dimensions.
- **New config section**: `embedding.azure` (only relevant when provider is `azure-foundry`).

---

## 10. Files Changed

| File | Change |
|---|---|
| `src/config/index.ts` | Add `"azure-foundry"` to provider enum; add `azure` sub-schema |
| `src/embedding/azure-foundry.ts` | **New file.** `AzureFoundryEmbeddingProvider` class |
| `src/embedding/azure-foundry.test.ts` | **New file.** Unit tests |
| `src/embedding/index.ts` | Update `createEmbeddingProvider()` factory with `azure-foundry` case |
| `src/index.ts` | Dynamic circuit breaker key based on provider |
| `src/cli/index.ts` | Same dynamic breaker key |
| `README.md` | Config reference, env vars, upgrade notes |

---

## 11. Out of Scope

- **Entra ID token refresh within BHGBrain.** The application reads the token from an environment variable on each request. Token lifecycle management (refresh, rotation) is the responsibility of the host environment (e.g., Azure Managed Identity, a sidecar, or a wrapper script).
- **Cohere `input_type` support.** Cohere models accept `input_type: "document"` or `"query"` for optimized embeddings. This is a potential future enhancement but not part of this spec. BHGBrain currently does not distinguish between document and query embeddings.
- **Azure AI Inference SDK.** The beta SDK is deprecated (retiring May 2026). This spec targets only the stable OpenAI/v1 REST surface.
- **Multiple simultaneous providers.** BHGBrain supports one embedding provider at a time. Multi-provider federation (e.g., different providers per collection) is out of scope.

---

## 12. References

- [Azure Foundry Models - Endpoints](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints)
- [Azure Foundry Models - Embeddings How-To](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/use-embeddings)
- [Azure OpenAI Embeddings Tutorial](https://learn.microsoft.com/en-us/azure/foundry/openai/tutorials/embeddings)
- [Models Sold Directly by Azure (model list & dimensions)](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure)
- [OpenAI/v1 Migration Guide](https://aka.ms/openai/v1)
- [Cohere Embed v3 on Azure](https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/deploy-models-cohere-embed)
