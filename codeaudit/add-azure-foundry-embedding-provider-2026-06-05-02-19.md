# Code Audit — OpenSpec proposal `add-azure-foundry-embedding-provider`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `add-azure-foundry-embedding-provider`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 11 key files — `src/embedding/azure-foundry.ts`, `src/embedding/index.ts`, `src/config/index.ts`, `src/index.ts`, `src/cli/index.ts`, `src/health/index.ts`, `src/errors/index.ts`, `src/resilience/circuit-breaker.ts`, plus tests (`src/embedding/azure-foundry.test.ts`, `src/embedding/index.test.ts`, `src/config/index.test.ts`, `src/health/index.test.ts`), `README.md`, `.env.example`

## Executive summary

The Azure Foundry provider is implemented cleanly, matches the proposal's design decisions closely, and is backed by thorough unit/integration tests (Azure provider, config validation, factory degradation, provider-aware breaker keys, and health wiring). Overall health is good. There are no Critical or High findings. The most material gaps are spec-drift items: the schema validates dimension compatibility for three known models but does not enforce that the configured Azure model is a *supported* model (spec requires it), and the Azure health probe path runs through full retry/backoff whereas the OpenAI provider's probe does a single request — a behavioral divergence that can make health checks slow. The remainder are Low-severity maintainability and observability notes consistent with existing house style.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| Req: Azure config validated at startup (resource_name DNS-safe, api_key_env, supported model, compatible dimensions, max_batch ≤ 2048) | Partial | `src/config/index.ts:8-67` validates resource_name regex, api_key_env default, dimension constraints, and `max_batch_inputs` cap (`:27`). "Supported embedding model" is NOT enforced — `model` is a free `z.string()` (`:23`); unknown models pass. |
| Scenario: Valid Azure config selects provider via `https://<resource>.openai.azure.com/openai/v1` | Done | `src/embedding/azure-foundry.ts:59`; test `azure-foundry.test.ts:119` |
| Scenario: Invalid static config fails startup (missing config / bad resource / incompatible dims / batch>2048) | Done | `src/config/index.ts:34-66`, `:27`; tests `config/index.test.ts:47,62,75`; factory rethrow `embedding/index.ts:149-157`, test `embedding/index.test.ts:192` |
| Req: Azure auth via `api-key` header, deployment in `model`, array `input`; include dims for v3, omit for ada-002 | Done | `src/embedding/azure-foundry.ts:161-176`, `:7-9,165-167`; tests `azure-foundry.test.ts:107,126,144` |
| Scenario: v3 request includes dimensions / ada-002 omits | Done | `src/embedding/azure-foundry.ts:165-167`; tests `azure-foundry.test.ts:126,144` |
| Req: batch chunking ≤ max_batch_inputs, ordering preserved, timeouts, retry only transient (429/5xx/network/timeout), no retry on 4xx | Done | chunk `:11-17,80`; ordering `:197-199`; timeout `:158-159`; retry classes `:119-135,202-210`; tests `azure-foundry.test.ts:161,200,223,234,249` |
| Scenario: oversized batch chunked + reassembled in order | Done | `:80-87,197-199`; test `azure-foundry.test.ts:161` |
| Scenario: retryable retried, 400/401/403/404 not retried | Done | `:119-135,142-149`; tests `azure-foundry.test.ts:200,223` |
| Req: degrade only on missing startup credential; fail fast on invalid config; runtime failures stay provider errors | Done | `embedding/index.ts:7-9,149-157`; `azure-foundry.ts:62-66`; tests `embedding/index.test.ts:187,192` |
| Scenario: missing Azure key degrades | Done | `azure-foundry.ts:62-66` → `embedding/index.ts:153-155`; test `embedding/index.test.ts:187` |
| Scenario: runtime outage does not swap provider | Partial | No code re-instantiates the provider at runtime (provider built once in `index.ts:59`); errors surface via `embedBatch` catch (`azure-foundry.ts:90-97`). Verified by absence of swap logic + factory tests, but no dedicated runtime-outage test asserting the instance is not replaced. |
| Req: provider switch does not change MCP contract | Done (by design) | No tool/resource/schema changes in scope; `proposal.md:27`. Not directly re-verified against `src/tools/*` in this audit — no Azure-conditional branching found in entrypoints beyond breaker key. |
| Req: breaker key `openai_embedding` / `azure_foundry_embedding` per provider | Done | `embedding/index.ts:129-133`; wired `index.ts:81`, `cli/index.ts:44`; tests `azure-foundry.test.ts:324`, `health/index.test.ts:153-171` |
| Req: health probes use real authenticated request, bypass breaker, return boolean | Done | `azure-foundry.ts:100-108` (`useBreaker=false`); tests `azure-foundry.test.ts:279,294` |
| Scenario: invalid Azure creds → probe false, no throw | Done | `azure-foundry.ts:105-107`; test `azure-foundry.test.ts:294` |
| Scenario: health probe bypasses breaker | Done | `azure-foundry.ts:102,180-184`; test `azure-foundry.test.ts:279` |
| Req: provider-aware health preserves payload shape + cache window | Done | `health/index.ts:81-103` (shape unchanged, cache `:88-91`); test `health/index.test.ts:153` |
| Task 1.1 config + model-aware validation | Partial | `config/index.ts:8-67` — model-supportedness not enforced (see above) |
| Task 1.2 factory + breaker-key helper | Done | `embedding/index.ts:129-161` |
| Task 2.1 provider base URL / auth / dims | Done | `azure-foundry.ts:59,161-176` |
| Task 2.2 chunk/timeout/backoff/order/error map | Done | `azure-foundry.ts:77-210` |
| Task 2.3 degrade/fail-fast/runtime/healthCheck boolean | Done | `azure-foundry.ts:62-66,100-108`; `embedding/index.ts:149-157` |
| Task 3.1 entrypoint breaker-key wiring | Done | `index.ts:81`, `cli/index.ts:44` |
| Task 3.2 cache preserved + probe bypasses breaker (both providers) | Done | `health/index.ts:88-91`; OpenAI `embedding/index.ts:56-64`, Azure `azure-foundry.ts:100-108` |
| Task 4.1 Azure unit coverage | Done | `azure-foundry.test.ts` (22 cases) |
| Task 4.2 health/regression coverage | Done | `health/index.test.ts:153`; `embedding/index.test.ts:181-202` |
| Task 4.3 README operator/migration guidance | Done | `README.md:190,249-272,457,2493-2494,2514-2522,2648-2653` |
| Task 5.1–5.3 lint/test/build run | Unverified | Marked `[x]` in tasks.md; not re-run in this read-only audit. |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | Medium | High | S | Maintainability / Spec | `src/config/index.ts:23,42-66` | Azure model not validated against a supported set; spec requires "supported embedding model" |
| 2 | Medium | High | M | Performance / Stability | `src/embedding/azure-foundry.ts:100-108` | Health probe runs full retry/backoff (Azure), diverging from OpenAI single-request probe; probes can be slow |
| 3 | Low | High | S | Maintainability | `src/embedding/azure-foundry.ts:187-200` vs `src/embedding/index.ts:86-99` | Duplicated `parseEmbeddingsResponse` across providers; drift risk flagged in design Open Question |
| 4 | Low | Medium | S | Stability | `src/embedding/azure-foundry.ts:202-210` | Retryability of fetch errors relies on `name`/`TypeError`/regex string match; brittle |
| 5 | Low | Low | S | Observability | `src/embedding/azure-foundry.ts` (whole file) | No Pino logging of retries/aborts/breaker trips; only histogram metric |
| 6 | Low | Medium | S | Maintainability | `src/config/index.ts:42-66` | Model/dimension validation gated on `provider==='azure-foundry'`; identical OpenAI configs unvalidated (asymmetry) |
| 7 | Low | Low | S | Maintainability | `src/embedding/azure-foundry.ts:187-191` | `!response.ok` branch in `parseEmbeddingsResponse` is effectively dead on the calling paths |

## Quick wins

- Finding #1: add a model enum/allow-list (or explicit "unknown model" warning) in the Azure `superRefine` so an unsupported/typo'd deployment-family is caught at startup rather than silently omitting `dimensions`. Effort S.
- Finding #3/#7: minor dedup/cleanup of the shared `parseEmbeddingsResponse` (or accept the design's deferred-helper-extraction note). Effort S.

## Performance

### [Medium · High · M] Health probe runs through full retry/backoff — `src/embedding/azure-foundry.ts:100-108`
**Issue:** `healthCheck()` calls `requestWithRetry(['health check'], false)`, which applies the same exponential-backoff retry loop (`:110-154`) as production embedding calls. With defaults `max_attempts=3`, `backoff_ms=1000`, a probe against an unavailable/5xx Azure endpoint can block ~1s + ~2s of backoff plus three network round trips before returning `false`. The OpenAI provider's probe (`src/embedding/index.ts:56-64`) issues a single `requestEmbeddings(...)` with no retry, so the two providers behave differently. The 30s health cache (`src/health/index.ts:88-91`) limits frequency but not the latency of an individual probe.
**Why it matters:** A health endpoint that can hang for several seconds during an Azure outage degrades observability responsiveness and can hold a request thread on the HTTP health surface. It also makes the two providers' probe semantics inconsistent for operators.
**Recommendation:** Have `healthCheck()` issue a single, non-retried request (mirroring the OpenAI provider). If retry on probes is intentional, document it and consider a smaller probe-specific attempt cap/timeout.

## Logging & observability

### [Low · Low · S] No structured logging in the Azure provider — `src/embedding/azure-foundry.ts` (entire file)
**Issue:** The provider records only `embedding_embed_batch_ms` via metrics (`:96`) and emits no Pino logs on retries, aborts/timeouts, 429s, or breaker-managed failures.
**Why it matters:** During an Azure incident, operators have no log trail of retry counts, status codes, or sanitized error bodies — harder to triage transient vs. persistent failures.
**Recommendation:** Consider injecting the logger (as other modules do) and logging at `warn`/`debug` on retryable failures and aborts, with redaction. Note: this matches existing house style — `OpenAIEmbeddingProvider` also logs nothing — so this is a consistency-preserving enhancement, not a regression.

## Stability & reliability

### [Low · Medium · S] Retryability classification of fetch errors is brittle — `src/embedding/azure-foundry.ts:202-210`
**Issue:** `isRetryableError` treats a thrown error as retryable when `err.name === 'AbortError'`, `err instanceof TypeError`, or `/fetch|network/i.test(err.message)`. The regex relies on runtime-specific message text; `err instanceof TypeError` is redundant under the preceding `err instanceof Error` guard but harmless. Undici/Node fetch network failures are typically `TypeError` (covered), but message-based matching is fragile across Node versions.
**Why it matters:** A future Node/undici change to error messages could cause genuine network failures to be classified non-retryable (or vice versa), changing retry behavior silently.
**Recommendation:** Prefer structured signals (e.g. `error.cause?.code` such as `ECONNRESET`/`ETIMEDOUT`, and `AbortError` by name) over message regex. Low priority; current behavior is tested for the AbortError path (`azure-foundry.test.ts:177`).

## Security

No issues found. Secrets are read from the env var named by `embedding.azure.api_key_env` (`src/embedding/azure-foundry.ts:61-66`), never logged; the `api-key` header is set per request (`:172`) and not exposed. Error bodies are truncated to 200 chars before surfacing (`:190`). Endpoint is constructed from a DNS-safe, lowercased, regex-validated `resource_name` (`src/config/index.ts:9-13`), preventing arbitrary-URL injection — consistent with the design's narrowed-scope decision.

## Maintainability & code quality

### [Medium · High · S] Azure model is not validated against a supported set — `src/config/index.ts:23,42-66`
**Issue:** `embedding.model` is a free `z.string()` (`:23`). The Azure `superRefine` (`:42-66`) only enforces dimension *compatibility* for the three explicitly-named models; any other string (typo, unsupported family, or an Azure deployment name that doesn't map to a known model) passes validation. `shouldIncludeDimensions` (`azure-foundry.ts:7-9`) then silently omits `dimensions` for anything that isn't `text-embedding-3-small/large`. The spec (`spec.md:4`) states config "MUST include ... a supported embedding model".
**Why it matters:** Because Azure's `model` field carries the *deployment name* (README.md:190), this is partly intentional flexibility — but it means a misconfigured/unsupported model is not caught at startup, contradicting the "fail fast on invalid static config" requirement and potentially producing wrong-dimension vectors silently.
**Recommendation:** Either (a) enforce an allow-list of supported model families for Azure in `superRefine`, or (b) intentionally document that `model` is a free deployment name and reconcile the spec wording. Given the deployment-name semantics, option (a) applied to a known-family field plus a separate deployment alias, or explicit documentation, would resolve the drift.

### [Low · High · S] Duplicated response parsing across providers — `src/embedding/azure-foundry.ts:187-200` vs `src/embedding/index.ts:86-99`
**Issue:** `parseEmbeddingsResponse` (ordering-by-index, slice/sort/map, 200-char error truncation) is duplicated almost verbatim in both providers. The design's Open Question explicitly flags this drift risk.
**Why it matters:** Dimensions/retry/error-mapping logic can diverge silently over time between the two providers.
**Recommendation:** Acceptable as a deferred follow-up per the design's stated non-goal; if convenient, extract a shared `parseOpenAICompatibleEmbeddings` helper.

### [Low · Medium · S] Model/dimension validation only applies to Azure provider — `src/config/index.ts:42-66`
**Issue:** The dimension-compatibility checks are gated on `value.provider === 'azure-foundry'`. The same incompatible `model`+`dimensions` combination under `provider: 'openai'` is not validated.
**Why it matters:** Asymmetric guardrails; an operator could set an invalid OpenAI dimension and only discover it at request time.
**Recommendation:** Consider applying the dimension constraints provider-agnostically (they reflect model limits, not provider limits). Out of strict scope for this proposal but worth noting.

### [Low · Low · S] Dead `!response.ok` guard — `src/embedding/azure-foundry.ts:187-191`
**Issue:** `requestWithRetry` only ever returns `response.ok` responses (non-ok statuses are thrown at `:118-138`), so the `!response.ok` branch in `parseEmbeddingsResponse` is unreachable on both the embed and health paths.
**Why it matters:** Minor confusion; harmless defensive code.
**Recommendation:** Leave as a defensive guard or remove for clarity.

## Testing & coverage

Coverage is strong. The Azure provider has 22 cases covering base-URL construction, api-key header, dimensions include/omit, chunking, abort-on-timeout, retry-only-transient, 429 mapping, non-retryable preservation, breaker wrap, health-bypass, health-false-on-401, metrics, missing-config throw, and breaker-key helper (`azure-foundry.test.ts:88-327`). Config validation (`config/index.test.ts:27-87`), factory degradation/rethrow (`embedding/index.test.ts:181-202`), and provider-aware health breaker key (`health/index.test.ts:153-171`) are all tested.

Gaps (Low):
- No test asserting the runtime-outage requirement that the *provider instance is not swapped* after startup (spec scenario `azure-foundry-embedding-provider/spec.md:46-49`) — verified by code inspection only.
- No test for an unsupported/unknown Azure model (relates to Finding #1).
- No test asserting batch reassembly *order across chunks* with distinct per-chunk results (the chunking test `:161` uses identical responses, so ordering across chunks is exercised but not differentiated).

## Dependencies & supply chain

No issues found. The Azure provider uses the Node 20 global `fetch`/`AbortController` (`src/embedding/azure-foundry.ts:158,169`) and adds no new runtime dependency — consistent with the design non-goal of migrating to the `openai` SDK. `package.json` pins `node >=20.0.0` (engines) which guarantees global `fetch` availability. The pre-existing `openai` dependency (`^4.85.4`) is unrelated to this provider.

## Recommendations (prioritized)

1. **Resolve the model-validation spec drift (Finding #1).** Either enforce a supported-model allow-list for Azure in `superRefine` or explicitly document/reconcile the deployment-name semantics so unsupported models fail fast. Highest-value, low effort.
2. **Align the Azure health probe with the OpenAI single-request probe (Finding #2)** to avoid multi-second hangs during outages, or document the intentional difference.
3. **Add a regression test** asserting the provider instance is not replaced on runtime outage, and a test for an unsupported model name.
4. **Optional cleanup:** extract the shared OpenAI-compatible response parser (Findings #3/#7) — already tracked as the design's Open Question — and consider making dimension validation provider-agnostic (Finding #6).
5. **Optional observability:** add redaction-safe Pino logging of retries/aborts in the Azure provider (Finding #5), ideally alongside the same for the OpenAI provider for parity.
