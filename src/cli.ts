#!/usr/bin/env bun
/**
 * 离线命令行：不依赖 magpie 窗口，DSH 关掉后也能看和清。
 *
 * 用法（在插件目录里）：
 *   bun src/cli.ts status
 *   bun src/cli.ts plan  --keep-days 7 --keep-max 20
 *   bun src/cli.ts prune --keep-days 7 --keep-max 20
 *   bun src/cli.ts config --keep-days 5
 *   bun src/cli.ts backups
 *
 * 也可以用 magpie 自带的 Bun：
 *   ~/.cache/magpie/bun/<版本>/magpie-bun.exe src/cli.ts status
 * @module magpie-dsh-cookie/src/cli
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backupDir, magpieConfigDir } from './paths.ts';
import { listBackups, type BackupInfo } from './prune.ts';
import { CookieService } from './service.ts';

interface Args {
  readonly command: string;
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly keepDays?: number;
  readonly keepMax?: number;
}

/** 解析 `--key value` 与 `--flag`。 */
export function parseArgs(argv: readonly string[]): Args {
  let json = false;
  let dryRun = false;
  let keepDays: number | undefined;
  let keepMax: number | undefined;
  const rest: string[] = [];
  const readNumber = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--json') json = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--keep-days') {
      keepDays = readNumber(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--keep-days=')) keepDays = readNumber(arg.slice('--keep-days='.length));
    else if (arg === '--keep-max') {
      keepMax = readNumber(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--keep-max=')) keepMax = readNumber(arg.slice('--keep-max='.length));
    else if (!arg.startsWith('--')) rest.push(arg);
  }
  return { command: rest[0] ?? 'status', json, dryRun, keepDays, keepMax };
}

/** 人看的备份列表。 */
function printBackups(backups: readonly BackupInfo[]): void {
  if (backups.length === 0) {
    console.log('还没有备份。');
    return;
  }
  for (const item of backups) {
    console.log(`${item.name}  ${new Date(item.at).toLocaleString()}  ${(item.size / 1024).toFixed(1)} KiB`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const service = new CookieService({ directory: magpieConfigDir(), pluginRoot });

  if (args.command === 'help' || args.command === '--help') {
    console.log('用法: bun src/cli.ts status|plan|prune|config|backups|cancel [--keep-days N] [--keep-max N] [--dry-run] [--json]');
    return 0;
  }

  if (args.command === 'status') {
    const status = await service.status();
    if (args.json) {
      console.log(JSON.stringify(status, null, 2));
      return status.ok === true ? 0 : 1;
    }
    if (status.ok !== true) {
      console.log(`读不到 cookie 库：${String(status.readError ?? '未知原因')}`);
      return 1;
    }
    const gauge = status.gauge as { count: number; bytes: number; percent: number; remainingLaunches: number; level: string } | null;
    const db = status.db as { path: string; size: number; dshCount: number; otherCount: number; oldest: string | null; newest: string | null; source: string } | null;
    console.log(`DSH ${status.dshRunning === true ? '运行中（借句柄读取）' : '已退出（直接读取）'}`);
    if (gauge !== null) {
      console.log(`dsh cookie：${gauge.count} 条，请求头 ${gauge.bytes} 字节（${gauge.percent}%），还能再开 ${gauge.remainingLaunches} 次，档位 ${gauge.level}`);
    }
    if (db !== null) {
      console.log(`库：${db.path}`);
      console.log(`大小 ${(db.size / 1024).toFixed(1)} KiB，其它 cookie ${db.otherCount} 条，最早 ${db.oldest ?? '未知'}，最新 ${db.newest ?? '未知'}，来源 ${db.source}`);
    }
    const config = status.config as { keepDays: number; keepMax: number };
    console.log(`保留策略：最近 ${config.keepDays} 天 / 最多 ${config.keepMax} 条`);
    const pending = status.pending as { at?: string } | null;
    if (pending !== null) console.log(`排队中：退出 DSH 后会自动清理（${pending.at ?? ''}）`);
    const lastPrune = status.lastPrune as { at: string; ok: boolean; removed: number; remaining: number; backup: string | null; error: string | null } | null;
    if (lastPrune !== null) {
      console.log(
        `上次清理：${new Date(lastPrune.at).toLocaleString()} ${lastPrune.ok ? `删除 ${lastPrune.removed} 条，保留 ${lastPrune.remaining} 条` : `失败：${lastPrune.error ?? ''}`}`,
      );
    }
    return 0;
  }

  if (args.command === 'plan') {
    const result = await service.plan({ keepDays: args.keepDays, keepMax: args.keepMax });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
    }
    return result.ok ? 0 : 1;
  }

  if (args.command === 'prune') {
    if (args.dryRun) {
      const result = await service.plan({ keepDays: args.keepDays, keepMax: args.keepMax });
      console.log(result.message);
      return result.ok ? 0 : 1;
    }
    const result = await service.pruneNow({ requestedBy: 'cli', config: { keepDays: args.keepDays, keepMax: args.keepMax } });
    console.log(result.message);
    return result.ok ? 0 : 1;
  }

  if (args.command === 'config') {
    const result = await service.toolConfig({ keepDays: args.keepDays, keepMax: args.keepMax });
    console.log(args.json ? JSON.stringify(result, null, 2) : `保留策略：最近 ${(result.config as { keepDays: number }).keepDays} 天 / 最多 ${(result.config as { keepMax: number }).keepMax} 条`);
    return 0;
  }

  if (args.command === 'backups') {
    printBackups(listBackups(backupDir(magpieConfigDir())));
    return 0;
  }

  if (args.command === 'cancel') {
    const result = await service.cancelPending();
    console.log(result.message);
    return 0;
  }

  console.error(`未知命令：${args.command}`);
  return 2;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
