import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dayKey, isDshCookie, parseJarBytes, summarize } from '../src/jar.ts';
import { cleanup, makeCookieDb } from './helpers.ts';

describe('jar', () => {
  test('解析真实形状的库，统计条数与按天分布', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-jar-'));
    try {
      const file = makeCookieDb(dir, [
        { name: 'dsh-auth-A', host: '127.0.0.1', daysAgo: 0 },
        { name: 'dsh-auth-B', host: '127.0.0.1', daysAgo: 0 },
        { name: 'dsh-auth-C', host: '127.0.0.1', daysAgo: 2 },
        { name: 'other', host: 'example.com', daysAgo: 1 },
      ]);
      const parsed = parseJarBytes(readFileSync(file));
      expect(parsed.datesKnown).toBe(true);
      expect(parsed.rows).toHaveLength(4);

      const summary = summarize(parsed.rows);
      expect(summary.total).toBe(4);
      expect(summary.dshCount).toBe(3);
      expect(summary.otherCount).toBe(1);
      expect(summary.days).toHaveLength(2);
      expect(summary.oldestMs).not.toBeNull();
      expect(summary.days.reduce((sum, day) => sum + day.count, 0)).toBe(3);
    } finally {
      cleanup(dir);
    }
  });

  test('损坏的快照退化成按名字计数，不猜创建时间', () => {
    const name = `dsh-auth-${'a'.repeat(43)}`;
    const parsed = parseJarBytes(Buffer.from(`garbage ${name} more garbage`, 'latin1'));
    expect(parsed.datesKnown).toBe(false);
    expect(parsed.rows.map((row) => row.name)).toEqual([name]);
    expect(summarize(parsed.rows).dshCount).toBe(1);
  });

  test('空字节没有行', () => {
    expect(parseJarBytes(Buffer.alloc(0)).rows).toHaveLength(0);
  });

  test('isDshCookie 只认 dsh-auth 前缀', () => {
    expect(isDshCookie('dsh-auth-x')).toBe(true);
    expect(isDshCookie('session')).toBe(false);
  });

  test('dayKey 用本地时区', () => {
    expect(dayKey(new Date(2026, 10, 1, 23, 30).getTime())).toBe('2026-11-01');
  });
});
