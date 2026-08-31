## Context

The audit of the completed `add-azure-foundry-embedding-provider` change (`codeaudit/add-azure-foundry-embedding-provider-2026-06-05-02-19.md`) surfaced two net-new findings:

1. **Model not validated against a supported set** (Medium · High). `embedding.model` is a free `z.string()` (`src/config/index.ts:23`). The Azure `superRefine` (`src/config/index.ts:42-66`) only enforces *dimension* compatibility for three explicitly named models; any other string passes. `shouldIncludeDimensions` (`src/embedding/azure-foundry.ts:7-9`) then silently omits `dimensions` for unrecognized models. The spec already states config "MUST include ... a supported embedding model" and that invalid static config "fails fast", so this is spec drift that can produce wrong-dimension vectors silently.

2. **Azure health probe runs the full retry/backoff loop** (Medium · High). `healthCheck()` calls `requestWithRetry(['health check'], false)` (`src/embedding/azure-foundry.ts:100-108`), applying the same exponential backoff as production calls (default `max_attempts=3`, `backoff_ms=1000`). The OpenAI provider probes with a single request (`src/embedding/index.ts:56-64`). Azure probes can therefore hang for several seconds during an outage, inconsistently with OpenAI.

## Goals / Non-Goals

Goals:
- Reject unsupported/unknown embedding models at startup (fail-fast) for both providers, with an error that lists supported models.
- Guarantee the effective `dimensions` is resolved for a validated model and never silently omitted.
- Make the embedding health probe a single-shot, bounded check so health reflects current state quickly and consistently across providers.

Non-Goals:
- Changing the set of providers, the request/response wire shape, or any MCP tool/resource/protocol.
- Adding new runtime dependencies or migrating to the `openai` SDK.
- Extracting the duplicated `parseEmbeddingsResponse` helper, adding provider logging, or hardening fetch-error classification (separate Low-severity audit findings, out of scope here).

## Decisions

1. **Single canonical supported-model list.** Define one source of truth (model -> dimension constraint) and reference it from `superRefine`. This avoids drift between the validation list and `shouldIncludeDimensions`.
2. **Validation applies to both providers.** The supported-model and dimension constraints reflect model limits, not provider limits, so they are enforced for `openai` and `azure-foundry` alike. This also removes the current Azure-only asymmetry.
3. **Fail-fast, not degrade.** An unsupported model is invalid *static* configuration, so it rejects startup (a Zod `superRefine` issue) rather than falling back to `DegradedEmbeddingProvider`. Degraded mode remains reserved for *missing credentials* only.
4. **Resolve dimensions for supported models.** For a validated supported model the effective `dimensions` is always a known value within the model's cap; `shouldIncludeDimensions` continues to govern whether the field is sent on the wire (omitted only for `ada-002`), but the model is guaranteed supported first.
5. **Single-shot health probe.** `AzureFoundryEmbeddingProvider.healthCheck()` issues one bounded request (respecting `request_timeout_ms`) with no retry/backoff, mirroring the OpenAI provider. It still bypasses the breaker and returns a boolean.

## Risks / Trade-offs

- **Breaking change for existing configs.** Configs that set an unsupported `embedding.model` (including an Azure deployment name that doesn't map to a supported model family) will now fail startup. Mitigation: clear error listing supported models, README guidance, and a migration note in the proposal.
- **Azure deployment-name semantics.** Azure's `model` field carries the deployment name (README:190), which may legitimately differ from the model family. Trade-off: we require the configured value to be a supported model family; operators must align deployment naming or use a supported model. This is preferred over silently shipping wrong-dimension vectors.
- **Less retry on health.** A single-shot probe may report `false` on a one-off transient blip that a retried probe would have masked. This is the intended trade-off: health should reflect current state quickly, and the 30s health cache (`src/health/index.ts:88-91`) already smooths frequency.

## Migration Plan

- Land validation + single-shot probe together; no data migration required.
- Document supported models and the fail-fast behavior in `README.md` and `.env.example`.
- Operators on an unsupported model must update `embedding.model` to a supported value before upgrading; the startup error names the supported set.

## Open Questions

- Should the supported-model list be extensible via config (e.g. an escape-hatch allow-list with an explicit `dimensions`) for forward-compatibility with new Azure deployments, or kept as a fixed enum until a new model is intentionally added? Default assumption: fixed list, extended deliberately.
- For Azure where `model` is a deployment name, do we need a separate `deployment` vs `model` field, or is requiring the deployment to be named after a supported model acceptable? Default assumption: the latter, documented.
