import { describe, expect, test } from 'bun:test';

import { matchesDshProcess } from '../src/platform.ts';

describe('matchesDshProcess', () => {
  test('认得出各平台常见的 DSH 进程名', () => {
    expect(matchesDshProcess('DeepSeek Harness')).toBe(true);
    expect(matchesDshProcess('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness')).toBe(true);
    expect(matchesDshProcess('deepseek-harness')).toBe(true);
    expect(matchesDshProcess('dsh-desktop')).toBe(true);
    expect(matchesDshProcess('dsh_desktop')).toBe(true);
  });

  test('不会误伤别的进程', () => {
    expect(matchesDshProcess('bun')).toBe(false);
    expect(matchesDshProcess('magpie-bun')).toBe(false);
    expect(matchesDshProcess('ps')).toBe(false);
    expect(matchesDshProcess('')).toBe(false);
  });

  test('大小写不敏感', () => {
    expect(matchesDshProcess('DEEPSEEK HARNESS')).toBe(true);
    expect(matchesDshProcess('Dsh-Desktop')).toBe(true);
  });
});
