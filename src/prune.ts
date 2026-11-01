/**
 * 写库清理：备份 → 事务删除 → `integrity_check` → 复核 → 失败回滚。
 *
 * 只在 DSH 已退出（cookie 库不再被独占）时执行。删除用「名字 + 创建时间」精确定位，
 * 不用 `WHERE creation_utc < ?`：事务执行期间万一有别的写入，按时间条件会多删。
 * 任何一步复核不过，就把备份覆盖回去——宁可不清理，也不留一个坏库。
 * @module magpie-dsh-cookie/src/prune
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseJarBytes, summarize, type JarRow } from './jar.ts';
import { isDshRunning } from './platform.ts';
import { maskText, prettyPath } from './paths.ts';
import { planRetention, type RetentionConfig, type RetentionPlan } from './retention.ts';
import { fileLockState, readJarBytes } from './win32.ts';

/** 一次清理的入参。 */
export interface PruneOptions {
  readonly dbPath: string;
  readonly backupDir: string;
  readonly config: RetentionConfig;
  readonly dryRun: boolean;
  /** 当前时间；测试可固定。 */
  readonly nowMs?: number;
  /** 备份保留份数。 */
  readonly keepBackups?: number;
  /** DSH 是否在运行；测试可注入，默认按平台自动判断。 */
  readonly running?: (force?: boolean) => boolean;
}

/** DSH 是否在运行（Windows 看独占锁，macOS/Linux 看进程表）。 */
function runningNow(options: PruneOptions, force = false): boolean {
  if (options.running !== undefined) return options.running(force);
  return isDshRunning(options.dbPath, force);
}

/** 一次清理的结论。 */
export type PruneOutcome =
  | {
      readonly ok: true;
      readonly dryRun: boolean;
      readonly removed: number;
      readonly remaining: number;
      readonly otherBefore: number;
      readonly otherAfter: number;
      readonly backup: string | null;
      readonly cutoff: string;
      readonly elapsedMs: number;
      readonly plan: RetentionPlan;
    }
  | { readonly ok: false; readonly reason: string; readonly locked: boolean; readonly plan?: RetentionPlan };

/** 备份目录里的一份备份。 */
export interface BackupInfo {
  readonly name: string;
  readonly at: string;
  readonly size: number;
}

/** 备份文件名的本地时间戳。 */
function stamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `Cookies-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 列出备份（新到旧）。 */
export function listBackups(dir: string): BackupInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith('Cookies-'));
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    try {
      const stat = statSync(join(dir, name));
      if (!stat.isFile()) continue;
      // 文件名形如 Cookies-YYYYMMDD-HHmmss
      const match = /^Cookies-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
      const at = match
        ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).toISOString()
        : stat.mtime.toISOString();
      out.push({ name, at, size: stat.size });
    } catch {
      // 单个文件读不到就跳过
    }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

/** 只留最近 keep 份备份。 */
export function trimBackups(dir: string, keep: number): void {
  const all = listBackups(dir);
  for (const item of all.slice(Math.max(0, keep))) {
    try {
      rmSync(join(dir, item.name), { force: true });
    } catch {
      // 删不掉旧备份不影响本次清理
    }
  }
}

/** 读当前库的全部行；读不到就回原因。 */
function readRows(dbPath: string): { ok: true; rows: JarRow[]; datesKnown: boolean } | { ok: false; reason: string; locked: boolean } {
  const read = readJarBytes(dbPath);
  if (!read.ok) return { ok: false, reason: read.reason, locked: read.locked };
  const parsed = parseJarBytes(read.raw);
  return { ok: true, rows: parsed.rows, datesKnown: parsed.datesKnown };
}

/** 库的旁路文件（日志 / WAL / 共享内存）。 */
function sidecars(dbPath: string): string[] {
  return [`${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`];
}

/**
 * 上次异常退出可能留下「热日志」（`-journal` 非空或 `-wal` 存在）。DSH 已退出时，
 * 先让 SQLite 自己恢复一遍再读，否则我们读到的是回滚前的旧状态。
 */
function recoverHotStore(dbPath: string): { ok: true } | { ok: false; reason: string } {
  const journal = `${dbPath}-journal`;
  const wal = `${dbPath}-wal`;
  let hot = false;
  try {
    hot = (existsSync(journal) && statSync(journal).size > 0) || existsSync(wal);
  } catch {
    hot = false;
  }
  if (!hot) return { ok: true };
  try {
    const db = new Database(dbPath);
    try {
      db.query('SELECT COUNT(*) AS n FROM sqlite_master').get();
    } finally {
      db.close();
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `cookie 库有未完成的日志，恢复失败：${maskText(message)}。先启动一次 DSH 让它自愈，再回来清理` };
  }
}

/**
 * 预演：只算不写。
 * @returns 删除计划；DSH 运行中或库读不到时回原因。
 */
export function planPrune(options: PruneOptions): { ok: true; plan: RetentionPlan; otherCount: number } | { ok: false; reason: string; locked: boolean } {
  // DSH 运行时不要做「热日志恢复」：那会以读写方式打开库，可能和它抢锁。
  if (runningNow(options) === false && fileLockState(options.dbPath) === 'free') {
    const recovered = recoverHotStore(options.dbPath);
    if (!recovered.ok) return { ok: false, reason: recovered.reason, locked: false };
  }
  const read = readRows(options.dbPath);
  if (!read.ok) return read;
  if (!read.datesKnown) return { ok: false, reason: 'cookie 库快照损坏，创建时间不可用，不能安全清理', locked: false };
  const plan = planRetention(read.rows, options.config, options.nowMs ?? Date.now());
  const summary = summarize(read.rows);
  return { ok: true, plan, otherCount: summary.otherCount };
}

/**
 * 执行清理（或预演）。
 * @param options - 库路径、备份目录、保留策略、是否预演。
 */
export function pruneDatabase(options: PruneOptions): PruneOutcome {
  const startedAt = Date.now();
  const nowMs = options.nowMs ?? startedAt;
  const lock = fileLockState(options.dbPath);
  if (lock === 'missing') return { ok: false, reason: `找不到 cookie 库：${prettyPath(options.dbPath)}`, locked: false };
  if (lock === 'locked' || runningNow(options)) {
    return { ok: false, reason: 'DSH 正在运行，cookie 库还在使用中。请完全退出 DSH（Windows 从托盘退出；macOS/Linux 退出应用）再清理', locked: true };
  }

  const recovered = recoverHotStore(options.dbPath);
  if (!recovered.ok) return { ok: false, reason: recovered.reason, locked: false };

  const read = readRows(options.dbPath);
  if (!read.ok) return { ok: false, reason: read.reason, locked: read.locked };
  if (!read.datesKnown) return { ok: false, reason: 'cookie 库快照损坏，创建时间不可用，不能安全清理', locked: false };

  const plan = planRetention(read.rows, options.config, nowMs);
  const before = summarize(read.rows);
  const cutoffIso = new Date(plan.cutoffMs).toISOString();

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      removed: 0,
      remaining: before.dshCount,
      otherBefore: before.otherCount,
      otherAfter: before.otherCount,
      backup: null,
      cutoff: cutoffIso,
      elapsedMs: Date.now() - startedAt,
      plan,
    };
  }

  /** 没有要删的：不写库、不必备份。 */
  if (plan.drop.length === 0) {
    return {
      ok: true,
      dryRun: false,
      removed: 0,
      remaining: before.dshCount,
      otherBefore: before.otherCount,
      otherAfter: before.otherCount,
      backup: null,
      cutoff: cutoffIso,
      elapsedMs: Date.now() - startedAt,
      plan,
    };
  }

  // 删之前再确认一次库没被重新打开（DSH 可能刚启动）。
  if (fileLockState(options.dbPath) === 'locked' || runningNow(options, true)) {
    return { ok: false, reason: 'DSH 在清理前启动了，本次不写库', locked: true, plan };
  }

  mkdirSync(options.backupDir, { recursive: true });
  const backupName = stamp(new Date(nowMs));
  const backupPath = join(options.backupDir, backupName);
  try {
    copyFileSync(options.dbPath, backupPath);
    // 备份时把旁路文件一起带上，恢复时才是完整的一份。
    for (const file of sidecars(options.dbPath)) {
      if (existsSync(file)) copyFileSync(file, `${backupPath}${file.slice(options.dbPath.length)}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `备份失败，未写库：${maskText(message)}`, locked: false, plan };
  }

  let db: Database | undefined;
  let reason: string | null = null;
  try {
    db = new Database(options.dbPath);
    const remove = db.prepare('DELETE FROM cookies WHERE name = ? AND creation_utc = ?');
    const tx = db.transaction(() => {
      for (const row of plan.drop) remove.run(row.name, row.creationUtc);
    });
    tx();

    const integrity = db.query('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined;
    const integrityText = typeof integrity?.integrity_check === 'string' ? integrity.integrity_check : String(integrity?.integrity_check);
    if (integrityText !== 'ok') reason = `integrity_check 不通过：${integrityText}`;

    if (reason === null) {
      const dshAfter = (db.query("SELECT COUNT(*) AS n FROM cookies WHERE name LIKE 'dsh-auth-%'").get() as { n?: unknown } | undefined)?.n;
      const totalAfter = (db.query('SELECT COUNT(*) AS n FROM cookies').get() as { n?: unknown } | undefined)?.n;
      const dshCount = typeof dshAfter === 'number' ? dshAfter : Number(dshAfter);
      const total = typeof totalAfter === 'number' ? totalAfter : Number(totalAfter);
      if (dshCount !== plan.keep.length) reason = `复核失败：剩余 ${dshCount} 条，预期 ${plan.keep.length} 条`;
      else if (total - dshCount !== before.otherCount) reason = '复核失败：非 DSH cookie 数量变了，说明删错了行';
      else if (dshCount < 1) reason = '复核失败：一条 dsh-auth cookie 都没剩下';
      else {
        const missing = plan.drop.filter((row) => {
          const hit = db?.query('SELECT 1 AS hit FROM cookies WHERE name = ? AND creation_utc = ?').get(row.name, row.creationUtc);
          return hit !== undefined && hit !== null;
        });
        if (missing.length > 0) reason = `复核失败：还有 ${missing.length} 条应删的行没删掉`;
      }
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      db?.close();
    } catch {
      // 关闭失败也继续按 reason 处理
    }
  }

  if (reason !== null) {
    // 回滚：备份覆盖回去，并清掉我们这次写库可能留下的旁路文件。
    try {
      copyFileSync(backupPath, options.dbPath);
      for (const file of sidecars(options.dbPath)) {
        try {
          rmSync(file, { force: true });
        } catch {
          // 清不掉旁路文件不阻塞回滚
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `${maskText(reason)}；回滚也失败：${maskText(message)}（备份在 ${prettyPath(backupPath)}）`, locked: false, plan };
    }
    trimBackups(options.backupDir, (options.keepBackups ?? 10) - 1);
    return { ok: false, reason: `${maskText(reason)}（已从备份回滚，备份在 ${prettyPath(backupPath)}）`, locked: false, plan };
  }

  trimBackups(options.backupDir, options.keepBackups ?? 10);

  return {
    ok: true,
    dryRun: false,
    removed: plan.drop.length,
    remaining: plan.keep.length,
    otherBefore: before.otherCount,
    otherAfter: before.otherCount,
    backup: backupName,
    cutoff: cutoffIso,
    elapsedMs: Date.now() - startedAt,
    plan,
  };
}
