import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

export function loadConfig(overrides = {}) {
  return {
    host: process.env.HOST || '0.0.0.0',
    port: intEnv('PORT', 3000),
    // Upstream OpenAI-compatible base URL. The endpoint is `${baseUrl}/images/generations`.
    baseUrl: (process.env.ZENMUX_BASE_URL || 'https://zenmux.ai/api/v1').replace(/\/+$/, ''),
    // Optional fallback key. If the incoming request carries an Authorization header,
    // that one is always forwarded and takes precedence.
    apiKey: process.env.ZENMUX_API_KEY || '',
    dataDir: process.env.DATA_DIR || path.join(rootDir, 'data'),
    upstreamTimeoutMs: intEnv('UPSTREAM_TIMEOUT_MS', 15 * 60 * 1000),
    maxBodyBytes: intEnv('MAX_BODY_BYTES', 32 * 1024 * 1024),
    // Async mode abstracts streaming away: by default we force a non-streaming upstream call.
    forceNonStream: boolEnv('FORCE_NON_STREAM', true),
    ...overrides,
  };
}
