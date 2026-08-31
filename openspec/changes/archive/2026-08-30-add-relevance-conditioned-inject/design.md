## Context

MCP resources cannot carry query parameters on a static URI, which is why inject has
no query context today — but resource *templates* can (`memory://{id}` already ships).
`memory://inject/{hint}` follows the same mechanism, so clients that can render a URI
with a task phrase get relevance conditioning, and clients that only read the static
URI keep working.

The payload builder is already budget-aware and incremental (`appendBlock`); this
change re-parameterizes selection and budget arithmetic without restructuring
assembly. The `SearchService` is available on the resource handler's context (health
resources already reach through it in other handlers).

## Goals / Non-Goals

Goals:
- Relevance-conditioned memory selection behind a hint, with graceful fallbacks
  (hintless → recency; degraded embeddings → fulltext leg only).
- Budget arithmetic that cannot starve the memory section and can budget in
  token estimates.
- No behavior change for existing `memory://inject` consumers by default.

Non-Goals:
- No real tokenizer dependency (chars/4 estimate only; a pluggable tokenizer is a
  follow-up if precision matters).
- No conversation-state awareness (the hint is caller-provided, not inferred).
- No change to category selection (categories are policy context; all of them are
  intended, budget permitting).

## Decisions

- **Template over tool**: inject is a resource concept in MCP (session context
  fetched by the host); keeping it a resource preserves client integration patterns.
  A `hint` parameter on a hypothetical tool would not be auto-fetched by hosts.
- **Reserved fraction, not fixed sizes**: `memory_budget_fraction` scales with
  `max_chars` and degrades sensibly at small budgets. Categories fill up to
  `(1 - fraction) × budget` first; memories then use the remainder plus whatever
  categories left unused (no waste).
- **Suppression uses existing thresholds**: reusing
  `deduplication.similarity_threshold` keeps "near-duplicate" meaning one thing
  project-wide rather than introducing a second knob.
- **Access recording on hinted inject**: yes — hinted inject is a recall in every
  meaningful sense, and promotion/access stats should see it. Hintless recency inject
  continues not to record access (unchanged), keeping the default path side-effect
  free.

## Risks / Trade-offs

- Hint quality determines value; a bad hint is worse than recency. Mitigated by the
  explicit fallback contract and documentation steering hosts to stable hints (repo
  name, task title).
- chars/4 is a crude token estimate (CJK ≈ 1 char/token). Accepted for v1; the unit
  is config-gated precisely so a real tokenizer can slot in later without a contract
  change.
- Template URIs with spaces need encoding; the handler must decode exactly once and
  cap length to the search query limit to avoid oversized embeds.
