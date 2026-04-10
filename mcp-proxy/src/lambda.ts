/**
 * Lambda entry point.
 *
 * Architecture:
 *   API Gateway HTTP API → Lambda → StreamableHTTPServerTransport → MCP server
 *
 * Transport: MCP Streamable HTTP (stateless, request/response only — no SSE).
 * Each Lambda invocation handles one MCP message (initialize or tool call).
 *
 * Route format: POST /{service}  (e.g., POST /hubspot)
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { IncomingMessage, ServerResponse } from 'http';
import { Readable, Writable } from 'stream';
import { parseServiceKey, resolveServer } from './router.js';
import { logger } from './logger.js';

/**
 * Convert an API Gateway HTTP API v2 event into a Node.js IncomingMessage.
 * The MCP SDK's StreamableHTTPServerTransport expects IncomingMessage / ServerResponse.
 */
function eventToIncomingMessage(event: APIGatewayProxyEventV2): IncomingMessage {
  const body = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    : '';

  const readable = Readable.from([body]);
  const req = Object.assign(readable, {
    method: event.requestContext.http.method,
    url: event.rawPath + (event.rawQueryString ? `?${event.rawQueryString}` : ''),
    headers: Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    ),
    socket: { remoteAddress: event.requestContext.http.sourceIp },
  }) as unknown as IncomingMessage;

  return req;
}

/**
 * Create a Node.js ServerResponse shim that captures output into a buffer.
 * We collect headers and body chunks then build the API Gateway response.
 */
interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function createResponseCapture(): { res: ServerResponse; getCapture: () => Promise<CapturedResponse> } {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];

  const writable = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });

  // Minimal shim — only the subset the MCP transport uses
  const res = Object.assign(writable, {
    statusCode: 200,
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    },
    getHeader(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
    writeHead(code: number, hdrs?: Record<string, string | string[]>) {
      statusCode = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
        }
      }
      return res;
    },
    end(chunk?: Buffer | string) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      writable.end();
      return res;
    },
  }) as unknown as ServerResponse;

  const getCapture = (): Promise<CapturedResponse> =>
    new Promise(resolve => {
      writable.on('finish', () => {
        resolve({
          statusCode,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      // If already finished (synchronous end)
      if (writable.writableEnded) {
        resolve({
          statusCode,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      }
    });

  return { res, getCapture };
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  _context: Context
): Promise<APIGatewayProxyStructuredResultV2> => {
  const requestId = event.requestContext.requestId;
  logger.info('lambda: incoming request', {
    requestId,
    method: event.requestContext.http.method,
    path: event.rawPath,
  });

  // ─── Parse service from path ──────────────────────────────────────────────
  let serviceKey: ReturnType<typeof parseServiceKey>;
  try {
    serviceKey = parseServiceKey(event.rawPath);
  } catch (err) {
    logger.warn('lambda: unknown route', { path: event.rawPath, err: String(err) });
    return {
      statusCode: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Not found', message: String(err) }),
    };
  }

  // ─── Resolve MCP server (loads credentials) ───────────────────────────────
  let server: Awaited<ReturnType<typeof resolveServer>>;
  try {
    server = await resolveServer(serviceKey);
  } catch (err) {
    logger.error('lambda: failed to resolve server', { service: serviceKey, err: String(err) });
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', message: 'Failed to initialise service' }),
    };
  }

  // ─── Build transport and handle request ───────────────────────────────────
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session persistence
  });

  await server.connect(transport);

  const req = eventToIncomingMessage(event);
  const { res, getCapture } = createResponseCapture();

  // Parse body for the transport
  const bodyStr = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    : undefined;

  const parsedBody = bodyStr ? JSON.parse(bodyStr) : undefined;

  try {
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    logger.error('lambda: transport error', { service: serviceKey, err: String(err) });
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  } finally {
    await transport.close();
    await server.close();
  }

  const captured = await getCapture();

  logger.info('lambda: response sent', {
    requestId,
    service: serviceKey,
    statusCode: captured.statusCode,
  });

  return {
    statusCode: captured.statusCode,
    headers: {
      'content-type': captured.headers['content-type'] ?? 'application/json',
      ...captured.headers,
    },
    body: captured.body,
  };
};
