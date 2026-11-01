import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listBackups, planPrune, pruneDatabase, trimBackups } from '../src/prune.ts';
import { cleanup, makeCookieDb } from './helpers.ts';

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
      if (!result.ok) expect(result.reason).toContain('找不到 cookie 库');
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
