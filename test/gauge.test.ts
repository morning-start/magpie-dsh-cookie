import { describe, expect, test } from 'bun:test';

import { BYTES_PER_COOKIE, cookieBubbleText, gaugeOf, LIMIT_COUNT, MAX_HEADER_BYTES, WARN_COUNT } from '../src/gauge.ts';

describe('gaugeOf', () => {
  test('空库是 0 条、0 字节、0%', () => {
    const gauge = gaugeOf(0);
    expect(gauge.count).toBe(0);
    expect(gauge.bytes).toBe(0);
    expect(gauge.percent).toBe(0);
    expect(gauge.level).toBe('ok');
    expect(gauge.remainingLaunches).toBe(71);
  });

  test('每条按 228 字节算', () => {
    expect(gaugeOf(1).bytes).toBe(BYTES_PER_COOKIE);
    expect(gaugeOf(10).bytes).toBe(10 * BYTES_PER_COOKIE);
  });

  test('36 条进入提醒档，35 条仍是正常档', () => {
    expect(gaugeOf(WARN_COUNT - 1).level).toBe('ok');
    expect(gaugeOf(WARN_COUNT).level).toBe('warn');
  });

  test('71 条是危险档边界，余量为 0；72 条超过上限', () => {
    const edge = gaugeOf(LIMIT_COUNT - 1);
    expect(edge.level).toBe('danger');
    expect(edge.remainingLaunches).toBe(0);
    expect(gaugeOf(LIMIT_COUNT).percent).toBe(100);
    expect(gaugeOf(200).percent).toBe(100);
  });

  test('百分比按请求头上限折算并四舍五入', () => {
    expect(gaugeOf(36).percent).toBe(Math.round((36 * BYTES_PER_COOKIE * 100) / MAX_HEADER_BYTES));
  });

  test('负数与 NaN 当作 0，不把脏值传下去', () => {
    for (const value of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const gauge = gaugeOf(value);
      expect(gauge.count).toBe(0);
      expect(Number.isFinite(gauge.percent)).toBe(true);
    }
  });
});

describe('cookieBubbleText', () => {
  test('正常档给出还能启动几次', () => {
    expect(cookieBubbleText(gaugeOf(26))).toContain('还能再开 45 次');
  });

  test('提醒档说快到上限', () => {
    expect(cookieBubbleText(gaugeOf(40))).toContain('快到上限');
  });

  test('危险档不再给「还能开几次」', () => {
    expect(cookieBubbleText(gaugeOf(71))).toContain('到边缘');
    expect(cookieBubbleText(gaugeOf(80))).toContain('超过 16 KiB');
  });
});
