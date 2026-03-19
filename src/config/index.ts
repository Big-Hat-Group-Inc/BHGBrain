import { z } from 'zod';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';

const DEVICE_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

const ConfigSchema = z.object({
  data_dir: z.string().optional(),
  device: z.object({
    id: z.string().regex(DEVICE_ID_RE).optional(),
  }).default({}),
  embedding: z.object({
    provider: z.enum(['openai']).default('openai'),
    model: z.string().default('text-embedding-3-small'),
    api_key_env: z.string().default('OPENAI_API_KEY'),
    dimensions: z.number().int().positive().default(1536),
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
    pre_expiry_warning_days: z.number().int().nonnegative().default(7),
    compaction_deleted_threshold: z.number().min(0).max(1).default(0.10),
  }).default({}),
  deduplication: z.object({
    enabled: z.boolean().default(true),
    similarity_threshold: z.number().min(0).max(1).default(0.92),
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
  }).default({}),
  security: z.object({
    require_loopback_http: z.boolean().default(true),
    allow_unauthenticated_http: z.boolean().default(false),
    log_redaction: z.boolean().default(true),
    rate_limit_rpm: z.number().int().positive().default(100),
    max_request_size_bytes: z.number().int().positive().default(1048576),
  }).default({}),
  auto_inject: z.object({
    max_chars: z.number().int().positive().default(30000),
    max_tokens: z.number().int().positive().nullable().default(null),
  }).default({}),
  observability: z.object({
    metrics_enabled: z.boolean().default(false),
    structured_logging: z.boolean().default(true),
    log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }).default({}),
  pipeline: z.object({
    extraction_enabled: z.boolean().default(true),
    extraction_model: z.string().default('gpt-4o-mini'),
    extraction_model_env: z.string().default('BHGBRAIN_EXTRACTION_API_KEY'),
    fallback_to_threshold_dedup: z.boolean().default(true),
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

  return config;
}

/**
 * Sanitize a string for use as a device_id by lowercasing and replacing
 * invalid characters with hyphens, then trimming to 64 characters.
 */
function sanitizeDeviceId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'unknown';
}

/**
 * Resolve the device_id using the priority chain:
 * 1. config.device.id (explicit)
 * 2. BHGBRAIN_DEVICE_ID environment variable
 * 3. os.hostname() (lowercased, sanitized)
 *
 * Mutates config.device.id with the resolved value.
 */
export function resolveDeviceId(config: BrainConfig): string {
  if (config.device.id) {
    return config.device.id;
  }

  const envId = process.env.BHGBRAIN_DEVICE_ID;
  if (envId && DEVICE_ID_RE.test(envId)) {
    config.device.id = envId;
    return envId;
  }

  const hostId = sanitizeDeviceId(hostname());
  config.device.id = hostId;
  return hostId;
}

export function ensureDataDir(config: BrainConfig): void {
  const dir = config.data_dir!;
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'backups'), { recursive: true });

  // Resolve device identity and persist to config.json
  resolveDeviceId(config);

  const configPath = join(dir, 'config.json');
  // Always write config to persist resolved device_id on first run
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
