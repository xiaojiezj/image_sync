import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { generateImage } from './zenmux.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
]);

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function methodNotAllowed(res, allowed) {
  res.setHeader('allow', allowed.join(', '));
  sendJson(res, 405, { error: { message: 'method not allowed', type: 'invalid_request_error' } });
}

export function createApp({ config, store, fetchImpl = fetch, logger = console }) {
  const forceNonStream = config.forceNonStream !== false;

  async function runTask(task, upstreamHeaders, forwardBody) {
    try {
      task.status = 'processing';
      await store.put(task);

      const response = await generateImage({
        baseUrl: config.baseUrl,
        body: forwardBody,
        headers: upstreamHeaders,
        timeoutMs: config.upstreamTimeoutMs,
        fetchImpl,
      });

      task.status = 'succeeded';
      task.response = response;
      task.error = null;
      await store.put(task);
      logger?.log?.(`[image-sync] ${task.image_id} succeeded`);
    } catch (err) {
      task.status = 'failed';
      task.error = {
        message: err?.message || String(err),
        type: err?.name || 'Error',
        upstream_status: err?.status ?? null,
        upstream_body: err?.body ?? null,
      };
      try {
        await store.put(task);
      } catch (persistErr) {
        logger?.error?.('[image-sync] failed to persist task', persistErr);
      }
      logger?.error?.(`[image-sync] ${task.image_id} failed: ${task.error.message}`);
    }
  }

  function buildUpstreamHeaders(incoming) {
    const headers = {};
    for (const [key, value] of Object.entries(incoming)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      headers[lower] = Array.isArray(value) ? value.join(', ') : value;
    }
    headers['content-type'] = 'application/json';
    if (!headers.authorization && config.apiKey) {
      headers.authorization = `Bearer ${config.apiKey}`;
    }
    return headers;
  }

  async function createGeneration(req, res) {
    const raw = await readBody(req, config.maxBodyBytes);

    let parsed;
    try {
      parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    } catch {
      return sendJson(res, 400, {
        error: { message: 'request body must be valid JSON', type: 'invalid_request_error' },
      });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return sendJson(res, 400, {
        error: { message: 'request body must be a JSON object', type: 'invalid_request_error' },
      });
    }

    if (typeof parsed.prompt !== 'string' || parsed.prompt.length === 0) {
      return sendJson(res, 400, {
        error: { message: 'prompt is required', type: 'invalid_request_error' },
      });
    }

    const upstreamHeaders = buildUpstreamHeaders(req.headers);
    if (!upstreamHeaders.authorization) {
      return sendJson(res, 401, {
        error: {
          message: 'missing Authorization header (expected: Bearer $ZENMUX_API_KEY)',
          type: 'invalid_request_error',
        },
      });
    }

    const forward = { ...parsed };
    if (forceNonStream) delete forward.stream;
    const forwardBody = Buffer.from(JSON.stringify(forward));

    const now = Date.now();
    const task = {
      image_id: `img_${randomUUID().replace(/-/g, '')}`,
      object: 'image.generation',
      status: 'pending',
      model: parsed.model ?? null,
      created_at: now,
      updated_at: now,
      request: parsed,
      response: null,
      error: null,
    };

    await store.put(task);

    sendJson(res, 202, {
      image_id: task.image_id,
      object: task.object,
      status: task.status,
      created_at: task.created_at,
      query_url: `/v1/images/generations/${task.image_id}`,
    });

    // Fire and forget: the upstream call happens in the background.
    runTask(task, upstreamHeaders, forwardBody);
  }

  function getGeneration(res, id, url) {
    const task = store.get(id);
    if (!task) {
      return sendJson(res, 404, {
        error: { message: `image ${id} not found`, type: 'not_found', code: 'image_not_found' },
      });
    }
    if (url.searchParams.get('raw') === '1' && task.response) {
      return sendJson(res, 200, task.response);
    }
    return sendJson(res, 200, task);
  }

  async function route(req, res) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');

    const url = new URL(req.url, 'http://internal');
    let pathname = url.pathname.replace(/\/+$/, '') || '/';
    // Accept both `/v1/...` and `/api/v1/...` for drop-in compatibility.
    if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
      pathname = pathname.slice(4);
    }
    const segments = pathname.split('/').filter(Boolean);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (segments[0] === 'v1' && segments[1] === 'images' && segments[2] === 'generations') {
      const id = segments[3];

      if (!id) {
        if (req.method === 'POST') return createGeneration(req, res);
        return methodNotAllowed(res, ['POST']);
      }

      if (segments.length === 4) {
        if (req.method === 'GET') return getGeneration(res, id, url);
        return methodNotAllowed(res, ['GET']);
      }
    }

    return sendJson(res, 404, {
      error: { message: `not found: ${req.method} ${pathname}`, type: 'not_found' },
    });
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      logger?.error?.('[image-sync] unhandled error', err);
      if (res.headersSent) return res.destroy();
      sendJson(res, err?.statusCode || 500, {
        error: { message: err?.message || 'internal server error', type: 'proxy_error' },
      });
    });
  });
}
