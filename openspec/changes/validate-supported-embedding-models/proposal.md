## Why

The Azure Foundry embedding work added dimension-compatibility checks for three named models but never enforces that the configured embedding model is *supported*. Because `embedding.model` is a free `z.string()` (`src/config/index.ts:23`) and the Azure `superRefine` only constrains dimensions for `text-embedding-ada-002`, `text-embedding-3-small`, and `text-embedding-3-large` (`src/config/index.ts:42-66`), a typo'd or unsupported model passes startup validation. Worse, `shouldIncludeDimensions` (`src/embedding/azure-foundry.ts:7-9`) then silently omits the `dimensions` field for any unrecognized model, so the deployment can produce wrong-dimension vectors that mismatch the Qdrant collection without any error. This contradicts the existing spec requirement that Azure config "MUST include ... a supported embedding model" and the "fail fast on invalid static config" requirement.

Separately, the Azure `healthCheck()` routes its probe through the full retry/backoff loop (`requestWithRetry(['health check'], false)`, `src/embedding/azure-foundry.ts:100-108`), while the OpenAI provider's probe is a single-shot request (`src/embedding/index.ts:56-64`). During an Azure outage an Azure health probe can block for several seconds (default `max_attempts=3`, `backoff_ms=1000`) before returning `false`, making health reporting slow and inconsistent across providers.

## What Changes

- Enforce a supported-model allow-list during config validation so an unsupported or typo'd embedding model is rejected at startup (fail-fast), with a clear error that lists the supported models. This applies to both `openai` and `azure-foundry` providers.
- Guarantee that the effective embedding `dimensions` value is resolved from the validated model rather than silently omitted, so a supported model never produces wrong-dimension vectors.
- Change the Azure provider's `healthCheck()` to issue a single-shot, bounded probe with no retry/backoff loop, mirroring the OpenAI provider so health reflects current state quickly.
- Add unit coverage for unsupported-model rejection, supported-model dimension resolution, and the single-shot Azure health probe.

## Capabilities

### New Capabilities
- `embedding-model-validation`: validates the configured embedding model against a supported allow-list at startup for both providers, resolves the effective dimensions for the validated model, and makes the embedding health probe a single-shot bounded check.

### Modified Capabilities

## Impact

- Affected code: `src/config/index.ts` (Zod schema / `superRefine` model validation, `~23`, `42-66`), `src/embedding/azure-foundry.ts` (`healthCheck`, `100-108`; `shouldIncludeDimensions`, `7-9`), and the associated config / embedding tests.
- Affected documentation: `README.md` (supported-model list / error behavior) and `.env.example` if model guidance is referenced.
- External systems: none new; outbound Azure / OpenAI embeddings calls are unchanged in shape — only the health probe stops retrying.
- MCP/API impact: none; tools, resources, and response envelopes are unchanged. This is a validation/observability hardening of net-new findings from the audit of `add-azure-foundry-embedding-provider`.
- Behavior change / migration note: configs that currently set an unsupported `embedding.model` will now fail startup instead of silently degrading. Operators using an Azure *deployment* name that differs from the supported model family must align it with a supported model (see design).
