# Storage & Recall Feature Brainstorm

Ideas for improving how BHGBrain stores and recalls memories, grounded in a read of the
current code (2026-08-27, post `openspec/build-20260826-201021`). Each item notes where
it would land and roughly how big it is. This is a brainstorm, not a commitment — the
natural next step for anything promising is `/opsx:propose`.

Reference points in the current implementation:

- Write path: `src/pipeline/index.ts` — checksum dedup → embed → top-1 similarity →
  NOOP/UPDATE/DELETE/ADD, with a Jaccard fallback when embeddings are down.
- Recall: `src/tools/index.ts` `handleRecall` — semantic-only, post-filters by
  `min_score`/type/tags.
- Search: `src/search/index.ts` — semantic / fulltext / hybrid (RRF, k=60, +0.1 T0 boost).
- Fulltext: `src/storage/sqlite.ts` `fullTextSearch` — `LIKE %term%` over a plain table
  with a hand-rolled term-frequency score (not FTS5).
- Inject: `src/resources/index.ts` `buildInjectPayload` — all categories + newest-K
  memories under a char budget.
- Lifecycle: `src/domain/lifecycle.ts` — T0–T3 tiers, TTLs, access-count promotion.

---

## 1. Retrieval quality (biggest wins live here)

### 1.1 Real FTS5 with BM25 and stemming
`memories_fts` is a plain table queried with non-sargable `LIKE '%term%'` and a
hand-rolled term-frequency score. Moving to a genuine FTS5 virtual table (sql.js builds
support it) gets BM25 ranking, porter stemming ("deploy" matches "deployed"), prefix
queries, and phrase queries — and makes fulltext scale past a few thousand memories.
The hybrid RRF fusion already consumes rank order, so the swap is contained to
`fullTextSearch`. **Medium effort, high impact.**

### 1.2 Composite ranking: relevance × recency × importance × access
`importance` is stored on every memory but never read at query time; `access_count`
drives tier promotion but not ranking; recency is ignored entirely (the only prior
signal is the flat +0.1 T0 boost in hybrid). A composite score like

```
final = relevance * (w_r + w_i·importance + w_a·log(1+access_count)) * exp(-λ·age)
```

with per-tier λ (T0 decays ~never, T3 fast) would make "the thing I confirmed five
times last week" reliably outrank "a similar thing from eight months ago". Weights
belong in `config.search`. **Medium effort, high impact — probably the single best
recall-quality lever.**

### 1.3 Push filters down instead of post-filtering
`handleRecall` fetches `limit` results and then discards those failing type/tags/
`min_score` — so `limit: 5, type: procedural` can legitimately return 0 results even
when procedural memories exist just below the cut. Qdrant supports payload filters
(type, tags, collection are already in the payload) and SQLite can filter in the FTS
query. Filtering at the store means the limit applies to *matching* memories.
**Small–medium effort, fixes a real correctness wart.**

### 1.4 Calibrate `min_score` per mode — or unify recall onto hybrid
`recall` is hardcoded to semantic mode with `min_score` default 0.6, which reads as a
cosine-similarity threshold. If recall ever moves to hybrid, RRF scores live in a
totally different range (~0.03 max) and the default would silently filter everything.
Either (a) keep raw cosine + normalized fused score as separate fields with the
threshold applied to the right one, or (b) normalize all modes to [0,1] before
thresholding. Also worth asking why `recall` and `search` are separate tools at all —
recall = search(semantic) + post-filters. **Small effort, prevents a future footgun.**

### 1.5 Multi-query expansion / HyDE at recall time
A recall query like "how do we deploy" embeds one string. Cheap wins available without
any model: embed the query *and* a keyword-stripped variant, union the candidates
before fusion. With a model (the `pipeline.extraction_model_env` key already reserves
an LLM hook): generate 2–3 paraphrases or a hypothetical answer (HyDE) and search all
of them. Recall for vague queries improves a lot; cost is extra embed calls.
**Medium effort, high impact for conversational queries.**

### 1.6 MMR / diversity re-ranking
Top-K results are frequently near-duplicates of each other (dedup thresholds only
collapse ≥0.92 similarity). Maximal Marginal Relevance over the candidate vectors —
which Qdrant already returns — would spend the K slots on *distinct* facts. Especially
valuable for `memory://inject`, where budget is scarce. **Small effort once vectors
are plumbed through, medium impact.**

### 1.7 Cross-encoder / LLM re-rank stage (opt-in)
For the top ~20 candidates, a rerank pass (LLM scoring relevance 0–1, or a local
cross-encoder) before returning the top 5. Config-gated the same way extraction is
meant to be, so stock installs stay dependency-free. **Medium effort, high precision
gain, adds latency — belongs behind a flag.**

### 1.8 Time-scoped and "as-of" queries
Episodic memories have timestamps but no query surface for them: "what did we decide
last week" can only be answered by semantic luck. Add `after`/`before` (and maybe
`as_of`, using the revision table — see 3.4) to `search`/`recall` schemas and push
them into the stores as filters. **Small effort, unlocks a whole query class.**

---

## 2. Write-path / ingestion intelligence

### 2.1 LLM multi-candidate extraction (finish the reserved hook)
`extract()` is single-candidate; `extraction_enabled`/`extraction_model` exist in
config but do nothing (the TODO in `pipeline/index.ts` says exactly this). A paragraph
like "We use pnpm not npm, deploys go through GitHub Actions, and Alice owns the infra
repo" becomes one blob memory whose embedding is the *average* of three facts — hurting
both dedup and recall. Splitting into atomic candidates is the highest-leverage
ingestion change; everything downstream (dedup, UPDATE targeting, recall precision)
gets better. **Large effort (model dependency, failure modes), very high impact.**

### 2.2 Real summarization
`generateSummary` = first line truncated to 120 chars. For multi-line content the
summary often carries no signal, yet it's weighted 2× in fulltext scoring and is what
`memory://list` and the inject fallback display. Options: cheapest-model LLM summary at
write time (config-gated), or extractive fallback (highest-TF sentence). **Small–medium
effort, compounding impact since summaries feed search, inject, and browsing.**

### 2.3 Auto-tagging and entity extraction
Tags are caller-supplied and most writes have none, making the tag filter and the 2×
tag weight in fulltext scoring dead weight in practice. Deterministic v1: extract
code-shaped tokens, repo names, file paths, @-names into tags. LLM v2: proper entity
extraction (people/projects/tools) into a normalized `entities` table → enables
"everything about <entity>" queries and graph edges (see 3.1). **Small (v1) to large
(v2), medium–high impact.**

### 2.4 Semantic contradiction detection (beyond regex)
`detectsInvalidation` fires only on explicit phrases ("no longer", "correction:").
"We migrated to Postgres" silently coexists with "we use MySQL" — both recalled, agent
confused. When a new write lands within the UPDATE band (0.92–0.98) of an existing
memory, an LLM entailment check (agree / refine / contradict) could route contradict →
DELETE+replace with lineage, refine → UPDATE. This is the biggest *correctness* gap in
long-lived stores: stale facts never die unless phrased as corrections. **Medium
effort, gated on an extraction model existing.**

### 2.5 Consider more than top-1 in the dedup decision
`classifyOperation` fetches 10 similar memories and looks only at `similar[0]`. If
three prior memories all sit at ~0.90 the new write ADDs a fourth variant. Considering
the top few enables merge-into-best-target decisions and feeds consolidation (5.1).
**Small effort to widen, medium impact.**

### 2.6 Chunking for long content
`remember` accepts 100k chars embedded as a single vector — long documents become
mush-vectors that match everything weakly. Chunk-at-write (with a shared `parent_id`)
or reject-and-suggest-import. The `import` tool already does section splitting;
`remember` should either borrow it or delegate past a size threshold. **Medium effort.**

---

## 3. Memory structure & relationships

### 3.1 Typed edges between memories
The only link today is `merged_from` (replacement lineage). A small `memory_links`
table — `refines`, `contradicts`, `derived_from`, `about_same_entity`, `follows` —
plus a `relate` tool and link-following at recall ("pull the memory + its refinements")
turns a flat pile into a navigable knowledge structure. Graph traversal beyond one hop
is likely overkill; even single-hop expansion at recall time is a meaningful upgrade.
**Medium effort, foundation for several other items.**

### 3.2 Episodic → semantic distillation ("sleep")
The type system (episodic/semantic/procedural) mirrors human memory but nothing moves
between types. A scheduled job (CleanupScheduler already exists as a home) that takes
clusters of related T2/T3 episodics and distills them into one T1 semantic memory —
archiving the sources with `derived_from` links — is the classic memory-consolidation
pattern, and it's what makes a store *improve* with age instead of silting up.
**Large effort (needs LLM + clustering), the most ambitious idea here.**

### 3.3 Surface the revision history
`memory_revisions` rows exist (`MemoryRevisionRecord`) but no tool or resource exposes
them. A `history` action (or `memory://{id}/revisions`) showing content-over-time, plus
revert, makes UPDATE less scary — today an aggressive 0.92-similarity UPDATE silently
overwrites content with no user-visible undo. **Small effort, pure win.**

### 3.4 Provenance metadata
`source: 'cli'|'api'|'agent'|'import'` is the entire provenance story. Adding
`origin` (session/conversation id, tool caller, repo+branch when known) and a
`confidence` score (explicit user statement > agent inference) enables trust-weighted
ranking and "where did this belief come from?" answers. **Small schema change, pays
off across ranking and debugging.**

---

## 4. Context assembly (`memory://inject`)

### 4.1 Relevance-conditioned inject
`buildInjectPayload` returns categories + *newest*-K memories — recency masquerading as
relevance. Since MCP resources can't take a query, add a template resource
`memory://inject/{hint}` (hint = repo name, task phrase) that runs hybrid search to
pick the K memories, falling back to newest when no hint. This is the difference
between "session context" and "whatever happened lately". **Medium effort, high impact
for the flagship auto-inject feature.**

### 4.2 Token budgets, not char budgets
`auto_inject.max_chars` counts characters; consumers budget in tokens. A ~chars/4
estimate (or a real tokenizer behind config) plus per-section budgets (categories vs
memories) prevents one bloated category from starving memory inject. **Small effort.**

### 4.3 Near-duplicate suppression + pinning in inject
Two ideas that share plumbing: (a) suppress near-duplicates among the K injected
memories (MMR from 1.6); (b) a `pinned` flag memories can carry so critical facts
(e.g. "always use pnpm") are always injected regardless of recency/relevance rank —
distinct from T0, which only affects retention and a small hybrid boost. **Small
effort each.**

---

## 5. Lifecycle & hygiene

### 5.1 Duplicate-cluster audit & consolidation report
Dedup only fires at write time against the incoming candidate; historic near-dupes
(esp. from imports and degraded-window writes) accumulate forever. An offline job that
clusters existing vectors (Qdrant scroll + pairwise ≥0.9) and emits a mergeable-cluster
report — human-approved merge via a `consolidate` tool — cleans years of accretion.
Also the natural substrate for 3.2. **Medium effort.**

### 5.2 A `review` tool for the T1 queue
`review_due` is set on every T1 memory and checked by nothing user-facing. A `review`
tool that pages through due memories (keep / revise / archive / promote) closes the
loop the field was designed for, and is a natural human-curation surface. **Small
effort.**

### 5.3 Recall from the archive
`archived_memories` keeps summary/tags/tier of expired memories but nothing can search
it. `search(include_archived: true)` (fulltext-only is fine — vectors are gone) plus a
restore path answers "I know I used to know this". **Small effort.**

### 5.4 Embedding model/version stamping + re-embed migration
Vectors carry no record of which model/dimension produced them. Switching
`embedding.model` today silently mixes incompatible vector spaces — cosine scores
across models are meaningless — and nothing detects it. Stamp `embedding_model` +
`embedding_version` per memory, warn on mismatch at startup, and provide a `re-embed`
job (batched, resumable, reusing the reconciliation machinery). **Medium effort, and
increasingly urgent — the Azure provider means multi-model configs are already real.**

---

## 6. Feedback & evaluation

### 6.1 Recall feedback signal
Add an optional lightweight signal — `recall(..., feedback_id)` returning a handle the
client can mark `useful: true/false`, or a dedicated `feedback` tool. Even sparse
feedback enables tuning hybrid weights, decay λ, and dedup thresholds against reality
instead of vibes, and identifies memories that are retrieved often but never useful
(candidates for demotion). **Small effort to collect; the analysis can come later.**

### 6.2 Retrieval quality metrics
The metrics layer records latency but nothing about quality. Cheap additions:
result-count distribution per mode, % of recalls returning 0 results after filtering
(a direct symptom of 1.3), score distributions, degraded-mode frequency per namespace.
Turns "recall feels bad" into a graph. **Small effort.**

### 6.3 A golden-set eval harness
A `codeaudit/`-style eval: ~50 (query → expected memory) pairs run against a seeded
store in CI, reporting recall@5 / MRR. Any change from section 1 or 2 gets measured
instead of eyeballed. **Small–medium effort, multiplies confidence in everything else.**

---

## Suggested ordering (impact ÷ effort)

**Quick wins first:**
1. **1.3 filter push-down** — fixes real result starvation, small.
2. **1.2 composite ranking** — importance/access/recency are stored and wasted today.
3. **3.3 revision history surface** — data already exists, small tool addition.
4. **4.2 token budgeting** + **5.2 review tool** + **5.3 archive search** — small, self-contained.

**Then the platform pieces:**
5. **1.1 FTS5** — foundation for all fulltext quality.
6. **5.4 embedding stamping** — do it before a model migration forces it in anger.
7. **4.1 relevance-conditioned inject** — flagship feature stops being recency-only.
8. **6.3 eval harness** — before the big-model work, so it can be measured.

**Then the model-backed tier (each wants `extraction_model` wired up first):**
9. **2.1 multi-candidate extraction** → **2.4 contradiction detection** → **3.2 distillation**, in that order — each builds on the previous.

The single most valuable *small* change is probably 1.2 (composite ranking); the most
valuable *large* one is 2.1 (atomic extraction), which improves every downstream stage.
