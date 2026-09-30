import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function mimeFor(ext) {
  return MIME[String(ext).toLowerCase()] || 'application/octet-stream';
}

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
  const imagesDir = path.join(config.dataDir, 'images');
  const imagesReady = mkdir(imagesDir, { recursive: true });
  const forceNonStream = config.forceNonStream !== false;
  let active = 0;

  async function persistImages(task, response) {
    const data = Array.isArray(response?.data) ? response.data : [];
    const urls = [];
    await imagesReady;

    for (let index = 0; index < data.length; index += 1) {
      const item = data[index] || {};
      if (!item.b64_json) continue;
      const ext = String(item.output_format || response.output_format || 'png').toLowerCase();
      const file = `${task.image_id}-${index}.${ext}`;
      try {
        await writeFile(path.join(imagesDir, file), Buffer.from(item.b64_json, 'base64'));
        urls[index] = `/v1/images/generations/${task.image_id}/content/${index}`;
      } catch (err) {
        logger?.error?.('[image-sync] failed to persist image', err);
      }
    }
    return urls;
  }

  async function runTask(task, upstreamHeaders, forwardBody) {
    active += 1;
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
      task.image_urls = await persistImages(task, response);
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
    } finally {
      active -= 1;
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
      image_urls: [],
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

  function listGenerations(res, url) {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 200);
    const status = url.searchParams.get('status');
    let items = store.list();
    if (status) items = items.filter((task) => task.status === status);

    sendJson(res, 200, {
      object: 'list',
      count: items.length,
      data: items.slice(0, limit).map((task) => ({
        image_id: task.image_id,
        status: task.status,
        model: task.model,
        created_at: task.created_at,
        updated_at: task.updated_at,
        image_urls: task.image_urls,
        error: task.error,
      })),
    });
  }

  async function serveContent(req, res, id, index) {
    const task = store.get(id);
    if (!task) {
      return sendJson(res, 404, { error: { message: `image ${id} not found`, type: 'not_found' } });
    }
    const data = Array.isArray(task.response?.data) ? task.response.data : [];
    const item = data[index];
    if (!item) {
      return sendJson(res, 404, {
        error: { message: `content index ${index} not found`, type: 'not_found' },
      });
    }

    const ext = String(item.output_format || task.response.output_format || 'png').toLowerCase();
    const file = path.join(imagesDir, `${id}-${index}.${ext}`);

    try {
      const info = await stat(file);
      res.writeHead(200, {
        'content-type': mimeFor(ext),
        'content-length': info.size,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(file).pipe(res);
    } catch {
      // Fall back to the base64 payload if the file is missing.
      if (item.b64_json) {
        const buf = Buffer.from(item.b64_json, 'base64');
        res.writeHead(200, { 'content-type': mimeFor(ext), 'content-length': buf.length });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      }
      return sendJson(res, 404, {
        error: { message: 'image content not available', type: 'not_found' },
      });
    }
  }

  async function deleteGeneration(res, id) {
    if (!store.has(id)) {
      return sendJson(res, 404, { error: { message: `image ${id} not found`, type: 'not_found' } });
    }
    await store.delete(id);
    try {
      for (const file of await readdir(imagesDir)) {
        if (file.startsWith(`${id}-`)) await rm(path.join(imagesDir, file), { force: true });
      }
    } catch {
      // ignore
    }
    sendJson(res, 200, { image_id: id, deleted: true });
  }

  async function route(req, res) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');

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

    if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/health')) {
      return sendJson(res, 200, {
        status: 'ok',
        active,
        tasks: store.list().length,
        upstream: config.baseUrl,
      });
    }

    if (segments[0] === 'v1' && segments[1] === 'images' && segments[2] === 'generations') {
      const id = segments[3];
      const sub = segments[4];

      if (!id) {
        if (req.method === 'POST') return createGeneration(req, res);
        if (req.method === 'GET') return listGenerations(res, url);
        return methodNotAllowed(res, ['POST', 'GET']);
      }

      if (sub === 'content' && segments[5] !== undefined) {
        const index = Number(segments[5]);
        if (!Number.isInteger(index) || index < 0) {
          return sendJson(res, 400, { error: { message: 'invalid content index', type: 'invalid_request_error' } });
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          return serveContent(req, res, id, index);
        }
        return methodNotAllowed(res, ['GET', 'HEAD']);
      }

      if (!sub) {
        if (req.method === 'GET') return getGeneration(res, id, url);
        if (req.method === 'DELETE') return deleteGeneration(res, id);
        return methodNotAllowed(res, ['GET', 'DELETE']);
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
