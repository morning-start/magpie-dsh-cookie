/**
 * 页面快照：组装成 `page/data.js` 里 `globalThis.DSH_COOKIE = {...}`，原子写入。
 *
 * magpie 的页面沙箱没有网络（`connect-src 'none'`），页面唯一的数据来源就是这份文件；
 * 页面每 5 秒用 `<script src="data.js?t=…">` 重新加载它。
 * @module magpie-dsh-cookie/src/dashboard
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CookieGauge } from './gauge.ts';
import type { BackupInfo } from './prune.ts';
import type { HistoryEntry, LastPrune, PendingPrune, PreviewRecord, Reply } from './state.ts';
import type { RetentionConfig } from './retention.ts';

/** 库的概况（失败时可能为 null）。 */
export interface SnapshotDb {
  readonly path: string;
  readonly size: number;
  readonly dshCount: number;
  readonly otherCount: number;
  readonly oldest: string | null;
  readonly newest: string | null;
  readonly source: 'file' | 'borrowed-handle' | 'none';
}

/** 页面快照形状（与 page 侧约定一致）。 */
export interface Snapshot {
  readonly build: 1;
  readonly generated: string;
  readonly state: 'ok' | 'unknown' | 'error';
  readonly dshRunning: boolean;
  readonly stale: boolean;
  readonly db: SnapshotDb | null;
  readonly gauge: CookieGauge | null;
  readonly days: { date: string; count: number }[];
  readonly history: HistoryEntry[];
  readonly config: RetentionConfig;
  readonly preview: PreviewRecord | null;
  readonly pending: PendingPrune | null;
  readonly lastPrune: LastPrune | null;
  readonly reply: Reply | null;
  readonly backups: BackupInfo[];
  readonly readError: string | null;
}

/** 把快照写成页面可加载的 JS；先写临时文件再 rename，页面不会读到半截。 */
export function writePageData(file: string, snapshot: Snapshot): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const body = `globalThis.DSH_COOKIE = ${JSON.stringify(snapshot, null, 2)};\n`;
  const tmp = join(dir, `.data-${process.pid}-${Date.now()}.js`);
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 临时文件清不掉不影响主流程
    }
  }
}
