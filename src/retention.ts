/**
 * 保留策略：给定库里的 cookie 行，算「应该删哪些」。
 *
 * 纯函数，不读盘、不删东西——真正写库在 ./prune。规则：
 * 1. 只考虑 `dsh-auth-*`，其它 cookie 一个都不碰；
 * 2. 早于 `now - keepDays 天` 的进删除名单；
 * 3. 若剩下的还超过 `keepMax`，从最旧的继续删，直到不超过上限；
 * 4. **永远保留创建时间最新的那一条**（清理发生时 DSH 已退出，下次启动会再签一条，
 *    但库里留一条最好——这是给误操作兜底）；
 * 5. 创建时间未知的行（正则回退）一律不删。
 * @module magpie-dsh-cookie/src/retention
 */
import { CHROME_EPOCH_MS, isDshCookie, type JarRow } from './jar.ts';
import { DAY_MS, DEFAULT_KEEP_DAYS, DEFAULT_KEEP_MAX } from './paths.ts';

/** 保留策略。 */
export interface RetentionConfig {
  /** 保留最近几天；0–90。 */
  readonly keepDays: number;
  /** 最多保留几条；1–72。 */
  readonly keepMax: number;
}

/** 一次预演的结论。 */
export interface RetentionPlan {
  /** 时间闸的 cutoff（Chromium 微秒）。 */
  readonly cutoffUtc: number;
  /** 时间闸的 cutoff（毫秒时间戳）。 */
  readonly cutoffMs: number;
  readonly drop: JarRow[];
  readonly keep: JarRow[];
  readonly totalBefore: number;
  /** 将释放的请求头字节（按每条 228 字节估算）。 */
  readonly droppedBytes: number;
  /** 因创建时间未知而跳过、不参与删除的行数。 */
  readonly unknownTimeSkipped: number;
}

/** 夹取配置到可用范围。 */
export function normalizeConfig(patch: Partial<RetentionConfig> | undefined): RetentionConfig {
  const keepDaysRaw = patch?.keepDays;
  const keepMaxRaw = patch?.keepMax;
  const keepDays = Number.isFinite(keepDaysRaw) ? Math.min(90, Math.max(0, Math.floor(keepDaysRaw as number))) : DEFAULT_KEEP_DAYS;
  const keepMax = Number.isFinite(keepMaxRaw) ? Math.min(72, Math.max(1, Math.floor(keepMaxRaw as number))) : DEFAULT_KEEP_MAX;
  return { keepDays, keepMax };
}

/** Chromium 微秒 cutoff：保留窗口的起点。 */
export function cutoffUtcAt(nowMs: number, keepDays: number): number {
  const cutoffMs = nowMs - keepDays * DAY_MS;
  return Math.round((cutoffMs + CHROME_EPOCH_MS) * 1000);
}

/** 按创建时间从新到旧排序（未知时间排最后）。 */
function newestFirst(rows: readonly JarRow[]): JarRow[] {
  return [...rows].sort((a, b) => b.creationUtc - a.creationUtc);
}

/**
 * 计算删除名单。
 * @param rows - 库里的全部 cookie 行。
 * @param config - 保留策略。
 * @param nowMs - 当前时间（毫秒），测试可传固定值。
 */
export function planRetention(rows: readonly JarRow[], config: RetentionConfig, nowMs: number): RetentionPlan {
  const { keepDays, keepMax } = normalizeConfig(config);
  const cutoffUtc = cutoffUtcAt(nowMs, keepDays);
  const dshRows = rows.filter((row) => isDshCookie(row.name));
  const ordered = newestFirst(dshRows);

  /** 最新的一条永远留下。 */
  const alwaysKeep = ordered.length > 0 ? ordered[0] : undefined;
  const candidates = ordered.slice(1);

  const drop = new Set<JarRow>();
  let unknownTimeSkipped = 0;
  for (const row of candidates) {
    // 时间未知的行不删：宁可留多了，也不能把不知道多旧的删掉。
    if (!row.creationUtc || row.creationUtc <= 0) {
      unknownTimeSkipped += 1;
      continue;
    }
    if (row.creationUtc < cutoffUtc) drop.add(row);
  }

  // 条数闸：时间上留下但总数超上限的，从最旧的开始删。
  const remaining = candidates.filter((row) => !drop.has(row));
  for (let index = remaining.length - 1; index >= 0; index -= 1) {
    if (ordered.length - drop.size <= keepMax) break;
    const row = remaining[index];
    if (row && row.creationUtc > 0) drop.add(row);
  }

  const keep: JarRow[] = [];
  if (alwaysKeep !== undefined) keep.push(alwaysKeep);
  for (const row of candidates) if (!drop.has(row)) keep.push(row);

  return {
    cutoffUtc,
    cutoffMs: nowMs - keepDays * DAY_MS,
    drop: [...drop],
    keep,
    totalBefore: dshRows.length,
    droppedBytes: drop.size * 228,
    unknownTimeSkipped,
  };
}
