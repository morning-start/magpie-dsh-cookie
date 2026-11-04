import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listBackups, planPrune, pruneDatabase, trimBackups } from '../src/prune.ts';
import { chromeMicros, cleanup, makeCookieDb } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const CONFIG = { keepDays: 7, keepMax: 72 };

describe('pruneDatabase', () => {
  test('预演只算不写，库字节不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-prune-'));
    try {
      const dbPath = makeCookieDb(dir, [
        { name: 'dsh-auth-new', host: '127.0.0.1', daysAgo: 1 },
        { name: 'dsh-auth-old', host: '127.0.0.1', daysAgo: 10 },
        { name: 'other', host: 'example.com', daysAgo: 1 },
      ]);
      const backupDir = join(dir, 'backups');
      const before = readFileSync(dbPath);
      const result = pruneDatabase({ dbPath, backupDir, config: CONFIG, dryRun: true, nowMs: NOW, running: () => false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.dryRun).toBe(true);
      expect(result.plan.drop.map((row) => row.name)).toEqual(['dsh-auth-old']);
      expect(readFileSync(dbPath).equals(before)).toBe(true);
      expect(listBackups(backupDir)).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  test('真删：只删过期的 dsh-auth，其它 cookie 一条不动，并留备份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-prune-'));
    try {
      const dbPath = makeCookieDb(dir, [
        { name: 'dsh-auth-keep-new', host: '127.0.0.1', daysAgo: 1 },
        { name: 'dsh-auth-drop-1', host: '127.0.0.1', daysAgo: 10 },
        { name: 'dsh-auth-drop-2', host: '127.0.0.1', daysAgo: 30 },
        { name: 'other', host: 'example.com', daysAgo: 1 },
        { name: 'other2', host: 'example.com', daysAgo: 90 },
      ]);
      const backupDir = join(dir, 'backups');
      const result = pruneDatabase({ dbPath, backupDir, config: CONFIG, dryRun: false, nowMs: NOW, running: () => false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.removed).toBe(2);
      expect(result.remaining).toBe(1);
      expect(result.otherBefore).toBe(2);
      expect(result.otherAfter).toBe(2);
      expect(result.backup).not.toBeNull();

      const db = new Database(dbPath, { readonly: true });
      try {
        const names = (db.query('SELECT name FROM cookies ORDER BY name').all() as { name: string }[]).map((row) => row.name);
        expect(names).toEqual(['dsh-auth-keep-new', 'other', 'other2']);
        expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      } finally {
        db.close();
      }

      const backups = listBackups(backupDir);
      expect(backups).toHaveLength(1);
      expect(backups[0]?.name.startsWith('Cookies-')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('没有可删的就不写库、不备份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-prune-'));
    try {
      const dbPath = makeCookieDb(dir, [{ name: 'dsh-auth-new', host: '127.0.0.1', daysAgo: 1 }]);
      const backupDir = join(dir, 'backups');
      const result = pruneDatabase({ dbPath, backupDir, config: CONFIG, dryRun: false, nowMs: NOW, running: () => false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.removed).toBe(0);
      expect(listBackups(backupDir)).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  test('库损坏时拒绝清理，不猜创建时间', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-prune-'));
    try {
      const dbPath = join(dir, 'Cookies');
      writeFileSync(dbPath, 'definitely not sqlite');
      const result = pruneDatabase({ dbPath, backupDir: join(dir, 'backups'), config: CONFIG, dryRun: false, nowMs: NOW, running: () => false });
      expect(result.ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('库不存在时说清路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-prune-'));
    try {
      const result = pruneDatabase({ dbPath: join(dir, 'missing'), backupDir: join(dir, 'backups'), config: CONFIG, dryRun: true, nowMs: NOW, running: () => false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('找不到 cookie 库');
        // 连库都没打开过：不能对用户说「已回滚」
        expect(result.rolledBack).toBe(false);
      }
    } finally {
      cleanup(dir);
    }
  });

  test('creation_utc 是奇数微秒（超过 2^53）时也能精确删掉——按 rowid 定位', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-prune-'));
    try {
      const oldNames = ['dsh-auth-old-1', 'dsh-auth-old-2', 'dsh-auth-old-3', 'dsh-auth-old-4', 'dsh-auth-old-5'];
      const dbPath = makeCookieDb(dir, [
        { name: 'dsh-auth-new-1', host: '127.0.0.1', daysAgo: 1 },
        { name: 'dsh-auth-new-2', host: '127.0.0.1', daysAgo: 2 },
        { name: 'dsh-auth-new-3', host: '127.0.0.1', daysAgo: 3 },
        ...oldNames.map((name) => ({ name, host: '127.0.0.1', daysAgo: 40 })),
      ]);

      // 把 5 条旧行的 creation_utc 改成真实的「奇数微秒」：2026 年的 Chromium 时间约 1.34e16，
      // 超过 JS 安全整数上限，读成 Number 会四舍五入；旧实现按 creation_utc 删除就一条都匹配不上。
      const exactSet: Record<string, string> = {};
      const db = new Database(dbPath);
      try {
        const base = chromeMicros(Date.UTC(2026, 8, 20, 8, 0, 0)); // 2026-09-20，早于 7 天保留期
        oldNames.forEach((name, index) => {
          // 必须用 BigInt 拼文本：base 已经超过 2^53，JS 里 +1 会被四舍五入吞掉，拼出来的还是偶数
          const utcText = String(BigInt(base) + BigInt(index * 2 + 1)); // 奇数
          db.run(`UPDATE cookies SET creation_utc = ${utcText} WHERE name = '${name}'`);
          exactSet[name] = utcText;
        });
        for (const name of oldNames) {
          const got = db.query("SELECT printf('%d', creation_utc) AS v FROM cookies WHERE name = ?").get(name) as { v: string };
          expect(got.v).toBe(exactSet[name]);
          // 确认这些值真的超过了 Number 的精度：读成数字再转回去会变
          expect(String(Number(got.v))).not.toBe(got.v);
        }
      } finally {
        db.close();
      }

      const result = pruneDatabase({ dbPath, backupDir: join(dir, 'backups'), config: CONFIG, dryRun: false, nowMs: NOW, running: () => false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.removed).toBe(oldNames.length);
      expect(result.remaining).toBe(3);

      const check = new Database(dbPath, { readonly: true });
      try {
        const names = (check.query('SELECT name FROM cookies ORDER BY name').all() as { name: string }[]).map((row) => row.name);
        expect(names).toEqual(['dsh-auth-new-1', 'dsh-auth-new-2', 'dsh-auth-new-3']);
      } finally {
        check.close();
      }
    } finally {
      cleanup(dir);
    }
  });
});

describe('planPrune', () => {
  test('预演遇到损坏库也拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-prune-'));
    try {
      const dbPath = join(dir, 'Cookies');
      writeFileSync(dbPath, 'nope');
      const result = planPrune({ dbPath, backupDir: join(dir, 'backups'), config: CONFIG, dryRun: true, nowMs: NOW, running: () => false });
      expect(result.ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

describe('backups', () => {
  test('只留最近 N 份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-prune-'));
    try {
      for (let index = 0; index < 12; index += 1) {
        const name = `Cookies-20260101-0000${String(index).padStart(2, '0')}`;
        writeFileSync(join(dir, name), 'x');
      }
      expect(listBackups(dir)).toHaveLength(12);
      trimBackups(dir, 10);
      expect(listBackups(dir)).toHaveLength(10);
      expect(existsSync(join(dir, 'Cookies-20260101-000000'))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('旁路文件（-journal / -wal）不算备份，裁份数时连带清掉', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-backup-sidecar-'));
    try {
      // 真备份：3 份
      for (const name of ['Cookies-20260101-000000', 'Cookies-20260102-000000', 'Cookies-20260103-000000']) {
        writeFileSync(join(dir, name), 'x');
      }
      // 备份时一起复制过来的旁路文件：0 字节，名字带后缀
      writeFileSync(join(dir, 'Cookies-20260101-000000-journal'), '');
      writeFileSync(join(dir, 'Cookies-20260103-000000-journal'), '');

      // 页面上只该看到 3 份（以前会把 -journal 也算进去，显示成 5 份）
      expect(listBackups(dir).map((item) => item.name)).toEqual([
        'Cookies-20260103-000000',
        'Cookies-20260102-000000',
        'Cookies-20260101-000000',
      ]);

      trimBackups(dir, 2);
      expect(listBackups(dir).map((item) => item.name)).toEqual(['Cookies-20260103-000000', 'Cookies-20260102-000000']);
      // 被裁掉的那份，旁路文件一起清掉；留下的那份旁路还在
      expect(existsSync(join(dir, 'Cookies-20260101-000000'))).toBe(false);
      expect(existsSync(join(dir, 'Cookies-20260101-000000-journal'))).toBe(false);
      expect(existsSync(join(dir, 'Cookies-20260103-000000-journal'))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe('跨平台运行判断', () => {
  test('DSH 在运行（进程表判定）时拒绝清理，且不写库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-prune-'));
    try {
      const dbPath = makeCookieDb(dir, [
        { name: 'dsh-auth-keep', host: '127.0.0.1', daysAgo: 1 },
        { name: 'dsh-auth-old', host: '127.0.0.1', daysAgo: 30 },
      ]);
      const backupDir = join(dir, 'backups');
      const before = readFileSync(dbPath);
      const result = pruneDatabase({ dbPath, backupDir, config: CONFIG, dryRun: false, nowMs: NOW, running: () => true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.locked).toBe(true);
        expect(result.reason).toContain('DSH 正在运行');
        expect(result.rolledBack).toBe(false);
      }
      expect(readFileSync(dbPath).equals(before)).toBe(true);
      expect(listBackups(backupDir)).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  test('预演在 DSH 运行中也能算（macOS/Linux 走直接读）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magpie-cookie-prune-'));
    try {
      const dbPath = makeCookieDb(dir, [
        { name: 'dsh-auth-new', host: '127.0.0.1', daysAgo: 1 },
        { name: 'dsh-auth-old', host: '127.0.0.1', daysAgo: 30 },
      ]);
      const result = planPrune({ dbPath, backupDir: join(dir, 'backups'), config: CONFIG, dryRun: true, nowMs: NOW, running: () => true });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.plan.drop.map((row) => row.name)).toEqual(['dsh-auth-old']);
    } finally {
      cleanup(dir);
    }
  });
});
