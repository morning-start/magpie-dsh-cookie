/**
 * 插件自己的状态：保留策略、每日条数历史、排队中的清理、最近一次结果、最近回应。
 *
 * 状态文件只有日期、条数、路径与结果，**没有任何 cookie 值**。读写都走串行队列 +
 * 临时文件 rename，避免并发把文件写坏（页面按钮会连点）。
 * @module magpie-dsh-cookie/src/state
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { HISTORY_DAYS, DEFAULT_KEEP_DAYS, DEFAULT_KEEP_MAX } from './paths.ts';
import { normalizeConfig, type RetentionConfig } from './retention.ts';

/** 一条每日快照。 */
export interface HistoryEntry {
  /** 本地日期 `YYYY-MM-DD`。 */
  readonly date: string;
  readonly count: number;
  /** 记录时间（ISO）。 */
  readonly at: string;
}

/** 排队中的清理请求。 */
export interface PendingPrune {
  readonly at: string;
  readonly keepDays: number;
  readonly keepMax: number;
  readonly requestedBy: 'page' | 'tool' | 'cli' | 'auto';
}

/** 最近一次清理结果。 */
export interface LastPrune {
  readonly at: string;
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly removed: number;
  readonly remaining: number;
  readonly backup: string | null;
  readonly error: string | null;
  readonly cutoff: string | null;
}

/** 页面动作的回应。 */
export interface Reply {
  readonly id: string;
  readonly action: string;
  readonly ok: boolean;
  readonly message: string;
  readonly at: string;
}

/** 预演结果（持久化，页面关掉再开还能看到）。 */
export interface PreviewRecord {
  readonly at: string;
  readonly cutoff: string;
  readonly remove: number;
  readonly keep: number;
  readonly removeBytes: number;
}

/** 状态文件形状。 */
export interface StoredState {
  version: 1;
  config: RetentionConfig;
  history: HistoryEntry[];
  lastPrune: LastPrune | null;
  pending: PendingPrune | null;
  preview: PreviewRecord | null;
  lastRequestId: string | null;
  reply: Reply | null;
}

/** 默认状态。 */
export function emptyState(): StoredState {
  return {
    version: 1,
    config: { keepDays: DEFAULT_KEEP_DAYS, keepMax: DEFAULT_KEEP_MAX },
    history: [],
    lastPrune: null,
    pending: null,
    preview: null,
    lastRequestId: null,
    reply: null,
  };
}

/** 本地日期键。 */
function todayKey(nowMs: number): string {
  const date = new Date(nowMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 逐字段收窄读到的 JSON，坏字段用默认值，不让旧版本文件把插件带崩。 */
export function parseState(text: string): StoredState {
  const base = emptyState();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return base;
  }
  if (!raw || typeof raw !== 'object') return base;
  const input = raw as Record<string, unknown>;

  const configRaw = input.config as Partial<RetentionConfig> | undefined;
  const config = normalizeConfig({
    keepDays: typeof configRaw?.keepDays === 'number' ? configRaw.keepDays : undefined,
    keepMax: typeof configRaw?.keepMax === 'number' ? configRaw.keepMax : undefined,
  });

  const history: HistoryEntry[] = [];
  if (Array.isArray(input.history)) {
    for (const item of input.history) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) continue;
      if (typeof entry.count !== 'number' || !Number.isFinite(entry.count)) continue;
      history.push({ date: entry.date, count: Math.max(0, Math.floor(entry.count)), at: typeof entry.at === 'string' ? entry.at : new Date().toISOString() });
    }
  }
  history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const pruneRaw = input.lastPrune as Record<string, unknown> | undefined;
  const lastPrune: LastPrune | null =
    pruneRaw && typeof pruneRaw === 'object' && typeof pruneRaw.at === 'string'
      ? {
          at: pruneRaw.at,
          ok: pruneRaw.ok === true,
          dryRun: pruneRaw.dryRun === true,
          removed: typeof pruneRaw.removed === 'number' ? pruneRaw.removed : 0,
          remaining: typeof pruneRaw.remaining === 'number' ? pruneRaw.remaining : 0,
          backup: typeof pruneRaw.backup === 'string' ? pruneRaw.backup : null,
          error: typeof pruneRaw.error === 'string' ? pruneRaw.error : null,
          cutoff: typeof pruneRaw.cutoff === 'string' ? pruneRaw.cutoff : null,
        }
      : null;

  const pendingRaw = input.pending as Record<string, unknown> | undefined;
  const pending: PendingPrune | null =
    pendingRaw && typeof pendingRaw === 'object' && typeof pendingRaw.at === 'string'
      ? {
          at: pendingRaw.at,
          keepDays: typeof pendingRaw.keepDays === 'number' ? pendingRaw.keepDays : config.keepDays,
          keepMax: typeof pendingRaw.keepMax === 'number' ? pendingRaw.keepMax : config.keepMax,
          requestedBy: ['page', 'tool', 'cli', 'auto'].includes(String(pendingRaw.requestedBy)) ? (pendingRaw.requestedBy as PendingPrune['requestedBy']) : 'page',
        }
      : null;

  const previewRaw = input.preview as Record<string, unknown> | undefined;
  const preview: PreviewRecord | null =
    previewRaw && typeof previewRaw === 'object' && typeof previewRaw.at === 'string'
      ? {
          at: previewRaw.at,
          cutoff: typeof previewRaw.cutoff === 'string' ? previewRaw.cutoff : '',
          remove: typeof previewRaw.remove === 'number' ? previewRaw.remove : 0,
          keep: typeof previewRaw.keep === 'number' ? previewRaw.keep : 0,
          removeBytes: typeof previewRaw.removeBytes === 'number' ? previewRaw.removeBytes : 0,
        }
      : null;

  const replyRaw = input.reply as Record<string, unknown> | undefined;
  const reply: Reply | null =
    replyRaw && typeof replyRaw === 'object' && typeof replyRaw.id === 'string'
      ? {
          id: replyRaw.id,
          action: typeof replyRaw.action === 'string' ? replyRaw.action : '',
          ok: replyRaw.ok === true,
          message: typeof replyRaw.message === 'string' ? replyRaw.message : '',
          at: typeof replyRaw.at === 'string' ? replyRaw.at : new Date().toISOString(),
        }
      : null;

  return {
    version: 1,
    config,
    history: history.slice(-HISTORY_DAYS),
    lastPrune,
    pending,
    preview,
    lastRequestId: typeof input.lastRequestId === 'string' ? input.lastRequestId : null,
    reply,
  };
}

/** 状态文件的读写与串行化。 */
export class StateStore {
  private readonly file: string;
  private state: StoredState = emptyState();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
    this.reload();
  }

  /** 当前状态（只读引用，改它不会落盘）。 */
  get current(): StoredState {
    return this.state;
  }

  /** 重新从磁盘读。 */
  reload(): StoredState {
    try {
      this.state = parseState(readFileSync(this.file, 'utf8'));
    } catch {
      this.state = emptyState();
    }
    return this.state;
  }

  /** 串行改状态并落盘；返回改完的状态。 */
  update(mutate: (state: StoredState) => StoredState): Promise<StoredState> {
    const run = this.queue.then(() => {
      const next = mutate(this.state);
      this.state = next;
      this.write(next);
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 记一条每日快照：同一天只留一条（更新条数）。 */
  recordSnapshot(count: number, nowMs = Date.now()): Promise<StoredState> {
    const date = todayKey(nowMs);
    return this.update((state) => {
      const history = state.history.filter((entry) => entry.date !== date);
      history.push({ date, count, at: new Date(nowMs).toISOString() });
      history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return { ...state, history: history.slice(-HISTORY_DAYS) };
    });
  }

  private write(state: StoredState): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.state-${process.pid}-${Date.now()}.json`);
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // 清不掉临时文件不影响主流程
      }
    }
  }
}
