/**
 * Local development server — wraps each MCP server in a simple Express app
 * so you can hit http://localhost:3000/{service} with MCP Streamable HTTP clients.
 *
 * Uses environment variables for credentials instead of Secrets Manager.
 * See .env.example for required variables.
 */

import 'dotenv/config';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { parseServiceKey, resolveServer } from './router.js';
import { logger } from './logger.js';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// Handle all POST routes — the path is parsed inside resolveServer
app.post('/:service*', async (req, res) => {
  const path = req.path;
  logger.info('local: incoming request', { method: req.method, path });

  let serviceKey: ReturnType<typeof parseServiceKey>;
  try {
    serviceKey = parseServiceKey(path);
  } catch {
    res.status(404).json({ error: 'Not found', validPaths: ['/hubspot', '/gdrive', '/gcal', '/analytics', '/gcse', '/stripe'] });
    return;
  }

  let server: Awaited<ReturnType<typeof resolveServer>>;
  try {
    server = await resolveServer(serviceKey);
  } catch (err) {
    logger.error('local: failed to resolve server', { service: serviceKey, err: String(err) });
    res.status(500).json({ error: 'Failed to initialise service' });
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  try {
    await transport.handleRequest(req, res, req.body);
  } finally {
    res.on('close', async () => {
      await transport.close();
      await server.close();
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', services: ['hubspot', 'gdrive', 'gcal', 'analytics', 'gcse', 'stripe'] });
});

app.listen(PORT, () => {
  logger.info(`local dev server running on http://localhost:${PORT}`);
  logger.info('available routes', {
    routes: ['/hubspot', '/gdrive', '/gcal', '/analytics', '/gcse', '/stripe'].map(p => `POST http://localhost:${PORT}${p}`),
  });
});
