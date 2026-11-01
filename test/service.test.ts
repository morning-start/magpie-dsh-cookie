import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CookieService, extractRequest } from '../src/service.ts';
import { cleanup, makeCookieDb } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

/** 造一个临时环境：库、数据目录、插件根（含 page/）。 */
function fixture(rows: Parameters<typeof makeCookieDb>[1]) {
  const root = mkdtempSync(join(tmpdir(), 'magpie-cookie-service-'));
  const dbPath = makeCookieDb(root, rows, NOW);
  const pluginRoot = join(root, 'plugin');
  mkdirSync(join(pluginRoot, 'page'), { recursive: true });
  const configDir = join(root, 'config');
  const dataDir = join(configDir, 'dsh-cookie');
  const env = { ...process.env, MAGPIE_DSH_COOKIE_DB: dbPath, MAGPIE_DSH_COOKIE_DATA: dataDir };
  const service = new CookieService({ directory: configDir, pluginRoot, env, running: () => false });
  return { root, dbPath, pluginRoot, configDir, dataDir, env, service };
}

/** 等一个条件成立（页面动作是异步的）。 */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('extractRequest', () => {
  test('只认形状完整的请求', () => {
    expect(extractRequest({ request: { id: 'a', action: 'refresh' } })).toEqual({ id: 'a', action: 'refresh', config: undefined, at: undefined });
    expect(extractRequest({ request: { id: 'a', action: 'nope' } })).toBeUndefined();
    expect(extractRequest({ request: { action: 'refresh' } })).toBeUndefined();
    expect(extractRequest(undefined)).toBeUndefined();
  });
});

describe('CookieService', () => {
  test('读库、写页面快照、出配置', async () => {
    const fx = fixture([
      { name: 'dsh-auth-a', host: '127.0.0.1', daysAgo: 1 },
      { name: 'dsh-auth-b', host: '127.0.0.1', daysAgo: 2 },
      { name: 'other', host: 'example.com', daysAgo: 1 },
    ]);
    try {
      const status = await fx.service.status();
      expect(status.ok).toBe(true);
      expect((status.gauge as { count: number }).count).toBe(2);
      expect((status.db as { otherCount: number }).otherCount).toBe(1);
      expect((status.db as { source: string }).source).toBe('file');

      const pageData = join(fx.pluginRoot, 'page', 'data.js');
      expect(existsSync(pageData)).toBe(true);
      const text = readFileSync(pageData, 'utf8');
      expect(text).toContain('"dshCount": 2');
      // 页面快照里不能出现本机用户目录/用户名。
      expect(text.toLowerCase().includes(homedir().toLowerCase())).toBe(false);
      expect(text).toContain('~');
    } finally {
      cleanup(fx.root);
    }
  });

  test('预演写入 preview，清理只删过期行', async () => {
    const fx = fixture([
      { name: 'dsh-auth-new', host: '127.0.0.1', daysAgo: 1 },
      { name: 'dsh-auth-old', host: '127.0.0.1', daysAgo: 10 },
    ]);
    try {
      const planned = await fx.service.plan({ keepDays: 7, keepMax: 72 });
      expect(planned.ok).toBe(true);
      expect(planned.message).toContain('将删除 1 条');

      const pruned = await fx.service.pruneNow({ requestedBy: 'cli', config: { keepDays: 7, keepMax: 72 } });
      expect(pruned.ok).toBe(true);
      if (pruned.ok) expect(pruned.message).toContain('已删除 1 条');

      const status = await fx.service.status();
      expect((status.gauge as { count: number }).count).toBe(1);
      const pageData = readFileSync(join(fx.pluginRoot, 'page', 'data.js'), 'utf8');
      expect(pageData).toContain('"lastPrune"');
    } finally {
      cleanup(fx.root);
    }
  });

  test('保存保留策略并回写页面', async () => {
    const fx = fixture([{ name: 'dsh-auth-a', host: '127.0.0.1', daysAgo: 1 }]);
    try {
      const saved = await fx.service.setConfig({ keepDays: 3, keepMax: 9 });
      expect(saved.ok).toBe(true);
      expect(readFileSync(join(fx.configDir, 'dsh-cookie', 'state.json'), 'utf8')).toContain('"keepDays": 3');
      expect((await fx.service.toolConfig({})).config).toEqual({ keepDays: 3, keepMax: 9 });
    } finally {
      cleanup(fx.root);
    }
  });

  test('页面请求走 options.request，结果写回 reply', async () => {
    const fx = fixture([{ name: 'dsh-auth-a', host: '127.0.0.1', daysAgo: 1 }]);
    try {
      await fx.service.status();
      fx.service.applyOptions({ request: { id: 'req-1', action: 'plan', config: { keepDays: 7, keepMax: 20 } } });
      const stateFile = join(fx.configDir, 'dsh-cookie', 'state.json');
      await waitFor(() => readFileSync(stateFile, 'utf8').includes('"id": "req-1"'));
      const pageData = readFileSync(join(fx.pluginRoot, 'page', 'data.js'), 'utf8');
      expect(pageData).toContain('"action": "plan"');
      expect(pageData).toContain('"ok": true');
    } finally {
      cleanup(fx.root);
    }
  });

  test('读不到库时页面拿到 error 与原因，不给假数字', async () => {
    const root = mkdtempSync(join(tmpdir(), 'magpie-cookie-service-'));
    try {
      const pluginRoot = join(root, 'plugin');
      mkdirSync(join(pluginRoot, 'page'), { recursive: true });
      const env = { ...process.env, MAGPIE_DSH_COOKIE_DB: join(root, 'missing'), MAGPIE_DSH_COOKIE_DATA: join(root, 'data') };
      const service = new CookieService({ directory: join(root, 'config'), pluginRoot, env, running: () => false });
      const status = await service.status();
      expect(status.ok).toBe(false);
      expect(String(status.readError)).toContain('找不到 cookie 库');
      const pageData = readFileSync(join(pluginRoot, 'page', 'data.js'), 'utf8');
      expect(pageData).toContain('"state": "error"');
      expect(pageData).toContain('"gauge": null');
    } finally {
      cleanup(root);
    }
  });
});
