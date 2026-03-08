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
} from './middleware.js';
import type pino from 'pino';

export function createHttpServer(
  config: BrainConfig,
  ctx: ToolContext,
  resources: ResourceHandler,
  logger: pino.Logger,
) {
  validateLoopbackBinding(config);
  validateExternalAuthBinding(config, logger);

  const app = express();

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
    const clientId = req.headers['x-client-id'] as string ?? 'http-client';
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
      const metrics = ctx.metrics.getMetrics();
      const lines = metrics.map(m => `${m.name} ${m.value}`);
      res.type('text/plain').send(lines.join('\n'));
    });
  }

  return app;
}
