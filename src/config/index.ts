import { z } from 'zod';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';

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
});

const ConfigSchema = z.object({
  data_dir: z.string().optional(),
  device: z.object({
    id: z.string().regex(DEVICE_ID_RE).optional(),
  }).default({}),
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
    // Guards against silently mixing embedding spaces: when the store's
    // persisted expected embedding identity (see embedding-provenance)
    // differs from the active configuration, vector-producing writes fail
    // with an actionable error instead of writing vectors from a different
    // model into the same collection. Disable only if you intentionally
    // want to mix spaces (e.g. a deliberate, monitored migration window).
    refuse_writes_on_model_mismatch: z.boolean().default(true),
  }).superRefine((value, ctx) => {
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
  }).default({}),
  qdrant: z.object({
    mode: z.enum(['embedded', 'external']).default('embedded'),
    embedded_path: z.string().default('./qdrant'),
    external_url: z.string().nullable().default(null),
    api_key_env: z.string().nullable().default(null),
  }).default({}),
  transport: z.object({
    http: z.object({
      enabled: z.boolean().default(true),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(3721),
      bearer_token_env: z.string().default('BHGBRAIN_TOKEN'),
    }).default({}),
    stdio: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
  }).default({}),
  defaults: z.object({
    namespace: z.string().default('global'),
    collection: z.string().default('general'),
    recall_limit: z.number().int().min(1).max(20).default(5),
    min_score: z.number().min(0).max(1).default(0.6),
    auto_inject_limit: z.number().int().min(1).default(10),
    max_response_chars: z.number().int().positive().default(50000),
  }).default({}),
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
    }).default({}),
    tier_budgets: z.object({
      T0: z.null().default(null),
      T1: z.number().int().positive().default(100000),
      T2: z.number().int().positive().default(200000),
      T3: z.number().int().positive().default(200000),
    }).default({}),
    auto_promote_access_threshold: z.number().int().positive().default(5),
    sliding_window_enabled: z.boolean().default(true),
    archive_before_delete: z.boolean().default(true),
    cleanup_schedule: z.string().default('0 2 * * *'),
    scheduled_cleanup_enabled: z.boolean().default(true),
    pre_expiry_warning_days: z.number().int().nonnegative().default(7),
    compaction_deleted_threshold: z.number().min(0).max(1).default(0.10),
  }).default({}),
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
  }).default({}),
  resilience: z.object({
    circuit_breaker: z.object({
      failure_threshold: z.number().int().min(1).default(5),
      open_window_ms: z.number().int().min(1000).default(30000),
      half_open_probe_count: z.number().int().min(1).default(1),
    }).default({}),
  }).default({}),
  search: z.object({
    hybrid_weights: z.object({
      semantic: z.number().min(0).max(1).default(0.7),
      fulltext: z.number().min(0).max(1).default(0.3),
    }).default({}),
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
      }).default({}),
    }).default({}),
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
    }).default({}),
  }).default({}),
  security: z.object({
    require_loopback_http: z.boolean().default(true),
    allow_unauthenticated_http: z.boolean().default(false),
    log_redaction: z.boolean().default(true),
    rate_limit_rpm: z.number().int().positive().default(100),
    max_request_size_bytes: z.number().int().positive().default(1048576),
    // Passed directly to Express `app.set('trust proxy', ...)`. Default `false`
    // means `req.ip` is the direct socket peer (loopback-accurate); enable only
    // behind a trusted reverse proxy that sets `X-Forwarded-For` correctly.
    trust_proxy: z.boolean().default(false),
  }).default({}),
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
  }).default({}),
  observability: z.object({
    metrics_enabled: z.boolean().default(false),
    structured_logging: z.boolean().default(true),
    log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }).default({}),
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
    }).default({}),
  }).default({}),
  auto_summarize: z.boolean().default(true),
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

export function loadConfig(configPath?: string): BrainConfig {
  const path = configPath ?? getDefaultConfigPath();
  let raw: Record<string, unknown> = {};

  if (existsSync(path)) {
    const text = readFileSync(path, 'utf-8');
    raw = JSON.parse(text);
  }

  const config = ConfigSchema.parse(raw);

  if (!config.data_dir) {
    config.data_dir = getDefaultDataDir();
  }

  applyEnvOverrides(config);

  return config;
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

export function ensureDataDir(config: BrainConfig): void {
  const dir = config.data_dir!;
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
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }
}
