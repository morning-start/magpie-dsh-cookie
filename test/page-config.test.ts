import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import '../page/config.js';
import { normalizeConfig } from '../src/retention.ts';

interface FormOk {
  readonly ok: true;
  readonly config: { keepDays: number; keepMax: number };
  readonly errors: string[];
}

interface FormBad {
  readonly ok: false;
  readonly errors: string[];
}

interface ConfigKit {
  readonly LIMITS: {
    readonly keepDays: { readonly min: number; readonly max: number };
    readonly keepMax: { readonly min: number; readonly max: number };
  };
  readonly parseForm: (daysText: string, maxText: string) => FormOk | FormBad;
  readonly same: (left: unknown, right: unknown) => boolean;
}

const kit = (globalThis as unknown as { DSHCookieConfig: ConfigKit }).DSHCookieConfig;
const pageDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'page');

describe('页面保留策略表单（page/config.js）', () => {
  test('范围和宿主侧 normalizeConfig 一致', () => {
    expect(kit.LIMITS.keepDays).toEqual({ min: 0, max: 90 });
    expect(kit.LIMITS.keepMax).toEqual({ min: 1, max: 72 });

    // 边界值经过宿主必须原样保留：页面能填的，host 不能偷偷夹掉
    for (const keepDays of [0, 1, 7, 90]) {
      for (const keepMax of [1, 40, 72]) {
        expect(normalizeConfig({ keepDays, keepMax })).toEqual({ keepDays, keepMax });
      }
    }
  });

  test('合法输入解析成配置', () => {
    expect(kit.parseForm('7', '40')).toEqual({ ok: true, config: { keepDays: 7, keepMax: 40 }, errors: [] });
    expect(kit.parseForm('0', '1')).toEqual({ ok: true, config: { keepDays: 0, keepMax: 1 }, errors: [] });
    expect(kit.parseForm('90', '72')).toEqual({ ok: true, config: { keepDays: 90, keepMax: 72 }, errors: [] });
    expect(kit.parseForm(' 5 ', ' 30 ')).toEqual({ ok: true, config: { keepDays: 5, keepMax: 30 }, errors: [] });
  });

  test('越界、空、小数、非数字都拒绝', () => {
    const bad: [string, string][] = [
      ['', '40'],
      ['7', ''],
      ['7.5', '40'],
      ['七', '40'],
      ['-1', '40'],
      ['91', '40'],
      ['7', '0'],
      ['7', '73'],
      ['7', '40.5'],
    ];
    for (const [days, max] of bad) {
      const parsed = kit.parseForm(days, max);
      expect(parsed.ok).toBe(false);
      expect(parsed.errors.length).toBeGreaterThan(0);
    }
  });

  test('页面能填的值，宿主不会再改写（防止「填了等于没填」）', () => {
    const samples: [string, string][] = [['0', '1'], ['0', '72'], ['90', '1'], ['12', '55']];
    for (const [days, max] of samples) {
      const parsed = kit.parseForm(days, max);
      if (!parsed.ok) throw new Error(`应当合法：${days}/${max}`);
      expect(normalizeConfig(parsed.config)).toEqual(parsed.config);
    }
  });

  test('same 只认两份都完整且相等', () => {
    expect(kit.same({ keepDays: 7, keepMax: 40 }, { keepDays: 7, keepMax: 40 })).toBe(true);
    expect(kit.same({ keepDays: 7, keepMax: 40 }, { keepDays: 7, keepMax: 41 })).toBe(false);
    expect(kit.same(null, { keepDays: 7, keepMax: 40 })).toBe(false);
  });

  test('页面输入框的 min / max 属性和校验口径一致', () => {
    const html = readFileSync(join(pageDir, 'index.html'), 'utf8');
    const days = html.match(/<input id="keep-days"[^>]*>/)?.[0] ?? '';
    const max = html.match(/<input id="keep-max"[^>]*>/)?.[0] ?? '';
    expect(days).toContain(`min="${kit.LIMITS.keepDays.min}"`);
    expect(days).toContain(`max="${kit.LIMITS.keepDays.max}"`);
    expect(max).toContain(`min="${kit.LIMITS.keepMax.min}"`);
    expect(max).toContain(`max="${kit.LIMITS.keepMax.max}"`);
  });

  test('页面按 config.js 顺序加载（表单解析在 app.js 之前就绪）', () => {
    const html = readFileSync(join(pageDir, 'index.html'), 'utf8');
    const configAt = html.indexOf('src="config.js"');
    const appAt = html.indexOf('src="app.js"');
    expect(configAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(configAt);
  });
});
