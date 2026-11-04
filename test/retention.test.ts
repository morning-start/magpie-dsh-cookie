import { describe, expect, test } from 'bun:test';

import { CHROME_EPOCH_MS } from '../src/jar.ts';
import { cutoffUtcAt, normalizeConfig, planRetention } from '../src/retention.ts';
import { DAY_MS } from '../src/paths.ts';
import type { JarRow } from '../src/jar.ts';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01 12:00 UTC

/** 由「多少天前」造一行 dsh cookie。 */
function row(daysAgo: number, name = `d${daysAgo}`): JarRow {
  const ms = NOW - daysAgo * DAY_MS;
  return { rowId: daysAgo + 1, name: `dsh-auth-${name}`, host: '127.0.0.1', creationUtc: Math.round((ms + CHROME_EPOCH_MS) * 1000), valueLen: 173, encLen: 0 };
}

describe('normalizeConfig', () => {
  test('夹取到可用范围', () => {
    expect(normalizeConfig({ keepDays: -3, keepMax: 0 })).toEqual({ keepDays: 0, keepMax: 1 });
    expect(normalizeConfig({ keepDays: 1000, keepMax: 500 })).toEqual({ keepDays: 90, keepMax: 72 });
    expect(normalizeConfig(undefined)).toEqual({ keepDays: 7, keepMax: 40 });
  });

  test('小数向下取整', () => {
    expect(normalizeConfig({ keepDays: 3.9, keepMax: 20.9 })).toEqual({ keepDays: 3, keepMax: 20 });
  });
});

describe('planRetention', () => {
  test('时间闸：早于 cutoff 的进删除名单，新的一律保留', () => {
    const rows = [row(1, 'new'), row(10, 'old'), row(30, 'older')];
    const plan = planRetention(rows, { keepDays: 7, keepMax: 72 }, NOW);
    expect(plan.drop.map((r) => r.name).sort()).toEqual(['dsh-auth-old', 'dsh-auth-older']);
    expect(plan.keep.map((r) => r.name)).toEqual(['dsh-auth-new']);
    expect(plan.droppedBytes).toBe(2 * 228);
  });

  test('永远保留最新一条，哪怕它也很旧', () => {
    const rows = [row(100, 'ancient-newest'), row(200, 'older')];
    const plan = planRetention(rows, { keepDays: 7, keepMax: 72 }, NOW);
    expect(plan.drop.map((r) => r.name)).toEqual(['dsh-auth-older']);
    expect(plan.keep.map((r) => r.name)).toEqual(['dsh-auth-ancient-newest']);
  });

  test('条数闸：都在保留期内时也只留 keepMax 条，从最旧的删', () => {
    const rows = Array.from({ length: 30 }, (_, index) => row(index, `d${index}`));
    const plan = planRetention(rows, { keepDays: 90, keepMax: 20 }, NOW);
    expect(plan.keep.length).toBe(20);
    expect(plan.drop.length).toBe(10);
    // 被删的是最旧的 10 条
    expect(plan.drop.map((r) => r.name).sort()).toEqual(Array.from({ length: 10 }, (_, index) => `dsh-auth-d${29 - index}`).sort());
  });

  test('创建时间未知的行不删', () => {
    const unknown: JarRow = { rowId: 99, name: 'dsh-auth-unknown', host: '', creationUtc: 0, valueLen: 0, encLen: 0 };
    const rows = [row(1, 'new'), unknown];
    const plan = planRetention(rows, { keepDays: 1, keepMax: 1 }, NOW);
    expect(plan.drop).toHaveLength(0);
    expect(plan.unknownTimeSkipped).toBe(1);
  });

  test('非 dsh-auth 的 cookie 不参与', () => {
    const other: JarRow = { rowId: 98, name: 'session', host: 'example.com', creationUtc: 1, valueLen: 10, encLen: 0 };
    const plan = planRetention([other], { keepDays: 7, keepMax: 20 }, NOW);
    expect(plan.drop).toHaveLength(0);
    expect(plan.totalBefore).toBe(0);
  });

  test('空库没有可删的', () => {
    expect(planRetention([], { keepDays: 7, keepMax: 20 }, NOW).drop).toHaveLength(0);
  });

  test('cutoff 换算：7 天前', () => {
    expect(cutoffUtcAt(NOW, 7)).toBe(Math.round((NOW - 7 * DAY_MS + CHROME_EPOCH_MS) * 1000));
  });

  test('keepDays=0 时只留最新一条', () => {
    const rows = [row(1, 'a'), row(0.5, 'b')];
    const plan = planRetention(rows, { keepDays: 0, keepMax: 72 }, NOW);
    expect(plan.keep.length).toBe(1);
    expect(plan.drop).toHaveLength(1);
  });
});
