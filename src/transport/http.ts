import express from 'express';
import type { BrainConfig } from '../config/index.js';
import type { ToolContext } from '../tools/index.js';
import { handleTool } from '../tools/index.js';
import { ResourceHandler } from '../resources/index.js';
import {
  createAuthMiddleware,
  createRateLimitMiddleware,
  createSizeLimitMiddleware,
  validateLoopbackBinding,
  validateExternalAuthBinding,
  deriveTrustedClientId,
} from './middleware.js';
import type { MetricEntry } from '../health/metrics.js';
import type pino from 'pino';

// Prometheus text-exposition label-value escaping: backslash, then quote,
// then newline (order matters so a literal backslash isn't re-escaped).
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return '';
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const pairs = keys.map(k => `${k}="${escapeLabelValue(labels[k]!)}"`);
  return `{${pairs.join(',')}}`;
}

/**
 * Renders metrics in Prometheus text-exposition form: a `# TYPE` line once
 * per metric name, followed by `name{label="value",...} value` lines (the
 * `{...}` segment omitted when a metric has no labels). Additive relative to
 * the prior plain `name value` output — unlabeled lines are unchanged.
 */
export function renderPrometheusText(metrics: MetricEntry[]): string {
  const lines: string[] = [];
  const typedNames = new Set<string>();

  for (const m of metrics) {
    if (!typedNames.has(m.name)) {
      lines.push(`# TYPE ${m.name} ${m.type}`);
      typedNames.add(m.name);
    }
    lines.push(`${m.name}${formatLabels(m.labels)} ${m.value}`);
  }

  return lines.join('\n');
}

export function createHttpServer(
  config: BrainConfig,
  ctx: ToolContext,
  resources: ResourceHandler,
  logger: pino.Logger,
) {
  validateLoopbackBinding(config);
  validateExternalAuthBinding(config, logger);

  const app = express();

  // Controls how `req.ip` / `req.ips` are derived from `X-Forwarded-For`.
  // Default `false` means the direct socket peer is used (loopback-accurate);
  // enable only behind a trusted reverse proxy that sets forwarding headers.
  app.set('trust proxy', config.security.trust_proxy);

  app.use(express.json({ limit: config.security.max_request_size_bytes }));

  // Health endpoint (no auth required)
  app.get('/health', async (_req, res) => {
    const health = await ctx.health.check();
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(health);
  });

  // Apply middleware
  app.use(createAuthMiddleware(config, logger));
  app.use(createRateLimitMiddleware(config, logger, ctx.metrics));
  app.use(createSizeLimitMiddleware(config));

  // Tool endpoint
  app.post('/tool/:name', async (req, res) => {
    // Audit/log client identity is derived from the authenticated principal
    // (`req.ip`, subject to the `trust proxy` setting above) — the same
    // trusted source the rate limiter keys on — never from the
    // caller-supplied `x-client-id` header, which is fully spoofable and is
    // not used to identify the caller for audit purposes. See
    // `add-operations-security-reliability` audit follow-up 2026-06-05,
    // task 4.4.
    const clientId = deriveTrustedClientId(req) ?? 'http-client';
    const result = await handleTool(ctx, req.params.name, req.body, clientId);
    res.json(result);
  });

  // Resource endpoint
  app.get('/resource', async (req, res) => {
    const uri = req.query.uri as string;
    if (!uri) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'uri query parameter required', retryable: false } });
      return;
    }
    const result = await resources.handle(uri);
    res.json(result);
  });

  // Metrics endpoint (if enabled)
  if (config.observability.metrics_enabled) {
    app.get('/metrics', (_req, res) => {
      // Histogram families emit `_avg`, `_p50`, `_p95`, `_p99`, and `_count` lines.
      const metrics = ctx.metrics.getMetrics();
      res.type('text/plain').send(renderPrometheusText(metrics));
    });
  }

  return app;
}
