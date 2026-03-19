#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, ensureDataDir } from './config/index.js';
import { SqliteStore } from './storage/sqlite.js';
import { QdrantStore } from './storage/qdrant.js';
import { StorageManager } from './storage/index.js';
import { createEmbeddingProvider } from './embedding/index.js';
import { WritePipeline } from './pipeline/index.js';
import { SearchService } from './search/index.js';
import { BackupService } from './backup/index.js';
import { HealthService } from './health/index.js';
import { MetricsCollector } from './health/metrics.js';
import { createLogger } from './health/logger.js';
import { ResourceHandler, MCP_RESOURCE_DEFINITIONS, MCP_RESOURCE_TEMPLATES } from './resources/index.js';
import { handleTool, type ToolContext } from './tools/index.js';
import { MCP_TOOL_DEFINITIONS } from './tools/schemas.js';
import { createHttpServer } from './transport/http.js';

async function main() {
  const args = process.argv.slice(2);
  const isStdio = args.includes('--stdio');
  const configPath = args.find(a => a.startsWith('--config='))?.split('=')[1];

  const config = loadConfig(configPath);
  ensureDataDir(config);

  // When using stdio transport, pino must write to stderr — stdout is reserved for MCP JSON-RPC
  const logger = createLogger(config, isStdio ? process.stderr : undefined);
  logger.info({ event: 'startup', data_dir: config.data_dir });

  // Initialize storage
  const sqlite = new SqliteStore(config.data_dir!);
  await sqlite.init();

  const metrics = new MetricsCollector(config);
  const qdrant = new QdrantStore(config);
  const embedding = createEmbeddingProvider(config, { metrics });
  const storage = new StorageManager(sqlite, qdrant, embedding);

  // Initialize services
  const pipeline = new WritePipeline(config, storage, embedding);
  const searchService = new SearchService(config, storage, embedding, metrics);
  const backupService = new BackupService(config, storage, logger);
  const healthService = new HealthService(storage, embedding, config);

  const ctx: ToolContext = {
    config, storage, embedding, pipeline,
    search: searchService, backup: backupService,
    health: healthService, metrics, logger,
  };

  const resources = new ResourceHandler(config, storage, searchService, healthService);

  if (isStdio || !config.transport.http.enabled) {
    // MCP stdio transport
    const server = new Server(
      { name: 'bhgbrain', version: '1.0.0' },
      { capabilities: { tools: {}, resources: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: MCP_TOOL_DEFINITIONS,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: toolArgs } = request.params;
      const result = await handleTool(ctx, name, toolArgs);

      // Detect error envelopes and signal via MCP isError
      const isError = result != null && typeof result === 'object' && 'error' in (result as any);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        ...(isError ? { isError: true } : {}),
      };
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: MCP_RESOURCE_DEFINITIONS.map(r => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: 'application/json',
      })),
    }));

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: MCP_RESOURCE_TEMPLATES.map(r => ({
        uriTemplate: r.uriTemplate,
        name: r.name,
        description: r.description,
        mimeType: 'application/json',
      })),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const result = await resources.handle(uri);
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(result, null, 2),
        }],
      };
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info({ event: 'connected', transport: 'stdio' });
  } else {
    // HTTP transport
    const app = createHttpServer(config, ctx, resources, logger);
    const { host, port } = config.transport.http;

    app.listen(port, host, () => {
      logger.info({ event: 'listening', transport: 'http', host, port });
      console.log(`BHGBrain server listening on http://${host}:${port}`);
    });
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
