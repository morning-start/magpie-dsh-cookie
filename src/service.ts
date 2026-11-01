/**
 * 编排层：探测、缓存、页面快照、页面动作、排队清理、20 秒巡检。
 *
 * 一条铁律：**这个服务不做高频轮询**。magpie 的窗口页面每 5 秒重新加载一次 data.js（只是一次
 * 静态文件读），真正的探测 60 秒一次；第一次借句柄可能要 4 秒，所以插件 load 里只是
 * `setTimeout` 排个异步任务，绝不阻塞加载。
 * @module magpie-dsh-cookie/src/service
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';

import { cookieBubbleText, gaugeOf, type CookieGauge } from './gauge.ts';
import type { Snapshot, SnapshotDb } from './dashboard.ts';
import { writePageData } from './dashboard.ts';
import type { JarRow } from './jar.ts';
import {
  backupDir as backupDirOf,
  databasePath,
  dataDir as dataDirOf,
  KEEP_BACKUPS,
  maskText,
  prettyPath,
  stateFile as stateFileOf,
} from './paths.ts';
import { probeDatabase, type ProbeResult } from './probe.ts';
import { listBackups, planPrune, pruneDatabase, type BackupInfo } from './prune.ts';
import { normalizeConfig, planRetention, type RetentionConfig } from './retention.ts';
import { isDshRunning } from './platform.ts';
import { StateStore, type Reply, type StoredState } from './state.ts';

/** 探测缓存时长：借一次句柄要扫全机句柄表，不能太频繁。 */
const CACHE_MS = 60_000;
/** 巡检间隔：排队清理靠它发现「DSH 退出了」。 */
const TICK_MS = 20_000;

/** 页面投递过来的请求（写在插件 options.request 里）。 */
export interface PluginRequest {
  readonly id: string;
  readonly action: 'refresh' | 'plan' | 'prune' | 'cancel-pending' | 'config';
  readonly config?: Partial<RetentionConfig>;
  readonly at?: number;
}

/** 动作结果。 */
interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
}

/** 服务入参。 */
export interface ServiceOptions {
  /** magpie 配置目录（插件宿主传 `input.directory`）。 */
  readonly directory: string;
  /** 插件根目录，用来定位 `page/data.js`。 */
  readonly pluginRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** DSH 是否在运行；测试可注入，默认按平台判断。 */
  readonly running?: (force?: boolean) => boolean;
}

/** 最近一次成功的探测，失败时用它做「上次已知」显示。 */
interface LastGood {
  readonly at: number;
  readonly db: SnapshotDb;
  readonly gauge: CookieGauge;
  readonly days: { date: string; count: number }[];
  readonly rows: JarRow[];
}

/** 从 options 里挑出请求；形状不对就忽略。 */
export function extractRequest(options: unknown): PluginRequest | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const request = (options as { request?: unknown }).request;
  if (!request || typeof request !== 'object') return undefined;
  const input = request as Record<string, unknown>;
  if (typeof input.id !== 'string' || input.id === '') return undefined;
  const action = input.action;
  if (action !== 'refresh' && action !== 'plan' && action !== 'prune' && action !== 'cancel-pending' && action !== 'config') return undefined;
  const configRaw = input.config;
  const config = configRaw && typeof configRaw === 'object' ? (configRaw as Partial<RetentionConfig>) : undefined;
  return { id: input.id, action, config, at: typeof input.at === 'number' ? input.at : undefined };
}

/** cookie 看板服务。 */
export class CookieService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly dbFile: string;
  private readonly dataDir: string;
  private readonly backupsDir: string;
  private readonly store: StateStore;
  private readonly pageDataFile: string;
  private readonly running: (force?: boolean) => boolean;

  private lastGood: LastGood | undefined;
  private lastError: string | undefined;
  private lastLocked = false;
  private inflightProbe: Promise<ProbeResult> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private started = false;

  constructor(options: ServiceOptions) {
    this.env = options.env ?? process.env;
    this.log = options.log ?? (() => undefined);
    this.dbFile = databasePath(this.env);
    this.dataDir = dataDirOf(options.directory, this.env);
    this.backupsDir = backupDirOf(options.directory, this.env);
    this.store = new StateStore(stateFileOf(options.directory, this.env));
    this.pageDataFile = join(options.pluginRoot, 'page', 'data.js');
    this.running = options.running ?? ((force) => isDshRunning(this.dbFile, force));
  }

  /** 启动巡检与首次探测；重复调用无副作用。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    // 先把上一份状态画出来，页面不会有空白期。
    this.emit();
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    (this.timer as unknown as { unref?: () => void }).unref?.();
    // 探测放到下一个事件循环：插件加载有 20 秒上限，不能被首次借句柄的 4 秒拖住。
    setTimeout(() => {
      void this.tick(true);
    }, 30);
  }

  /** 插件每次加载都会带来最新的 options：识别新请求。 */
  applyOptions(options: unknown): void {
    const request = extractRequest(options);
    if (request === undefined) return;
    if (request.id === this.store.current.lastRequestId) return;
    void this.handleRequest(request);
  }

  /** 供 Agent 工具用的状态查询（会自动尝试一次新探测，但有缓存）。 */
  async status(): Promise<Record<string, unknown>> {
    await this.refresh(false);
    const state = this.store.current;
    const snapshot = this.buildSnapshot();
    return {
      ok: this.lastError === undefined,
      dshRunning: snapshot.dshRunning,
      count: snapshot.gauge?.count ?? 0,
      gauge: snapshot.gauge,
      db: snapshot.db,
      config: state.config,
      pending: state.pending,
      lastPrune: state.lastPrune,
      preview: state.preview,
      history: state.history.slice(-14),
      backups: snapshot.backups.slice(0, 3),
      readError: snapshot.readError,
      generated: snapshot.generated,
    };
  }

  /** Agent 工具：预演或清理。`dryRun` 默认 true。 */
  async toolPrune(args: { dryRun?: boolean; keepDays?: number; keepMax?: number }): Promise<Record<string, unknown>> {
    const dryRun = args.dryRun !== false;
    const result = dryRun
      ? await this.plan(args.keepDays === undefined && args.keepMax === undefined ? undefined : { keepDays: args.keepDays, keepMax: args.keepMax })
      : await this.prune({ dryRun: false, requestedBy: 'tool', config: { keepDays: args.keepDays, keepMax: args.keepMax } });
    const snapshot = this.buildSnapshot();
    return { ok: result.ok, message: result.message, dryRun, preview: snapshot.preview, pending: snapshot.pending, lastPrune: snapshot.lastPrune };
  }

  /** Agent 工具：读/写保留策略。 */
  async toolConfig(args: { keepDays?: number; keepMax?: number }): Promise<Record<string, unknown>> {
    if (args.keepDays === undefined && args.keepMax === undefined) {
      return { ok: true, config: this.store.current.config };
    }
    const result = await this.setConfig({ keepDays: args.keepDays, keepMax: args.keepMax });
    return { ok: result.ok, message: result.message, config: this.store.current.config };
  }

  // ---- 内部 ----

  /** 串行执行：探测与写库不能并发（页面可能连点）。 */
  private enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async handleRequest(request: PluginRequest): Promise<void> {
    await this.store.update((state) => ({ ...state, lastRequestId: request.id }));
    let result: ActionResult;
    try {
      if (request.action === 'refresh') {
        const refreshed = await this.refresh(true);
        result = refreshed.ok ? { ok: true, message: '已重新读取 cookie 库' } : { ok: false, message: `刷新失败：${refreshed.reason ?? '未知原因'}` };
      } else if (request.action === 'plan') {
        result = await this.plan(request.config);
      } else if (request.action === 'prune') {
        result = await this.prune({ dryRun: false, requestedBy: 'page', config: request.config });
      } else if (request.action === 'cancel-pending') {
        result = await this.cancelPending();
      } else {
        result = await this.setConfig(request.config);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('error', `处理页面请求失败：${message}`);
      result = { ok: false, message: `处理失败：${message}` };
    }
    await this.writeReply(request, result);
  }

  private async writeReply(request: PluginRequest, result: ActionResult): Promise<void> {
    const reply: Reply = {
      id: request.id,
      action: request.action,
      ok: result.ok,
      message: result.message,
      at: new Date().toISOString(),
    };
    await this.store.update((state) => ({ ...state, reply }));
    this.emit();
  }

  /** 巡检：先处理排队清理（DSH 可能刚退出），再按缓存节流刷新。 */
  private async tick(initial = false): Promise<void> {
    try {
      await this.runQueuedPrune();
      const lastAt = this.lastGood?.at ?? 0;
      if (initial || Date.now() - lastAt >= CACHE_MS) await this.refresh(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('error', `巡检失败：${message}`);
    }
  }

  private async runQueuedPrune(): Promise<void> {
    const pending = this.store.current.pending;
    if (pending === null) return;
    if (this.running(true)) return;

    await this.enqueue(async () => {
      // 排队期间可能被取消，重新读一次。
      const latest = this.store.current.pending;
      if (latest === null) return;
      let outcome;
      try {
        outcome = pruneDatabase({
          dbPath: this.dbFile,
          backupDir: this.backupsDir,
          config: { keepDays: latest.keepDays, keepMax: latest.keepMax },
          dryRun: false,
          keepBackups: KEEP_BACKUPS,
          running: this.running,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lastPrune = {
          at: new Date().toISOString(),
          ok: false,
          dryRun: false,
          removed: 0,
          remaining: 0,
          backup: null,
          error: maskText(message),
          cutoff: null,
        };
        // 异常（不是「库被锁」）不再重试，避免每 20 秒撞同一个错；结果写进看板。
        await this.store.update((state) => ({ ...state, lastPrune, pending: null }));
        this.log('error', `排队清理异常：${maskText(message)}`);
        this.emit();
        return;
      }
      const lastPrune = {
        at: new Date().toISOString(),
        ok: outcome.ok,
        dryRun: false,
        removed: outcome.ok ? outcome.removed : 0,
        remaining: outcome.ok ? outcome.remaining : 0,
        backup: outcome.ok ? outcome.backup : null,
        error: outcome.ok ? null : outcome.reason,
        cutoff: outcome.ok ? outcome.cutoff : null,
      };
      await this.store.update((state) => ({ ...state, lastPrune, pending: null, preview: null }));
      this.log(outcome.ok ? 'info' : 'error', outcome.ok ? `排队清理完成：删除 ${outcome.removed} 条` : `排队清理失败：${outcome.reason}`);
      await this.refreshNow(true);
      this.emit();
    });
  }

  /** 刷新探测（带缓存）。 */
  async refresh(force: boolean): Promise<{ ok: boolean; reason?: string }> {
    return this.enqueue(() => this.refreshNow(force));
  }

  private async refreshNow(force: boolean): Promise<{ ok: boolean; reason?: string }> {
    if (!force && this.lastGood !== undefined && Date.now() - this.lastGood.at < CACHE_MS) return { ok: true };

    // 让出一次事件循环，别和宿主的流式输出抢同一拍。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    let size = 0;
    try {
      size = statSync(this.dbFile).size;
    } catch {
      size = 0;
    }

    const probe = await this.probe();
    if (!probe.ok) {
      this.lastError = probe.reason;
      this.lastLocked = probe.locked;
      this.emit();
      return { ok: false, reason: probe.reason };
    }

    const { summary, rows, source, note } = probe;
    this.lastError = note !== undefined ? note : undefined;
    this.lastLocked = source === 'borrowed-handle';
    this.lastGood = {
      at: Date.now(),
      db: {
        path: prettyPath(this.dbFile),
        size,
        dshCount: summary.dshCount,
        otherCount: summary.otherCount,
        oldest: summary.oldestMs !== null ? new Date(summary.oldestMs).toISOString() : null,
        newest: summary.newestMs !== null ? new Date(summary.newestMs).toISOString() : null,
        source,
      },
      gauge: gaugeOf(summary.dshCount),
      days: summary.days.slice(-30),
      rows,
    };
    await this.store.recordSnapshot(summary.dshCount);
    this.emit();
    return { ok: true };
  }

  /** 同一时刻只跑一个探测：页面连点或加载与巡检撞上时复用同一份结果。 */
  private probe(): Promise<ProbeResult> {
    if (this.inflightProbe === undefined) {
      this.inflightProbe = probeDatabase(this.dbFile).finally(() => {
        this.inflightProbe = undefined;
      });
    }
    return this.inflightProbe;
  }

  /** 预演清理。 */
  async plan(configPatch?: Partial<RetentionConfig>): Promise<ActionResult> {
    return this.enqueue(async () => {
      const config = normalizeConfig({ ...this.store.current.config, ...configPatch });
      // DSH 运行时读库要借句柄（慢），直接用最近一次探测到的行；没探测过就先探一次。
      let plan;
      if (this.running()) {
        if (this.lastGood === undefined) {
          const refreshed = await this.refreshNow(true);
          if (!refreshed.ok) return { ok: false, message: `预演失败：${refreshed.reason ?? '读不到 cookie 库'}` };
        }
        plan = planRetention(this.lastGood?.rows ?? [], config, Date.now());
      } else {
        const result = planPrune({ dbPath: this.dbFile, backupDir: this.backupsDir, config, dryRun: true, running: this.running });
        if (!result.ok) return { ok: false, message: `预演失败：${result.reason}` };
        plan = result.plan;
      }
      const preview = {
        at: new Date().toISOString(),
        cutoff: new Date(plan.cutoffMs).toISOString(),
        remove: plan.drop.length,
        keep: plan.keep.length,
        removeBytes: plan.droppedBytes,
      };
      await this.store.update((state) => ({ ...state, preview }));
      this.emit();
      const message =
        plan.drop.length === 0
          ? `预演：没有可清理的，${plan.keep.length} 条都在保留期内（保留最近 ${config.keepDays} 天 / 最多 ${config.keepMax} 条）`
          : `预演：将删除 ${plan.drop.length} 条、保留 ${plan.keep.length} 条（cutoff ${preview.cutoff}）`;
      return { ok: true, message };
    });
  }

  /** 执行清理；DSH 运行中则排队（页面按钮用这个）。 */
  async prune(options: { dryRun: boolean; requestedBy: 'page' | 'tool' | 'cli' | 'auto'; config?: Partial<RetentionConfig> }): Promise<ActionResult> {
    if (options.dryRun) return this.plan(options.config);

    return this.enqueue(async () => {
      const config = normalizeConfig({ ...this.store.current.config, ...options.config });
      const active = this.running(true);
      if (active) {
        // 先看看是否真的有事可做：没有可删的就不必排队。
        if (this.lastGood === undefined) await this.refreshNow(false);
        const rows = this.lastGood?.rows;
        if (rows !== undefined) {
          const plan = planRetention(rows, config, Date.now());
          if (plan.drop.length === 0) {
            return {
              ok: true,
              message: `没有需要清理的，${plan.keep.length} 条都在保留期内（保留最近 ${config.keepDays} 天 / 最多 ${config.keepMax} 条）`,
            };
          }
        }
        const pending = {
          at: new Date().toISOString(),
          keepDays: config.keepDays,
          keepMax: config.keepMax,
          requestedBy: options.requestedBy,
        };
        await this.store.update((state) => ({ ...state, pending }));
        this.emit();
        return {
          ok: true,
          message: `DSH 正在运行，cookie 库还在使用中。已安排：退出 DSH 后自动清理（保留最近 ${config.keepDays} 天 / 最多 ${config.keepMax} 条）`,
        };
      }
      return this.pruneUnlocked(config, options.requestedBy);
    });
  }

  /** 离线清理（CLI 用）：DSH 必须已退出，排队不适用，锁着就直接报错。 */
  async pruneNow(options: { requestedBy: 'cli' | 'auto'; config?: Partial<RetentionConfig> }): Promise<ActionResult> {
    return this.enqueue(async () => {
      const config = normalizeConfig({ ...this.store.current.config, ...options.config });
      if (this.running(true)) {
        return { ok: false, message: 'DSH 正在运行：请先完全退出 DSH（Windows 托盘退出；macOS/Linux 退出应用，确认没有残留进程）再清理' };
      }
      return this.pruneUnlocked(config, options.requestedBy);
    });
  }

  /** 真正写库的那一步；调用方必须已经确认库没被锁。 */
  private async pruneUnlocked(config: RetentionConfig, _requestedBy: 'page' | 'tool' | 'cli' | 'auto'): Promise<ActionResult> {
    let outcome;
    try {
      outcome = pruneDatabase({
        dbPath: this.dbFile,
        backupDir: this.backupsDir,
        config,
        dryRun: false,
        keepBackups: KEEP_BACKUPS,
        running: this.running,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `清理异常，未写入状态：${maskText(message)}` };
    }
    const lastPrune = {
      at: new Date().toISOString(),
      ok: outcome.ok,
      dryRun: false,
      removed: outcome.ok ? outcome.removed : 0,
      remaining: outcome.ok ? outcome.remaining : 0,
      backup: outcome.ok ? outcome.backup : null,
      error: outcome.ok ? null : outcome.reason,
      cutoff: outcome.ok ? outcome.cutoff : null,
    };
    await this.store.update((state) => ({ ...state, lastPrune, preview: outcome.ok ? null : state.preview }));
    await this.refreshNow(true);
    this.emit();
    if (!outcome.ok) return { ok: false, message: `清理失败：${outcome.reason}` };
    const message =
      outcome.removed === 0
        ? `没有需要清理的，${outcome.remaining} 条都在保留期内`
        : `已删除 ${outcome.removed} 条，保留 ${outcome.remaining} 条${outcome.backup !== null ? `（备份 ${outcome.backup}）` : ''}`;
    return { ok: true, message };
  }

  /** 取消排队。 */
  async cancelPending(): Promise<ActionResult> {
    return this.enqueue(async () => {
      const had = this.store.current.pending !== null;
      await this.store.update((state) => ({ ...state, pending: null }));
      this.emit();
      return { ok: true, message: had ? '已取消退出后的自动清理' : '当前没有排队中的清理' };
    });
  }

  /** 保存保留策略。 */
  async setConfig(patch: Partial<RetentionConfig> | undefined): Promise<ActionResult> {
    return this.enqueue(async () => {
      const config = normalizeConfig({ ...this.store.current.config, ...patch });
      await this.store.update((state) => ({ ...state, config }));
      this.emit();
      return { ok: true, message: `保留策略已保存：最近 ${config.keepDays} 天 / 最多 ${config.keepMax} 条` };
    });
  }

  /** 组装快照并写 page/data.js。 */
  private emit(): Snapshot {
    const snapshot = this.buildSnapshot();
    try {
      writePageData(this.pageDataFile, snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('error', `写页面数据失败：${message}`);
    }
    return snapshot;
  }

  private buildSnapshot(): Snapshot {
    const state: StoredState = this.store.current;
    const good = this.lastGood;
    const backups: BackupInfo[] = listBackups(this.backupsDir);
    return {
      build: 1,
      generated: new Date().toISOString(),
      state: good !== undefined ? 'ok' : this.lastError !== undefined ? 'error' : 'unknown',
      dshRunning: this.running() || good?.db.source === 'borrowed-handle' || (good === undefined && this.lastLocked),
      stale: good !== undefined && Date.now() - good.at > CACHE_MS * 2,
      db: good?.db ?? null,
      gauge: good?.gauge ?? null,
      days: good?.days ?? [],
      history: state.history,
      config: state.config,
      preview: state.preview,
      pending: state.pending,
      lastPrune: state.lastPrune,
      reply: state.reply,
      backups,
      readError: this.lastError ?? null,
    };
  }

  /** 给气泡/日志用的一句话。 */
  bubbleText(): string {
    const gauge = this.lastGood?.gauge;
    if (gauge === undefined) return `读不到 cookie 库：${this.lastError ?? '还没读到'}`;
    return cookieBubbleText(gauge);
  }
}
