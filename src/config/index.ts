import { z } from 'zod';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { parseCronExpression, nextRunAfter } from '../backup/scheduler.js';
import { atomicWriteFileSync } from '../storage/sqlite.js';

const DEVICE_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * Canonical set of embedding models supported across both providers, keyed by
 * dimension constraint. `fixedDimensions` means the model only accepts that
 * exact dimension count; `maxDimensions` means any positive value up to the
 * cap is accepted. This is the single source of truth referenced by config
 * validation so the supported-model list can never drift from the dimension
 * caps enforced at startup.
 */
export const SUPPORTED_EMBEDDING_MODELS = {
  'text-embedding-ada-002': { fixedDimensions: 1536 },
  'text-embedding-3-small': { maxDimensions: 1536 },
  'text-embedding-3-large': { maxDimensions: 3072 },
} as const satisfies Record<string, { fixedDimensions?: number; maxDimensions?: number }>;

export type SupportedEmbeddingModel = keyof typeof SUPPORTED_EMBEDDING_MODELS;

function isSupportedEmbeddingModel(model: string): model is SupportedEmbeddingModel {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_EMBEDDING_MODELS, model);
}

const AzureEmbeddingSchema = z.object({
  resource_name: z.string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'resource_name must contain only lowercase letters, numbers, and hyphens'),
  api_key_env: z.string().default('AZURE_FOUNDRY_API_KEY'),
}).strict();

const ConfigSchema = z.object({
  data_dir: z.string().optional(),
  device: z.object({
    id: z.string().regex(DEVICE_ID_RE).optional(),
  }).strict().prefault({}),
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
      // unify-llm-client-boundaries: embedding requests now retry through
      // the same capped-jitter backoff primitive every migrated chat
      // feature uses (`src/llm/client.ts`), which requires an explicit cap
      // on the exponential envelope in addition to `backoff_ms`.
      max_backoff_ms: z.number().int().positive().default(10_000),
    }).strict().prefault({}),
    azure: AzureEmbeddingSchema.optional(),
    // Guards against silently mixing embedding spaces: when the store's
    // persisted expected embedding identity (see embedding-provenance)
    // differs from the active configuration, vector-producing writes fail
    // with an actionable error instead of writing vectors from a different
    // model into the same collection. Disable only if you intentionally
    // want to mix spaces (e.g. a deliberate, monitored migration window).
    refuse_writes_on_model_mismatch: z.boolean().default(true),
  }).strict().superRefine((value, ctx) => {
    if (value.provider === 'azure-foundry' && !value.azure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'embedding.azure is required when embedding.provider = "azure-foundry"',
        path: ['azure'],
      });
    }

    // Supported-model validation applies to both providers: the constraint is
    // a property of the model, not of which API serves it.
    if (!isSupportedEmbeddingModel(value.model)) {
      const supported = Object.keys(SUPPORTED_EMBEDDING_MODELS).join(', ');
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsupported embedding model '${value.model}'. Supported models: ${supported}`,
        path: ['model'],
      });
      return;
    }

    const constraint = SUPPORTED_EMBEDDING_MODELS[value.model];
    if ('fixedDimensions' in constraint && value.dimensions !== constraint.fixedDimensions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.model} requires dimensions = ${constraint.fixedDimensions}`,
        path: ['dimensions'],
      });
    } else if ('maxDimensions' in constraint && value.dimensions > constraint.maxDimensions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.model} supports at most ${constraint.maxDimensions} dimensions`,
        path: ['dimensions'],
      });
    }
  }).strict().prefault({}),
  // Shared OpenAI-compatible chat/embedding request boundary
  // (unify-llm-client-boundaries): one base URL and retry envelope every
  // migrated feature (extraction, reranking, summarization, query expansion,
  // entailment, distillation, and OpenAI embeddings — Azure embeddings keep
  // their derived per-resource endpoint) resolves through, instead of each
  // hardcoding `https://api.openai.com/v1` and its own retry logic. Feature
  // credentials, models, and timeouts remain feature-specific config (see
  // `pipeline.extraction_model_env`, `search.rerank.model_env`, etc.) — this
  // section covers only what genuinely needs to be uniform. See
  // `openspec/changes/unify-llm-client-boundaries` and `src/llm/client.ts`.
  llm: z.object({
    // Validated as a URL so a typo'd endpoint fails fast at config-load time
    // rather than as an opaque fetch failure on the first request.
    base_url: z.string().url().default('https://api.openai.com/v1'),
    retry: z.object({
      max_attempts: z.number().int().min(1).max(5).default(3),
      backoff_ms: z.number().int().positive().default(200),
      // Caps both the exponential backoff envelope and a provider's
      // Retry-After guidance, bounding worst-case retry latency inside a
      // feature's own request deadline.
      max_backoff_ms: z.number().int().positive().default(2000),
    }).strict().prefault({}),
  }).strict().prefault({}),
  qdrant: z.object({
    mode: z.enum(['embedded', 'external']).default('embedded'),
    embedded_path: z.string().default('./qdrant'),
    external_url: z.string().nullable().default(null),
    api_key_env: z.string().nullable().default(null),
    // bound-qdrant-http-runtime task 1.1: the @qdrant/js-client-rest client
    // inherits a 300s default request timeout (client-side, AbortSignal-based)
    // — far longer than any deadline this service otherwise offers, so a
    // black-holed Qdrant endpoint could hold a request (and, pre-breaker-
    // coverage, the whole HTTP request) open for minutes. `operation_timeout_ms`
    // bounds every request-path/administrative call made through the main
    // client (routed through the shared circuit breaker — see
    // QdrantStore.executeWithBreaker); `health_timeout_ms` is a separate,
    // intentionally shorter deadline used only by the independent health probe
    // (QdrantStore's dedicated `healthClient`), which deliberately bypasses the
    // breaker so a stalled dependency degrades health quickly without waiting
    // out the full operational deadline.
    operation_timeout_ms: z.number().int().positive().default(10_000),
    health_timeout_ms: z.number().int().positive().default(3_000),
    fanout: z.object({
      // Upper bound on how many collections one collectionless (namespace-wide)
      // query fans out to; beyond this the target list is deterministically
      // truncated rather than firing an unbounded number of concurrent Qdrant
      // requests. See bound-qdrant-http-runtime task 1.4.
      max_collections: z.number().int().positive().default(25),
      // How many of those target collections are queried concurrently (in
      // fixed-size batches — see QdrantStore.search).
      concurrency: z.number().int().positive().default(5),
      // Per-collection result cap applied only while actually fanning out
      // (more than one target collection) — bounds how much work/payload one
      // target contributes independent of a caller-supplied `limit`, so a
      // large `limit` times a wide fan-out cannot multiply into an
      // unbounded amount of per-target work before the top-K merge trims it
      // back down. A single explicit `collection` search is unaffected and
      // keeps using the caller's `limit` directly.
      per_target_limit: z.number().int().positive().default(50),
    }).strict().prefault({}),
  }).strict().superRefine((value, ctx) => {
    if (value.health_timeout_ms > value.operation_timeout_ms) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `qdrant.health_timeout_ms (${value.health_timeout_ms}) should not exceed ` +
          `qdrant.operation_timeout_ms (${value.operation_timeout_ms}) — the health probe is meant to ` +
          'fail faster than an operational call, not slower.',
        path: ['health_timeout_ms'],
      });
    }
  }).strict().prefault({}),
  storage: z.object({
    // A bounded wait lets short-lived CLI/server writer overlap settle without
    // turning a stuck external writer into an unbounded request stall.
    sqlite_busy_timeout_ms: z.number().int().min(0).max(60_000).default(5_000),
  }).strict().prefault({}),
  backup: z.object({
    retention: z.object({
      // Backup *file* retention (how many/how old `.bhgb` artifacts to keep)
      // — distinct from `retention` above, which governs individual memory
      // lifecycle. `null` disables that particular bound; growth is
      // otherwise unbounded and proportional to database size, so a stock
      // install keeps both bounds on by default. Applied after every
      // successful `backup create` (both bounds evaluated; a backup beyond
      // either is pruned) — see make-backup-restore-transactional task 3.4.
      max_count: z.number().int().positive().nullable().default(30),
      max_age_days: z.number().int().positive().nullable().default(90),
    }).strict().prefault({}),
  }).strict().prefault({}),
  transport: z.object({
    http: z.object({
      enabled: z.boolean().default(true),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(3721),
      bearer_token_env: z.string().default('BHGBRAIN_TOKEN'),
      // Applied directly to the captured `http.Server` (`httpServer.keepAliveTimeout`
      // etc. in `src/index.ts`). Defaults chosen to be proxy-safe: keep-alive above
      // the common 60 s reverse-proxy idle timeout, headers timeout above that per
      // Node's own documented requirement, and Node's stock 300 s request timeout
      // made tunable. See harden-http-server-lifecycle design.md "Timeout config keys".
      keep_alive_timeout_ms: z.number().int().positive().default(65000),
      headers_timeout_ms: z.number().int().positive().default(66000),
      request_timeout_ms: z.number().int().positive().default(300000),
      // bound-qdrant-http-runtime task 3.1-3.3: per-session state for the
      // Streamable HTTP MCP transport (src/transport/mcp-http.ts) is otherwise
      // unbounded — a client that abandons a session without sending DELETE
      // (the common case; see design.md decision 3) leaks its transport
      // forever. `idle_timeout_ms` is how long a session may go without
      // activity before an unref'd sweep closes it; `max_sessions` is a hard
      // capacity enforced at session creation (oldest-idle eviction, or 503 if
      // none is safely evictable); `sweep_interval_ms` paces that sweep.
      mcp_session: z.object({
        idle_timeout_ms: z.number().int().positive().default(30 * 60_000),
        max_sessions: z.number().int().positive().default(1000),
        sweep_interval_ms: z.number().int().positive().default(60_000),
      }).strict().prefault({}),
    }).strict().superRefine((value, ctx) => {
      if (value.headers_timeout_ms <= value.keep_alive_timeout_ms) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `headers_timeout_ms (${value.headers_timeout_ms}) must be greater than ` +
            `keep_alive_timeout_ms (${value.keep_alive_timeout_ms}) — Node requires the headers ` +
            'timeout to exceed the keep-alive timeout to avoid ECONNRESET races.',
          path: ['headers_timeout_ms'],
        });
      }
    }).strict().prefault({}),
    stdio: z.object({
      enabled: z.boolean().default(true),
    }).strict().prefault({}),
  }).strict().prefault({}),
  defaults: z.object({
    namespace: z.string().default('global'),
    collection: z.string().default('general'),
    recall_limit: z.number().int().min(1).max(20).default(5),
    min_score: z.number().min(0).max(1).default(0.6),
    auto_inject_limit: z.number().int().min(1).default(10),
    max_response_chars: z.number().int().positive().default(50000),
    // Per-namespace cap on the number of memories with `pinned: true`, so
    // pinning stays a small, deliberate set rather than a second unbounded
    // inject path. See add-inject-pinning.
    pin_limit_per_namespace: z.number().int().min(1).max(200).default(20),
  }).strict().prefault({}),
  retention: z.object({
    decay_after_days: z.number().int().positive().default(180),
    max_db_size_gb: z.number().positive().default(2),
    max_memories: z.number().int().positive().default(500000),
    warn_at_percent: z.number().min(0).max(100).default(80),
    tier_ttl: z.object({
      T0: z.null().default(null),
      T1: z.number().int().positive().default(365),
      T2: z.number().int().positive().default(90),
      T3: z.number().int().positive().default(30),
    }).strict().prefault({}),
    tier_budgets: z.object({
      T0: z.null().default(null),
      T1: z.number().int().positive().default(100000),
      T2: z.number().int().positive().default(200000),
      T3: z.number().int().positive().default(200000),
    }).strict().prefault({}),
    auto_promote_access_threshold: z.number().int().positive().default(5),
    sliding_window_enabled: z.boolean().default(true),
    archive_before_delete: z.boolean().default(true),
    cleanup_schedule: z.string().default('0 2 * * *'),
    scheduled_cleanup_enabled: z.boolean().default(true),
    // One GC pass is deliberately bounded so a large expired corpus advances
    // across scheduler ticks without monopolising the lifecycle operation.
    cleanup_batch_size: z.number().int().min(1).max(1000).default(200),
    cleanup_max_duration_ms: z.number().int().min(1_000).max(300_000).default(30_000),
    pre_expiry_warning_days: z.number().int().nonnegative().default(7),
    compaction_deleted_threshold: z.number().min(0).max(1).default(0.10),
    // Bounds on the two insert-only history tables, enforced by `runGc`'s
    // pruning step (trim-sqlite-query-and-health-overhead). `null` disables
    // the corresponding prune — the pre-existing "keep forever" behavior.
    // Defaults are generous enough that a store must be genuinely
    // long-lived before any row is dropped.
    audit_log_max_entries: z.number().int().positive().nullable().default(50000),
    revisions_per_memory_max: z.number().int().positive().nullable().default(20),
    // Scheduled "sleep" job that clusters related T2/T3 episodic memories and
    // consolidates each qualifying cluster into one durable T1 semantic
    // memory via an LLM call, archiving the sources with lineage
    // (`derived_from`) preserved. Off by default: this is a new outbound LLM
    // dependency with irreversible content loss on the sources (archiving
    // keeps only summary/tags/tier), so existing installs are unaffected
    // until an operator opts in and provisions an extraction API key. See
    // add-memory-distillation.
    distillation: z.object({
      enabled: z.boolean().default(false),
      // One hour after cleanup_schedule's default ('0 2 * * *'), so a
      // freshly-archived-by-GC store isn't also mid-distillation at the same
      // moment on a stock install.
      schedule: z.string().default('0 3 * * *'),
      // Cosine similarity floor for two T2/T3 episodic memories to be
      // unioned into the same cluster. Conservative by design (recommend
      // 0.85): a false merge is not reversible once sources are archived.
      similarity_threshold: z.number().min(0).max(1).default(0.85),
      // A connected component smaller than this is left alone — too weak a
      // signal that these memories represent one durable fact.
      min_cluster_size: z.number().int().min(2).default(3),
      // A connected component larger than this is deterministically split
      // into max_cluster_size-sized chunks rather than distilled as one
      // (or dropped) — see distillation-cluster.ts.
      max_cluster_size: z.number().int().min(2).default(20),
      // Upper bound on clusters distilled (i.e. LLM calls made) per
      // scheduled tick, bounding worst-case cost/latency per run.
      max_clusters_per_run: z.number().int().positive().default(10),
      // Upper bound on episodic T2/T3 candidates clustered per
      // namespace/collection per run — clustering is O(n^2) pairwise
      // comparisons, so an unbounded candidate set makes one run's compute
      // cost scale quadratically with corpus size. When a collection has
      // more eligible candidates than this, a deterministic
      // `max_candidates_per_collection`-sized window is selected (see
      // `distillation_collection_state`'s cursor) and the rest are skipped
      // for this run, not silently dropped — the cursor advances so a later
      // run's window covers the next slice, eventually rotating through the
      // whole candidate pool. See bound-corpus-scale-workflows task 2.1.
      max_candidates_per_collection: z.number().int().positive().default(500),
      // unify-llm-client-boundaries task 2.2: the distillation LLM call
      // (`DistillationLLMClient.distill`) previously had no timeout at all —
      // a hung provider request blocked `DistillationScheduler.runOnce`
      // forever, which in turn meant `scheduleNext()` (called only after
      // `runOnce` resolves) never ran again, silently ending every future
      // scheduled tick. Enforced via the shared request executor's
      // `AbortController` deadline, covering body read/parse the same as
      // every other migrated feature. Higher than the cheap-model defaults
      // (`extraction_timeout_ms`/`summarization_timeout_ms`) since a
      // distillation prompt bundles a whole cluster's memory contents.
      llm_timeout_ms: z.number().int().positive().default(10_000),
    }).strict().prefault({}),
  }).strict().prefault({}),
  deduplication: z.object({
    enabled: z.boolean().default(true),
    similarity_threshold: z.number().min(0).max(1).default(0.92),
    // How many of the fetched top-10 similarity candidates classifyOperation
    // evaluates for corroboration (capped at 10 because searchSimilar is called
    // with a hardcoded topK=10). NOOP/DELETE/direct-UPDATE still key off
    // window[0] (== similar[0]) alone; only the new corroboration path (below)
    // looks past the closest candidate. corroboration_enabled is an independent
    // kill switch: when false, classification is single-candidate-only exactly
    // as it was pre-widening, regardless of the other three values here.
    // corroboration_count candidates (out of the window) scoring within
    // corroboration_margin of the tier's UPDATE threshold escalate an otherwise
    // ADD decision to UPDATE against the highest-scoring corroborator. See
    // widen-dedup-candidate-window.
    candidate_window: z.number().int().min(1).max(10).default(5),
    corroboration_enabled: z.boolean().default(true),
    corroboration_count: z.number().int().min(2).default(2),
    corroboration_margin: z.number().min(0).max(1).default(0.03),
  }).strict().prefault({}),
  // Read-side near-duplicate discovery/merge for existing memories, distinct
  // from write-time `deduplication` above: `consolidate list` surfaces
  // clusters of already-stored memories whose pairwise similarity meets
  // `similarity_threshold`; `consolidate merge` requires an explicit
  // human-supplied target/source selection. See
  // add-duplicate-cluster-consolidation.
  consolidation: z.object({
    enabled: z.boolean().default(true),
    // Deliberately below deduplication's tier UPDATE thresholds (0.95/0.9) so
    // consolidation surfaces candidates write-time dedup would not have
    // auto-merged, not just ones it would have.
    similarity_threshold: z.number().min(0).max(1).default(0.9),
    // Per-point neighbor breadth passed to `findNeighborsById`'s topK.
    neighbor_top_k: z.number().int().positive().default(20),
    // Upper bound on memories scanned per `list` call, regardless of how
    // large the namespace/collection is — see design.md "Bounded scan cost".
    max_scan_per_call: z.number().int().positive().default(500),
    // How many `findNeighborsById` ANN queries `consolidate list` runs
    // concurrently while fanning out over the scanned page — bounded so a
    // large page neither serializes one Qdrant round trip at a time (slow)
    // nor fires the whole page's worth of requests at once (unbounded
    // fan-out). See bound-corpus-scale-workflows task 2.5.
    neighbor_discovery_concurrency: z.number().int().positive().default(8),
    // Wall-clock budget for one `list` call's whole neighbor-discovery fan-out
    // (not one individual Qdrant call). Once reached, discovery stops after
    // the in-flight batch completes and the call returns a continuation
    // cursor covering the unscanned remainder instead of blocking until the
    // full page's neighbors are all resolved.
    neighbor_discovery_deadline_ms: z.number().int().positive().default(10_000),
  }).strict().prefault({}),
  resilience: z.object({
    circuit_breaker: z.object({
      failure_threshold: z.number().int().min(1).default(5),
      open_window_ms: z.number().int().min(1000).default(30000),
      half_open_probe_count: z.number().int().min(1).default(1),
    }).strict().prefault({}),
  }).strict().prefault({}),
  search: z.object({
    // Active results retain the caller's limit. Archived matches are an
    // explicitly additive, separately bounded appendix when requested.
    archive_result_limit: z.number().int().min(1).max(50).default(5),
    hybrid_weights: z.object({
      semantic: z.number().min(0).max(1).default(0.7),
      fulltext: z.number().min(0).max(1).default(0.3),
    }).strict().prefault({}),
    // Composite ranking prior applied at result-assembly time:
    // final = relevance × (w_base + w_importance·importance +
    //   w_access·log1p(access_count)/log1p(access_norm)) × exp(-decay_per_day[tier]·age_days)
    // `enabled: false` restores pure-relevance ordering. See add-composite-recall-ranking.
    ranking: z.object({
      enabled: z.boolean().default(true),
      w_importance: z.number().nonnegative().default(0.3),
      w_access: z.number().nonnegative().default(0.2),
      access_norm: z.number().positive().default(50),
      decay_per_day: z.object({
        T0: z.number().nonnegative().default(0),
        T1: z.number().nonnegative().default(0.002),
        T2: z.number().nonnegative().default(0.008),
        T3: z.number().nonnegative().default(0.02),
      }).strict().prefault({}),
    }).strict().prefault({}),
    // Opt-in LLM rerank stage: re-scores `recall`'s candidate pool by sending
    // the query and each candidate's text to a configured LLM, replacing
    // `score` (not `semantic_score`, so `min_score` filtering is unaffected)
    // for successfully-scored candidates. `enabled: false` (default) means
    // `recall` is byte-for-byte unchanged from before this capability
    // existed — no network call, no ordering change. Independent of
    // `pipeline.extraction_model`/`extraction_model_env`: resolves its own
    // `model`/`model_env`. See add-opt-in-rerank-stage.
    rerank: z.object({
      enabled: z.boolean().default(false),
      provider: z.enum(['openai']).default('openai'),
      candidate_pool: z.number().int().min(1).max(50).default(20),
      model: z.string().default('gpt-4o-mini'),
      model_env: z.string().default('BHGBRAIN_RERANK_API_KEY'),
      timeout_ms: z.number().int().positive().default(3000),
    }).strict().prefault({}),
    // Maximal Marginal Relevance diversity reordering applied to `recall`/
    // `search`'s composite-ranked candidate pool (never a truncator — see
    // `add-mmr-diversity-reranking`). `enabled: false` restores
    // composite-relevance-only ordering exactly. `lambda` near 1 approximates
    // pure relevance ordering; near 0 favors dissimilarity among candidates.
    // `candidate_pool_multiplier`/`candidate_pool_cap` widen the pool fetched
    // from the store so there is genuine diversity headroom beyond `limit`.
    mmr: z.object({
      enabled: z.boolean().default(true),
      lambda: z.number().min(0).max(1).default(0.7),
      candidate_pool_multiplier: z.number().positive().default(3),
      candidate_pool_cap: z.number().int().positive().default(50),
    }).strict().prefault({}),
    // Multi-query expansion (add-multi-query-expansion): `semanticSearch` and
    // the semantic leg of `hybridSearch` embed/search more than one
    // representation of the query and merge candidates by id, keeping the
    // max score per id, before scoring/ranking continues. Phase 1 (no
    // model) is default-on: a deterministic keyword-stripped variant is
    // added whenever it differs from the original and is non-empty. Phase 2
    // (LLM paraphrase/HyDE) is opt-in and gated on `llm_paraphrase.enabled`
    // *and* a resolvable extraction API key; any failure degrades silently
    // to the phase-1 variants.
    query_expansion: z.object({
      enabled: z.boolean().default(true),
      // Upper bound on the combined variant count (original + keyword +
      // LLM), independent of `llm_paraphrase.variant_count` — extra LLM
      // variants beyond this cap are dropped, not queued.
      max_variants: z.number().int().min(1).max(5).default(2),
      keyword_stripped: z.boolean().default(true),
      llm_paraphrase: z.object({
        enabled: z.boolean().default(false),
        mode: z.enum(['paraphrase', 'hyde']).default('paraphrase'),
        variant_count: z.number().int().min(1).max(3).default(2),
        // Enforced via AbortController on the chat-completions fetch,
        // mirroring `pipeline.extraction_timeout_ms`.
        timeout_ms: z.number().int().positive().default(3000),
      }).strict().prefault({}),
    }).strict().prefault({}),
  }).strict().prefault({}),
  security: z.object({
    require_loopback_http: z.boolean().default(true),
    allow_unauthenticated_http: z.boolean().default(false),
    log_redaction: z.boolean().default(true),
    rate_limit_rpm: z.number().int().positive().default(100),
    // bound-qdrant-http-runtime task 2.4: hard capacity on the rate limiter's
    // client-bucket map (src/transport/middleware.ts). Without this, a caller
    // that rotates its identity (spoofed X-Forwarded-For under a trust-all
    // proxy setting, or simply many distinct real clients) grows the bucket
    // map without bound. At capacity, a final expired-bucket sweep runs and a
    // genuinely new key is rejected (429) rather than stored — see
    // createRateLimitMiddleware's fail-closed capacity policy.
    rate_limit_max_buckets: z.number().int().positive().default(10_000),
    max_request_size_bytes: z.number().int().positive().default(1048576),
    // Passed directly to Express `app.set('trust proxy', ...)`. Default `false`
    // means `req.ip` is the direct socket peer (loopback-accurate). `true`
    // ("trust every hop") is no longer accepted — it lets a caller-supplied
    // left-most X-Forwarded-For entry choose its own client identity even
    // through exactly one real reverse proxy hop (bound-qdrant-http-runtime
    // task 2.3). Use a positive hop count (the number of trusted reverse
    // proxies between the client and this process) or an explicit array of
    // trusted proxy IPs/subnets instead — both are passed straight through to
    // Express/`proxy-addr`, which resolves `req.ip` to the right-most
    // untrusted address rather than the caller-controlled left-most one.
    trust_proxy: z.preprocess((val, ctx) => {
      if (val === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'security.trust_proxy: boolean `true` (trust every hop) is no longer supported — it lets ' +
            'a caller-supplied X-Forwarded-For value choose its own client identity. Set it to a positive hop ' +
            'count (e.g. 1 for exactly one trusted reverse proxy) or an array of trusted proxy IPs/subnets ' +
            '(e.g. ["10.0.0.0/8"]) instead.',
        });
        return z.NEVER;
      }
      return val;
    }, z.union([
      z.literal(false),
      z.number().int().positive(),
      z.array(z.string().min(1)).min(1),
    ])).default(false),
  }).strict().prefault({}),
  auto_inject: z.object({
    max_chars: z.number().int().positive().default(30000),
    max_tokens: z.number().int().positive().nullable().default(null),
    // Fraction of the inject budget reserved for the memory section so category
    // content can no longer consume the entire budget before a memory is
    // injected (see relevance-conditioned-inject). 0 restores the pre-existing
    // "categories can starve memories" behavior.
    memory_budget_fraction: z.number().min(0).max(1).default(0.4),
    // 'tokens' scales the char budget by a chars/4 estimate (no tokenizer
    // dependency); 'chars' (default) is byte-for-byte identical to the
    // pre-existing budget arithmetic.
    budget_unit: z.enum(['chars', 'tokens']).default('chars'),
    // Greedy near-duplicate suppression within the hint-selected memory
    // section, reusing `deduplication.similarity_threshold`.
    dedup_suppression: z.boolean().default(true),
    // Kill switch for the pinned-memory inject step (add-inject-pinning):
    // `false` skips it entirely, leaving both inject templates behaving as
    // if no memory were pinned. The pin cap is still enforced at write time
    // regardless of this switch.
    pinned_enabled: z.boolean().default(true),
  }).strict().prefault({}),
  observability: z.object({
    metrics_enabled: z.boolean().default(false),
    structured_logging: z.boolean().default(true),
    log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }).strict().prefault({}),
  pipeline: z.object({
    // Default is `false`: this flag was previously live configuration that
    // had zero effect (extraction was always deterministic single-candidate).
    // Now that it actually gates an LLM call, every existing install would
    // silently start spending on extraction if this defaulted on — see
    // add-multi-candidate-extraction proposal.
    extraction_enabled: z.boolean().default(false),
    extraction_model: z.string().default('gpt-4o-mini'),
    extraction_model_env: z.string().default('BHGBRAIN_EXTRACTION_API_KEY'),
    // Cost/latency bounds for the extraction LLM call (add-multi-candidate-extraction).
    // Content shorter than this skips the LLM call entirely and goes straight
    // to single-candidate extraction.
    extraction_min_chars: z.number().int().nonnegative().default(120),
    // Candidates beyond this cap are dropped (not merged) and logged/counted.
    extraction_max_candidates: z.number().int().positive().default(6),
    // Enforced via AbortController on the chat-completions fetch.
    extraction_timeout_ms: z.number().int().positive().default(4000),
    fallback_to_threshold_dedup: z.boolean().default(true),
    // `remember` rejects content longer than this (add-long-content-chunking) —
    // long unsplit text embeds as one low-quality "mush vector"; callers should
    // use `import` with `format: "freeform"` instead, which chunks by heading/
    // paragraph boundaries and embeds each chunk independently. Capped at the
    // `remember` content schema's own ceiling (`ContentSchema.max(100000)` in
    // `src/domain/schemas.ts`) since a threshold above that can never trigger.
    long_content_threshold_chars: z.number().int().positive().max(100000).default(8000),
    // Opt-in LLM entailment check for UPDATE-band writes that don't already
    // trip the regex-based `detectsInvalidation` fast path (see
    // `add-contradiction-detection`). Reuses `extraction_model` /
    // `extraction_model_env` above for the model name and API key env var —
    // deliberately no parallel model/credential fields here.
    contradiction_detection: z.object({
      enabled: z.boolean().default(false),
      timeout_ms: z.number().int().positive().default(5000),
    }).strict().prefault({}),
    // Optional LLM-backed summarization tier (improve-memory-summarization).
    // Default `false`: this is a new external call with cost/latency
    // implications, unlike `auto_summarize` (which gates the free extractive
    // tier and defaults on). Mirrors `extraction_model`/`extraction_model_env`
    // in shape; defaults to the same env var as extraction since both are
    // cheap-model write-path calls against the same OpenAI account.
    summarization_enabled: z.boolean().default(false),
    summarization_model: z.string().default('gpt-4o-mini'),
    summarization_model_env: z.string().default('BHGBRAIN_EXTRACTION_API_KEY'),
    // Enforced via AbortController on the chat-completions fetch.
    summarization_timeout_ms: z.number().positive().default(3000),
    // Deterministic, dependency-free content tagging (add-auto-tagging):
    // `WritePipeline.extract()` derives additional tags from code-shaped
    // tokens, file paths, repo shorthand, and @-mentions in the normalized
    // content, unioned with any caller-supplied tags. `false` restores
    // today's pass-through behavior exactly (candidate tags identical to
    // `input.tags`).
    auto_tag_enabled: z.boolean().default(true),
    // Cap on auto-derived tags added per memory (before merging with
    // caller-supplied tags and trimming to the 20-tag `TagsSchema` cap).
    auto_tag_max_per_memory: z.number().int().min(0).max(20).default(6),
    // Per-source default for `MemoryRecord.confidence` when a `remember`
    // call omits it — operationalizes "explicit user statement > agent
    // inference" without requiring every caller to compute a value.
    // `distillation` isn't listed: `WritePipeline.decide` falls back to 1.0
    // for that source (a distilled memory consolidates already-trusted
    // sources, so full confidence is the reasonable default) rather than
    // indexing this map with a key it doesn't have.
    // See add-memory-provenance-metadata.
    default_confidence: z.object({
      cli: z.number().min(0).max(1).default(1.0),
      api: z.number().min(0).max(1).default(1.0),
      agent: z.number().min(0).max(1).default(0.7),
      import: z.number().min(0).max(1).default(0.5),
    }).strict().prefault({}),
  }).strict().prefault({}),
  // Bounds on the `import` tool's output amplification (bound-corpus-scale-
  // workflows task 3.1/3.2): a parsed document can otherwise turn into an
  // unbounded number of embed/write calls (many tiny paragraphs) or a
  // too-large single chunk (one huge unsplit section) that degrades into a
  // permanently unsyncable row. See design.md Decision #5.
  import: z.object({
    // Upper bound on memories one `import` call may create (after any
    // oversized-chunk splitting below has already run — it is the resulting
    // chunk count that bounds outbound provider calls, not the
    // pre-split parse). Exceeded -> rejected up front with the observed
    // count and this maximum, before any provider call is made.
    max_chunks: z.number().int().positive().default(500),
    // A parsed chunk longer than this is deterministically hard-split into
    // max_chunk_chars-sized pieces (last piece shorter) rather than embedded
    // as one oversized "mush vector" or rejected outright — every piece
    // still gets a chance to become a memory. Matches
    // `pipeline.long_content_threshold_chars`'s default so a `remember` call
    // and an `import` chunk hit the same practical size ceiling.
    max_chunk_chars: z.number().int().positive().default(8000),
    // How many chunks' embeddings `import` requests from the embedding
    // provider in one `embedBatch` call, so outbound request count scales
    // with chunk-count/batch-size rather than 1:1 with chunk count. Capped
    // in practice by `embedding.max_batch_inputs` (the provider's own
    // per-request cap) — import does not validate this against that field
    // directly since a value above it still works, just via more retries at
    // the request layer; operators tuning both together should keep this at
    // or below it.
    embedding_batch_size: z.number().int().positive().default(100),
  }).strict().prefault({}),
  // Controls whether summarization quality tiers (extractive, or LLM when
  // `pipeline.summarization_enabled`) apply. `true` (default): tiered
  // summarizer. `false`: literal first-line truncation (`generateSummary`),
  // regardless of `pipeline.summarization_enabled`. See
  // improve-memory-summarization.
  auto_summarize: z.boolean().default(true),
}).strict().superRefine((config, ctx) => {
  const schedules: Array<{ path: ['retention', 'cleanup_schedule'] | ['retention', 'distillation', 'schedule']; value: string }> = [
    { path: ['retention', 'cleanup_schedule'], value: config.retention.cleanup_schedule },
    { path: ['retention', 'distillation', 'schedule'], value: config.retention.distillation.schedule },
  ];
  for (const schedule of schedules) {
    try {
      nextRunAfter(parseCronExpression(schedule.value), new Date());
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: schedule.path,
        message: `Invalid satisfiable cron expression: ${(err as Error).message}`,
      });
    }
  }
});

export type BrainConfig = z.infer<typeof ConfigSchema>;
export type ResilienceConfig = BrainConfig['resilience'];

export function getDefaultDataDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
    return join(localAppData, 'BHGBrain');
  }
  return join(process.env.HOME ?? '~', '.bhgbrain');
}

export function getDefaultConfigPath(): string {
  return join(getDefaultDataDir(), 'config.json');
}

/**
 * Formats a config validation failure with the source file path attached, so
 * an operator immediately knows *which* file to fix — not just which field
 * (align-runtime-entrypoint-contracts task 1.1). `ZodError.message` is
 * preserved verbatim inside the wrapped message (it already carries each
 * issue's field path and reason as structured JSON) rather than
 * reformatted, so this stays a strict superset of the pre-existing
 * field-path-only error text.
 */
function formatConfigParseError(path: string, err: z.ZodError, context?: string): Error {
  const suffix = context ? ` (${context})` : '';
  return new Error(`Invalid configuration in ${path}${suffix}:\n${err.message}`, { cause: err });
}

/**
 * Reads and strictly parses `config.json` at `path` — no environment overlay
 * applied. This is the *raw file* value: the one thing that is ever safe to
 * write back to disk (see `ensureDataDir`), since it has never been mutated
 * by a `BHGBRAIN_*` runtime override (task 1.2 — env overrides must never
 * be persisted as user configuration). An unknown key or an invalid URL/
 * port/boolean/schedule fails with both the file path and the field path
 * (task 1.1).
 */
function parseConfigFile(path: string): BrainConfig {
  let raw: Record<string, unknown> = {};

  if (existsSync(path)) {
    const text = readFileSync(path, 'utf-8');
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`Failed to parse ${path} as JSON: ${(err as Error).message}`, { cause: err });
    }
  }

  let config: BrainConfig;
  try {
    config = ConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw formatConfigParseError(path, err);
    }
    throw err;
  }

  if (!config.data_dir) {
    config.data_dir = getDefaultDataDir();
  }

  return config;
}

/**
 * Reads and strictly parses `config.json` with no environment overlay
 * applied — the raw, file-only value. Callers that need to persist config
 * changes back to disk (currently only `ensureDataDir`'s device-id
 * resolution) MUST use this, never `loadConfig`'s overlaid result, or a
 * temporary `BHGBRAIN_*` override would be written into the user's
 * `config.json` as if it were a permanent choice (task 1.2).
 */
export function loadFileConfig(configPath?: string): BrainConfig {
  const path = configPath ?? getDefaultConfigPath();
  return parseConfigFile(path);
}

/**
 * Applies typed `BHGBRAIN_*` environment overrides to a **copy** of
 * `fileConfig` and revalidates the result against the same strict schema
 * (design.md decision 4) — the input object is never mutated, so it stays
 * safe for a caller to persist afterward. `sourcePath` is used only to
 * label a revalidation failure.
 */
export function deriveRuntimeConfig(fileConfig: BrainConfig, sourcePath?: string): BrainConfig {
  const overlay = structuredClone(fileConfig);
  applyEnvOverrides(overlay);
  try {
    return ConfigSchema.parse(overlay);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw formatConfigParseError(sourcePath ?? getDefaultConfigPath(), err, 'after applying environment overrides');
    }
    throw err;
  }
}

/**
 * Convenience one-shot: parse the file, then apply the environment overlay
 * on top of a copy. This is what most read-only callers want (embedding,
 * transport, search, etc. all consume the resulting *runtime* config).
 * Callers that also need to persist changes back to `config.json` — i.e.
 * `main()`/CLI startup — must instead call `loadFileConfig` +
 * `ensureDataDir` + `deriveRuntimeConfig` separately, so persistence only
 * ever touches the raw file value (task 1.2).
 */
export function loadConfig(configPath?: string): BrainConfig {
  const path = configPath ?? getDefaultConfigPath();
  const fileConfig = parseConfigFile(path);
  return deriveRuntimeConfig(fileConfig, path);
}

/**
 * Override config values from BHGBRAIN_* environment variables.
 * Env vars take precedence over file-based config — the expected
 * behavior when running inside a Docker container.
 */
export function applyEnvOverrides(config: BrainConfig): void {
  const env = process.env;

  if (env.BHGBRAIN_DATA_DIR) {
    config.data_dir = env.BHGBRAIN_DATA_DIR;
  }

  if (env.BHGBRAIN_HTTP_HOST) {
    config.transport.http.host = env.BHGBRAIN_HTTP_HOST;
  }

  if (env.BHGBRAIN_HTTP_PORT) {
    const port = parseInt(env.BHGBRAIN_HTTP_PORT, 10);
    if (!Number.isNaN(port)) {
      config.transport.http.port = port;
    }
  }

  if (env.BHGBRAIN_QDRANT_MODE) {
    const mode = env.BHGBRAIN_QDRANT_MODE;
    if (mode === 'embedded' || mode === 'external') {
      config.qdrant.mode = mode;
    }
  }

  if (env.BHGBRAIN_QDRANT_URL) {
    config.qdrant.external_url = env.BHGBRAIN_QDRANT_URL;
  }

  if (env.BHGBRAIN_REQUIRE_LOOPBACK) {
    config.security.require_loopback_http = env.BHGBRAIN_REQUIRE_LOOPBACK === 'true';
  }

  if (env.BHGBRAIN_ALLOW_UNAUTHENTICATED) {
    config.security.allow_unauthenticated_http = env.BHGBRAIN_ALLOW_UNAUTHENTICATED === 'true';
  }

  if (env.BHGBRAIN_LOG_LEVEL) {
    const level = env.BHGBRAIN_LOG_LEVEL;
    if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
      config.observability.log_level = level;
    }
  }
}

/**
 * Sanitize a string for use as a device_id by lowercasing and replacing
 * invalid characters with hyphens, then trimming to 64 characters.
 *
 * Truncation happens *after* leading-hyphen collapse but *before* trailing-
 * hyphen removal: slicing a long hostname to 64 chars can itself land on a
 * hyphen, so the trailing strip must run last or a truncated id could still
 * end in `-`.
 */
function sanitizeDeviceId(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '');
  const truncated = normalized.slice(0, 64).replace(/-+$/, '');
  return truncated || 'unknown';
}

/**
 * Resolve the device_id using the priority chain:
 * 1. BHGBRAIN_DEVICE_ID environment variable — matches the project-wide
 *    contract that `BHGBRAIN_*` env overrides always win over persisted
 *    `config.json` values, including on devices where a device_id was
 *    already resolved and saved on a previous run.
 * 2. config.device.id (explicit / previously persisted)
 * 3. os.hostname() (lowercased, sanitized)
 *
 * Mutates config.device.id with the resolved value.
 */
export function resolveDeviceId(config: BrainConfig): string {
  const envId = process.env.BHGBRAIN_DEVICE_ID;
  if (envId && DEVICE_ID_RE.test(envId)) {
    config.device.id = envId;
    return envId;
  }

  if (config.device.id) {
    return config.device.id;
  }

  const hostId = sanitizeDeviceId(hostname());
  config.device.id = hostId;
  return hostId;
}

/**
 * `ensureDataDir` must create the *actual* runtime data directory even
 * though it otherwise only ever touches the raw file config (task 1.2) —
 * `BHGBRAIN_DATA_DIR` is exactly the mechanism a container deployment uses
 * to redirect storage onto a mounted volume, and that directory has to
 * exist before `SqliteStore` opens it. Reading the env var directly here
 * (rather than accepting the overlaid runtime config as a second
 * parameter) keeps `ensureDataDir`'s contract to a single config object —
 * the one instance it is safe to persist — while still creating the right
 * directory.
 */
function resolveRuntimeDataDir(fileConfig: BrainConfig): string {
  return process.env.BHGBRAIN_DATA_DIR || fileConfig.data_dir || getDefaultDataDir();
}

/**
 * Creates the data directory (and `backups/`) and persists `config` — which
 * MUST be the raw file-level config from `loadFileConfig`, never
 * `loadConfig`'s environment-overlaid result — back to `config.json`. Only
 * `device.id` resolution is ever mutated/persisted here; every
 * `BHGBRAIN_*` runtime override lives solely on the derived runtime config
 * a caller builds afterward via `deriveRuntimeConfig`, so a temporary
 * override (a security toggle, a credential-bearing Qdrant URL, an
 * alternate data dir) can never leak into the persisted file
 * (align-runtime-entrypoint-contracts task 1.2).
 */
export function ensureDataDir(config: BrainConfig): void {
  const dir = resolveRuntimeDataDir(config);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'backups'), { recursive: true });

  const configPath = join(dir, 'config.json');
  const configFileExisted = existsSync(configPath);
  const previousDeviceId = config.device.id;

  // Resolve device identity (env override, persisted value, or a fresh
  // hostname-derived id).
  resolveDeviceId(config);

  // Only rewrite config.json when there is something new to persist: the
  // file doesn't exist yet, or resolution actually changed device.id (a
  // freshly synthesized id, or BHGBRAIN_DEVICE_ID overriding a persisted
  // value). A steady-state boot with an unchanged, already-persisted id
  // performs no write, so user formatting/comments in config.json survive
  // and startup avoids a needless disk write.
  if (!configFileExisted || config.device.id !== previousDeviceId) {
    atomicWriteFileSync(configPath, JSON.stringify(config, null, 2));
  }
}
