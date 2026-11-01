import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CookieService } from '../src/service.ts';
import { cleanup, makeCookieDb } from './helpers.ts';

const NOW = Date.now();

/** 等条件成立。 */
async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('排队清理', () => {
  test('库没被锁时，巡检自己把排队中的清理执行掉', async () => {
    const root = mkdtempSync(join(tmpdir(), 'magpie-cookie-queue-'));
    const dbPath = makeCookieDb(
      root,
      [
        { name: 'dsh-auth-new', host: '127.0.0.1', daysAgo: 1 },
        { name: 'dsh-auth-old', host: '127.0.0.1', daysAgo: 30 },
      ],
      NOW - 2 * 86_400_000,
    );
    const pluginRoot = join(root, 'plugin');
    mkdirSync(join(pluginRoot, 'page'), { recursive: true });
    const configDir = join(root, 'config');
    const dataDir = join(configDir, 'dsh-cookie');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'state.json'),
      JSON.stringify({
        version: 1,
        config: { keepDays: 7, keepMax: 40 },
        history: [],
        lastPrune: null,
        pending: { at: new Date().toISOString(), keepDays: 7, keepMax: 40, requestedBy: 'page' },
        preview: null,
        lastRequestId: null,
        reply: null,
      }),
    );
    const env = { ...process.env, MAGPIE_DSH_COOKIE_DB: dbPath, MAGPIE_DSH_COOKIE_DATA: dataDir };
    const service = new CookieService({ directory: configDir, pluginRoot, env, running: () => false });
    try {
      service.start();
      const stateFile = join(dataDir, 'state.json');
      const pageDataFile = join(pluginRoot, 'page', 'data.js');
      await waitFor(() => {
        const text = readFileSync(stateFile, 'utf8');
        if (!text.includes('"lastPrune"') || !text.includes('"pending": null')) return false;
        try {
          return readFileSync(pageDataFile, 'utf8').includes('"dshCount": 1');
        } catch {
          return false;
        }
      });
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      expect(state.lastPrune.ok).toBe(true);
      expect(state.lastPrune.removed).toBe(1);
      expect(state.pending).toBeNull();

      const pageData = readFileSync(join(pluginRoot, 'page', 'data.js'), 'utf8');
      expect(pageData).toContain('"lastPrune"');
      expect(pageData).toContain('"dshCount": 1');
    } finally {
      cleanup(root);
    }
  }, 20000);
});
