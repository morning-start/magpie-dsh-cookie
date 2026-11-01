/**
 * 探测任务放进 Worker 线程跑：借句柄那套是同步 FFI，第一次在个别机器上要 3–4 秒，
 * 留在插件宿主线程里会把 magpie 的网关请求一起卡住。Worker 独立线程，宿主照常服务。
 *
 * 失败时回退到当前线程执行（保证任何环境都有数），两条路给同一形状的结果。
 * @module magpie-dsh-cookie/src/probe
 */
import { Worker } from 'node:worker_threads';

import { parseJarBytes, summarize, type JarRow, type JarSummary } from './jar.ts';
import { readJarBytes } from './win32.ts';

/** 一次探测的结论。 */
export type ProbeResult =
  | {
      readonly ok: true;
      readonly source: 'file' | 'borrowed-handle';
      readonly summary: JarSummary;
      readonly rows: JarRow[];
      readonly datesKnown: boolean;
      readonly note?: string;
      readonly elapsedMs: number;
    }
  | { readonly ok: false; readonly reason: string; readonly locked: boolean; readonly elapsedMs: number };

/** Worker 结果的消息形状（与 probe-worker 约定）。 */
export interface ProbeMessage {
  readonly ok: boolean;
  readonly source?: 'file' | 'borrowed-handle';
  readonly summary?: JarSummary;
  readonly rows?: JarRow[];
  readonly datesKnown?: boolean;
  readonly note?: string;
  readonly reason?: string;
  readonly locked?: boolean;
}

/** 默认超时：首次借句柄在慢机器上要 4 秒，留足余量。 */
const PROBE_TIMEOUT_MS = 30_000;

/** 在当前线程探测（兜底路径）。 */
function probeHere(dbPath: string): ProbeResult {
  const started = Date.now();
  const read = readJarBytes(dbPath);
  if (!read.ok) return { ok: false, reason: read.reason, locked: read.locked, elapsedMs: Date.now() - started };
  const parsed = parseJarBytes(read.raw);
  const summary = summarize(parsed.rows);
  return {
    ok: true,
    source: read.source,
    summary,
    rows: parsed.rows,
    datesKnown: parsed.datesKnown,
    note: parsed.note,
    elapsedMs: Date.now() - started,
  };
}

/**
 * 探测一次 cookie 库。
 * @param dbPath - 库路径。
 * @param timeoutMs - Worker 超时；超时就终结 Worker 并回退到当前线程。
 */
export async function probeDatabase(dbPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const started = Date.now();
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL('./probe-worker.ts', import.meta.url), { workerData: { dbPath }, type: 'module' });
  } catch {
    return probeHere(dbPath);
  }

  try {
    const message = await new Promise<ProbeMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker timeout')), timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      worker?.once('message', (value: ProbeMessage) => {
        clearTimeout(timer);
        resolve(value);
      });
      worker?.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker?.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`probe worker 退出码 ${code}`));
      });
    });
    if (message.ok === true && message.summary !== undefined && message.rows !== undefined) {
      return {
        ok: true,
        source: message.source ?? 'file',
        summary: message.summary,
        rows: message.rows,
        datesKnown: message.datesKnown !== false,
        note: message.note,
        elapsedMs: Date.now() - started,
      };
    }
    return { ok: false, reason: message.reason ?? '探测失败', locked: message.locked === true, elapsedMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Worker 不可用或超时：退回当前线程，宁可慢一点也要有结果。
    const inline = probeHere(dbPath);
    if (inline.ok) return inline;
    return { ...inline, reason: `${inline.reason}（Worker 探测失败：${message}）` };
  } finally {
    void worker?.terminate();
  }
}
