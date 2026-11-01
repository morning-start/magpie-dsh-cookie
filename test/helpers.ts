import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { CHROME_EPOCH_MS } from '../src/jar.ts';

/** 删临时目录：Windows 上刚关闭的 SQLite 文件偶尔还会 EBUSY，重试几次再放弃。 */
export function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const until = Date.now() + 50;
      while (Date.now() < until) {
        // 等一小会儿再试
      }
    }
  }
}

/** Chromium 时间：毫秒时间戳 → 微秒（1601 起）。 */
export function chromeMicros(ms: number): number {
  return Math.round((ms + CHROME_EPOCH_MS) * 1000);
}

/** 造一个 Chromium 形状的 cookie 库，返回文件路径。 */
export function makeCookieDb(
  dir: string,
  rows: { name: string; host: string; daysAgo: number; value?: string }[],
  nowMs = Date.UTC(2026, 10, 1, 12, 0, 0),
): string {
  const file = join(dir, 'Cookies');
  const db = new Database(file);
  db.run(
    "CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL, has_cross_site_ancestor INTEGER NOT NULL)",
  );
  const insert = db.prepare(
    'INSERT INTO cookies (creation_utc, host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(
      chromeMicros(nowMs - row.daysAgo * 86_400_000),
      row.host,
      row.name,
      row.value ?? 'v',
      new Uint8Array(0),
      '/',
      0,
      0,
      0,
      0,
      1,
      1,
      1,
      0,
      0,
      80,
      0,
      0,
      0,
    );
  }
  db.close();
  return file;
}
