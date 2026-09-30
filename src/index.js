import path from 'node:path';
import { loadConfig } from './config.js';
import { TaskStore } from './store.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = new TaskStore(path.join(config.dataDir, 'tasks'));
const recovered = await store.init();
const server = createApp({ config, store });

server.listen(config.port, config.host, () => {
  const address = server.address();
  const host = ['::', '0.0.0.0'].includes(address.address) ? 'localhost' : address.address;
  console.log(`[image-sync] listening on http://${host}:${address.port}`);
  console.log(`[image-sync] upstream : ${config.baseUrl}`);
  console.log(`[image-sync] data dir : ${config.dataDir}`);
  console.log(`[image-sync] recovered: ${recovered} task(s)`);
});

function shutdown(signal) {
  console.log(`[image-sync] received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
