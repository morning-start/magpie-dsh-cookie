/**
 * 跨平台的「DSH 是否在运行」判断。
 *
 * 为什么不能只看文件锁：Windows 上 Chromium 对 cookie 库是独占打开，`open()` 直接 EBUSY；
 * 而 macOS / Linux 没有强制文件锁，DSH 开着也能读、`open()` 也会成功，所以必须另找依据
 * 来决定「能不能写库」。这里：
 * - Windows：文件被独占 → 一定在运行；否则再用进程表兜底；
 * - macOS / Linux：用 `ps -A -o pid=,comm=` 找 DSH 进程（读库不受影响，写库必须等它退出）。
 *
 * 结果缓存 2 秒，避免页面每次重绘都去 spawn `ps`；清理前的关键判断用 `force` 跳过缓存。
 * @module magpie-dsh-cookie/src/platform
 */
import { execFileSync } from 'node:child_process';

import { dshProcessIds, fileLockState } from './win32.ts';

/** DSH 进程名特征（小写比对）。 */
const PROCESS_MARKS = ['deepseek harness', 'deepseek-harness', 'deepseek_harness', 'dsh-desktop', 'dsh_desktop', 'dsh desktop'];

/** 一行 `ps` 输出里的进程名是不是 DSH。导出给单测用。 */
export function matchesDshProcess(command: string): boolean {
  const name = command.trim().toLowerCase();
  if (name === '') return false;
  return PROCESS_MARKS.some((mark) => name.includes(mark));
}

/** 跑一次 `ps`，返回是否有 DSH 进程；命令不可用时当作「没在运行」。 */
function posixDshRunning(): boolean {
  try {
    const output = execFileSync('ps', ['-A', '-o', 'pid=,comm='], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    return output.split(/\r?\n/).some((line) => matchesDshProcess(line.replace(/^\s*\d+\s+/, '')));
  } catch {
    return false;
  }
}

interface Cache {
  at: number;
  value: boolean;
}

let cache: Cache = { at: 0, value: false };

/**
 * DSH 是否正在运行。
 * @param dbPath - cookie 库路径；Windows 上先看它是否被独占（最可靠、也最快）。
 * @param force - 跳过 2 秒缓存（写库前的复核用）。
 */
export function isDshRunning(dbPath?: string, force = false): boolean {
  if (dbPath !== undefined && fileLockState(dbPath) === 'locked') return true;
  if (!force && Date.now() - cache.at < 2000) return cache.value;

  let value: boolean;
  if (process.platform === 'win32') {
    try {
      value = dshProcessIds().length > 0;
    } catch {
      value = false;
    }
  } else {
    value = posixDshRunning();
  }
  cache = { at: Date.now(), value };
  return value;
}
