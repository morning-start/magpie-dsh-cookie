import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyState, parseState, StateStore } from '../src/state.ts';

describe('parseState', () => {
  test('坏 JSON 回到默认状态', () => {
    expect(parseState('{oops')).toEqual(emptyState());
    expect(parseState('null')).toEqual(emptyState());
  });

  test('坏字段被丢掉，不让旧文件带崩', () => {
    const parsed = parseState(
      JSON.stringify({
        version: 1,
        config: { keepDays: 'x', keepMax: 12 },
        history: [{ date: '2026-01-01', count: 3, at: 'x' }, { date: 'bad', count: 1 }, { date: '2026-01-02', count: 'nope' }],
        pending: { at: '2026-01-01T00:00:00.000Z', keepDays: 3, keepMax: 5, requestedBy: 'tool' },
        lastRequestId: 'abc',
      }),
    );
    expect(parsed.config).toEqual({ keepDays: 7, keepMax: 12 });
    expect(parsed.history).toHaveLength(1);
    expect(parsed.pending).toEqual({ at: '2026-01-01T00:00:00.000Z', keepDays: 3, keepMax: 5, requestedBy: 'tool' });
    expect(parsed.lastRequestId).toBe('abc');
  });

  test('历史只留最近 90 天', () => {
    const history = Array.from({ length: 95 }, (_, index) => ({
      date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
      count: index,
      at: 'x',
    }));
    const parsed = parseState(JSON.stringify({ version: 1, history }));
    expect(parsed.history.length).toBeLessThanOrEqual(90);
  });
});

describe('StateStore', () => {
  test('同一天只留一条快照，重复调用更新条数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-state-'));
    try {
      const store = new StateStore(join(dir, 'state.json'));
      await store.recordSnapshot(3, Date.UTC(2026, 10, 1, 1));
      await store.recordSnapshot(7, Date.UTC(2026, 10, 1, 2));
      expect(store.current.history).toHaveLength(1);
      expect(store.current.history[0]?.count).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('重新打开能读回落盘的状态', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-state-'));
    try {
      const file = join(dir, 'state.json');
      const store = new StateStore(file);
      await store.update((state) => ({ ...state, config: { keepDays: 3, keepMax: 9 }, lastRequestId: 'r1' }));
      const reopened = new StateStore(file);
      expect(reopened.current.config).toEqual({ keepDays: 3, keepMax: 9 });
      expect(reopened.current.lastRequestId).toBe('r1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('坏文件按默认状态启动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-state-'));
    try {
      const file = join(dir, 'state.json');
      writeFileSync(file, 'not json');
      expect(new StateStore(file).current).toEqual(emptyState());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
