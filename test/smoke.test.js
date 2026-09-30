import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { TaskStore } from '../src/store.js';
import { createApp } from '../src/app.js';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('async image generation flow', async (t) => {
  const seen = {};
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      seen.custom = req.headers['x-custom'];
      seen.body = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          created: 1713833628,
          output_format: 'png',
          data: [{ b64_json: TINY_PNG }],
          usage: { total_tokens: 3 },
        }),
      );
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'image-sync-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const config = loadConfig({
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: '',
    dataDir,
    upstreamTimeoutMs: 5000,
  });
  const store = new TaskStore(path.join(dataDir, 'tasks'));
  await store.init();
  const app = createApp({ config, store, logger: { log() {}, error() {} } });
  const appPort = await listen(app);
  t.after(() => close(app));
  const base = `http://127.0.0.1:${appPort}`;

  // Missing Authorization -> 401.
  let res = await fetch(`${base}/v1/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'x' }),
  });
  assert.equal(res.status, 401);

  // Create the task.
  res = await fetch(`${base}/v1/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key', 'x-custom': 'abc' },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt: 'A cute baby sea otter',
      n: 1,
      size: '1024x1024',
      stream: true,
    }),
  });
  assert.equal(res.status, 202);
  const created = await res.json();
  assert.match(created.image_id, /^img_[0-9a-f]{32}$/);
  assert.equal(created.status, 'pending');

  // Poll until done.
  let task;
  for (let i = 0; i < 100; i += 1) {
    const poll = await fetch(`${base}/v1/images/generations/${created.image_id}`);
    assert.equal(poll.status, 200);
    task = await poll.json();
    if (task.status === 'succeeded' || task.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(task.status, 'succeeded', JSON.stringify(task.error));

  // Headers/body were passed through; stream was removed for async mode.
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/v1/images/generations');
  assert.equal(seen.auth, 'Bearer test-key');
  assert.equal(seen.custom, 'abc');
  assert.equal(seen.body.prompt, 'A cute baby sea otter');
  assert.equal(seen.body.stream, undefined);

  // Image content endpoint.
  assert.equal(task.image_urls[0], `/v1/images/generations/${created.image_id}/content/0`);
  const img = await fetch(`${base}${task.image_urls[0]}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), TINY_PNG);

  // Raw upstream response.
  const raw = await fetch(`${base}/v1/images/generations/${created.image_id}?raw=1`);
  assert.equal((await raw.json()).data[0].b64_json, TINY_PNG);

  // List.
  const list = await (await fetch(`${base}/api/v1/images/generations`)).json();
  assert.equal(list.count, 1);

  // Delete.
  const del = await fetch(`${base}/v1/images/generations/${created.image_id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const gone = await fetch(`${base}/v1/images/generations/${created.image_id}`);
  assert.equal(gone.status, 404);
});
