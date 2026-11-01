/**
 * 从 cookie 库字节里读出真数据：先落到临时文件，再用 `bun:sqlite` 只读查询。
 *
 * 为什么不直接对运行中的库开 SQLite：DSH 运行时库由 Chromium 掌管（Windows 上被独占，
 * macOS/Linux 没有强制锁但直接查会撞 SQLite 锁）；所以先读字节（Windows 借句柄，见 ./win32），
 * 再查副本。副本是某一刻的切片，万一正好撞上写入、SQLite 判它损坏，就退化成「按名字正则计数」
 * ——只给条数，不猜创建时间，界面会标出「创建时间不可用」。
 * @module magpie-dsh-cookie/src/jar
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Chromium 的时间是「1601-01-01 起的微秒」。 */
export const CHROME_EPOCH_MS = 11_644_473_600_000;
/** 登录 cookie 的名字特征。 */
export const DSH_NAME_PREFIX = 'dsh-auth-';
/** 名字的完整形状：`dsh-auth-` + 43 位 base64url。 */
const DSH_NAME_PATTERN = /dsh-auth-[A-Za-z0-9_-]{43}/g;

/** 库里的一行 cookie（不取值，只取长度与创建时间）。 */
export interface JarRow {
  readonly name: string;
  readonly host: string;
  /** Chromium 微秒时间戳；0 表示不知道。 */
  readonly creationUtc: number;
  readonly valueLen: number;
  readonly encLen: number;
}

/** 解析结论。`datesKnown` 为 false 时创建时间不可用（正则回退）。 */
export interface JarParse {
  readonly rows: JarRow[];
  readonly datesKnown: boolean;
  readonly note?: string;
}

/** 汇总结论。 */
export interface JarSummary {
  readonly total: number;
  readonly dshCount: number;
  readonly otherCount: number;
  readonly oldestMs: number | null;
  readonly newestMs: number | null;
  /** 按创建日期（本地时区）分组的 dsh cookie 数，升序。 */
  readonly days: { date: string; count: number }[];
}

/** Chromium 微秒 → 毫秒时间戳；0 或非法值回 null。 */
export function chromeTimeToMs(creationUtc: number): number | null {
  if (!Number.isFinite(creationUtc) || creationUtc <= 0) return null;
  const ms = Math.round(creationUtc / 1000 - CHROME_EPOCH_MS);
  return Number.isFinite(ms) ? ms : null;
}

/** 本地时区的 `YYYY-MM-DD`。 */
export function dayKey(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 是不是登录 cookie。 */
export function isDshCookie(name: string): boolean {
  return name.startsWith(DSH_NAME_PREFIX);
}

interface RawRow {
  name?: unknown;
  host_key?: unknown;
  creation_utc?: unknown;
  value_len?: unknown;
  enc_len?: unknown;
}

/** 把查询结果收窄成 JarRow。 */
function toRow(raw: RawRow): JarRow {
  const name = typeof raw.name === 'string' ? raw.name : '';
  return {
    name,
    host: typeof raw.host_key === 'string' ? raw.host_key : '',
    creationUtc: typeof raw.creation_utc === 'number' ? raw.creation_utc : 0,
    valueLen: typeof raw.value_len === 'number' ? raw.value_len : 0,
    encLen: typeof raw.enc_len === 'number' ? raw.enc_len : 0,
  };
}

/**
 * 解析库字节。
 * @param raw - 库文件原始字节。
 */
export function parseJarBytes(raw: Buffer): JarParse {
  if (raw.length === 0) return { rows: [], datesKnown: false, note: '库文件是空的' };

  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'magpie-dsh-cookie-'));
    const file = join(dir, 'Cookies');
    writeFileSync(file, raw);
    const db = new Database(file, { readonly: true });
    try {
      const queries = [
        'SELECT name, host_key, creation_utc, length(value) AS value_len, length(encrypted_value) AS enc_len FROM cookies',
        'SELECT name, host_key, creation_utc FROM cookies',
      ];
      let lastError = '';
      for (const sql of queries) {
        try {
          const rows = (db.query(sql).all() as RawRow[]).map(toRow);
          return { rows, datesKnown: true };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      return { rows: fallbackRows(raw), datesKnown: false, note: `SQLite 读不了这份快照：${lastError}` };
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { rows: fallbackRows(raw), datesKnown: false, note: `打不开副本：${message}` };
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 临时目录清不掉不影响结论
      }
    }
  }
}

/** 正则回退：只数名字，创建时间留 0。 */
function fallbackRows(raw: Buffer): JarRow[] {
  const text = raw.toString('latin1');
  const names = new Set<string>();
  for (const match of text.matchAll(DSH_NAME_PATTERN)) names.add(match[0]);
  return [...names].map((name) => ({ name, host: '', creationUtc: 0, valueLen: 0, encLen: 0 }));
}

/**
 * 汇总：条数、创建时间范围、按天分布。
 * @param rows - {@link JarRow} 列表。
 */
export function summarize(rows: readonly JarRow[]): JarSummary {
  const dshRows = rows.filter((row) => isDshCookie(row.name));
  const otherCount = rows.length - dshRows.length;

  const times = dshRows
    .map((row) => chromeTimeToMs(row.creationUtc))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  const byDay = new Map<string, number>();
  for (const ms of times) {
    const key = dayKey(ms);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  const days = [...byDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    total: rows.length,
    dshCount: dshRows.length,
    otherCount,
    oldestMs: times.length > 0 ? (times[0] ?? null) : null,
    newestMs: times.length > 0 ? (times[times.length - 1] ?? null) : null,
    days,
  };
}
