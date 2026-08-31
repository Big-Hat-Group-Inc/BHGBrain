## 1. Define the supported-model set and validation

- [x] 1.1 Introduce a single canonical list of supported embedding models (e.g. `text-embedding-ada-002`, `text-embedding-3-small`, `text-embedding-3-large`) with their dimension constraints, usable by `src/config/index.ts`.
- [x] 1.2 In the embedding config `superRefine` (`src/config/index.ts:33-67`), reject any `embedding.model` not in the supported set with a clear error that lists the supported models, applying to both `openai` and `azure-foundry` providers (not just Azure).
- [x] 1.3 Ensure the effective `embedding.dimensions` is resolved/validated against the supported model so it can never be silently omitted for a supported model; keep the existing per-model dimension caps.

## 2. Make the embedding health probe single-shot

- [x] 2.1 Change `AzureFoundryEmbeddingProvider.healthCheck()` (`src/embedding/azure-foundry.ts:100-108`) to issue one bounded request (timeout, no retry/backoff loop), mirroring the OpenAI provider's single-shot probe (`src/embedding/index.ts:56-64`).
- [x] 2.2 Confirm the probe still bypasses the circuit breaker and returns a boolean (false on failure, no throw to the health caller).

## 3. Documentation

- [x] 3.1 Update `README.md` to list the supported embedding models and document that an unsupported model fails startup; reconcile Azure deployment-name guidance with the supported-model requirement.
- [x] 3.2 Update `.env.example` model guidance if it references model selection.

## 4. Tests

- [x] 4.1 Add config tests: an unsupported/typo'd model is rejected at startup for both providers; a supported model with compatible dimensions passes and resolves dimensions.
- [x] 4.2 Add an Azure provider test asserting `healthCheck()` issues a single request (no retry/backoff) and returns `false` without multiple attempts on failure.

## 5. Validation

- [x] 5.1 Run `npm run lint`, `npm test`, and `npm run build`.
