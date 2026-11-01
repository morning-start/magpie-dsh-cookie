import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { databasePath, maskText, partitionNetworkDir, prettyPath } from '../src/paths.ts';

describe('databasePath', () => {
  test('Windows 用 %APPDATA%', () => {
    const path = databasePath({ APPDATA: 'C:\\data\\me\\AppData\\Roaming' }, 'win32');
    expect(path).toBe(join('C:\\data\\me\\AppData\\Roaming', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies'));
  });

  test('Windows 没有 APPDATA 时回退到用户目录', () => {
    const path = databasePath({ HOME: 'C:\\data\\me' }, 'win32');
    expect(path).toBe(join('C:\\data\\me', 'AppData', 'Roaming', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies'));
  });

  test('macOS 用 Application Support', () => {
    const path = databasePath({ HOME: '/Users/me' }, 'darwin');
    expect(path).toBe(join('/Users/me', 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies'));
  });

  test('Linux 用 XDG_CONFIG_HOME，回退 ~/.config', () => {
    expect(databasePath({ HOME: '/home/me' }, 'linux')).toBe(
      join('/home/me', '.config', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies'),
    );
    expect(databasePath({ HOME: '/home/me', XDG_CONFIG_HOME: '/home/me/.config' }, 'linux')).toBe(
      join('/home/me/.config', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies'),
    );
  });

  test('环境变量覆盖优先于平台默认', () => {
    expect(databasePath({ MAGPIE_DSH_COOKIE_DB: '/tmp/x', HOME: '/home/me' }, 'linux')).toBe('/tmp/x');
  });

  test('分区库目录跟着同一套根目录', () => {
    expect(partitionNetworkDir({ HOME: '/Users/me' }, 'darwin')).toBe(
      join('/Users/me', 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop', 'Partitions'),
    );
  });
});

describe('prettyPath', () => {
  test('把本机用户目录换成 ~', () => {
    const home = homedir();
    const real = join(home, 'AppData', 'Roaming', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies');
    expect(prettyPath(real)).toBe(`~${real.slice(home.length)}`);
    expect(prettyPath(real).startsWith('~')).toBe(true);
    expect(prettyPath(real).toLowerCase().includes(home.toLowerCase())).toBe(false);
  });

  test('自定义 home，兼容正反斜杠', () => {
    expect(prettyPath('/home/me/x', '/home/me')).toBe('~/x');
    expect(prettyPath('C:\\data\\me\\x', 'c:/data/me')).toBe('~\\x');
  });

  test('用户目录之外的路径原样返回', () => {
    expect(prettyPath('/etc/hosts', '/home/me')).toBe('/etc/hosts');
    expect(prettyPath('C:\\Windows\\x', 'C:\\data\\me')).toBe('C:\\Windows\\x');
    expect(prettyPath('', '/home/me')).toBe('');
  });
});

describe('maskText', () => {
  test('擦掉错误消息里的用户目录', () => {
    expect(maskText("EBUSY: resource busy or locked, open 'C:\\data\\me\\x'", 'C:\\data\\me')).toBe(
      "EBUSY: resource busy or locked, open '~\\x'",
    );
    expect(maskText('failed at /home/me/data', '/home/me')).toBe('failed at ~/data');
  });

  test('大小写与正反斜杠都认', () => {
    expect(maskText('path c:\\users\\me\\x', 'C:\\Users\\Me')).toBe('path ~\\x');
    expect(maskText('path C:/data/me/x', 'C:\\data\\me')).toBe('path ~/x');
  });

  test('不含用户目录时原样返回', () => {
    expect(maskText('no path here', 'C:\\data\\me')).toBe('no path here');
  });
});
