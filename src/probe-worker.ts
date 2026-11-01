/**
 * Worker 线程里的探测体：读库字节 → 解析 → 汇总，结果 postMessage 回宿主。
 * @module magpie-dsh-cookie/src/probe-worker
 */
import { parentPort, workerData } from 'node:worker_threads';

import { parseJarBytes, summarize } from './jar.ts';
import { readJarBytes } from './win32.ts';
import type { ProbeMessage } from './probe.ts';

const dbPath = typeof (workerData as { dbPath?: unknown })?.dbPath === 'string' ? (workerData as { dbPath: string }).dbPath : '';

const post = (message: ProbeMessage): void => {
  parentPort?.postMessage(message);
};

if (dbPath === '') {
  post({ ok: false, reason: '没有给 cookie 库路径', locked: false });
} else {
  try {
    const read = readJarBytes(dbPath);
    if (!read.ok) {
      post({ ok: false, reason: read.reason, locked: read.locked });
    } else {
      const parsed = parseJarBytes(read.raw);
      post({
        ok: true,
        source: read.source,
        summary: summarize(parsed.rows),
        rows: parsed.rows,
        datesKnown: parsed.datesKnown,
        note: parsed.note,
      });
    }
  } catch (error) {
    post({ ok: false, reason: error instanceof Error ? error.message : String(error), locked: false });
  }
}
