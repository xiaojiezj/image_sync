import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Tiny file-backed task store. Each task lives in its own JSON file so that the
 * service survives restarts and does not need an external database.
 */
export class TaskStore {
  constructor(dir) {
    this.dir = dir;
    this.tasks = new Map();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    let recovered = 0;
    let files = [];
    try {
      files = await readdir(this.dir);
    } catch {
      files = [];
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const task = JSON.parse(await readFile(path.join(this.dir, file), 'utf8'));
        if (!task || !task.image_id) continue;

        // In-flight work cannot be resumed after a restart; mark it as failed
        // instead of leaving it stuck in pending/processing forever.
        if (task.status === 'pending' || task.status === 'processing') {
          task.status = 'failed';
          task.error = { message: 'interrupted by server restart', type: 'server_restart' };
          await this.#write(task);
        }

        this.tasks.set(task.image_id, task);
        recovered += 1;
      } catch {
        // Ignore corrupt/unreadable task files.
      }
    }
    return recovered;
  }

  get(id) {
    return this.tasks.get(id) || null;
  }

  has(id) {
    return this.tasks.has(id);
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => b.created_at - a.created_at);
  }

  async put(task) {
    task.updated_at = Date.now();
    this.tasks.set(task.image_id, task);
    await this.#write(task);
    return task;
  }

  async delete(id) {
    if (!this.tasks.delete(id)) return false;
    await rm(path.join(this.dir, `${id}.json`), { force: true });
    await rm(path.join(this.dir, `${id}.json.tmp`), { force: true });
    return true;
  }

  async #write(task) {
    const dst = path.join(this.dir, `${task.image_id}.json`);
    const tmp = `${dst}.tmp`;
    await writeFile(tmp, JSON.stringify(task, null, 2));
    await rename(tmp, dst);
  }
}
