/**
 * 读被 Chromium 独占打开的 cookie 库（`Network/Cookies`）。
 *
 * DSH 运行期间桌面外壳对该文件是独占打开，`open()` / `copyFile()` 只会拿到 EBUSY；
 * 这里走 Windows 句柄表：`CreateToolhelp32Snapshot` 找 DSH 进程 →
 * `NtQuerySystemInformation(SystemExtendedHandleInformation)` 枚举句柄 →
 * 对每个文件句柄 `DuplicateHandle` 复制一份 → `GetFinalPathNameByHandleW` 比对路径 →
 * 在副本上 `SetFilePointer` + `ReadFile` 读字节。读不到就把原因原样交回调用方，绝不猜数。
 *
 * Bun 自带 FFI（`bun:ffi`），所以不需要像 dsh-pet 那样借 DSH 的 koffi。
 * 性能提示：在全新的 Bun 进程里，第一次 `OpenProcess(PROCESS_DUP_HANDLE)` 打开
 * Chromium 主进程可能要 3–4 秒（本机有安全软件介入），之后同一进程内是亚毫秒级——
 * 所以结果要缓存，不要把探测挂在每秒轮询上。
 * @module magpie-dsh-cookie/src/win32
 */
import { dlopen } from 'bun:ffi';
import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { prettyPath } from './paths.ts';

/** 句柄类返回值：`ptr` 在 Bun 里是 bigint，空值可能是 null / 0 / 0n。 */
type Handle = bigint | number | null | undefined;

/** 读库结论。`locked` 说明「文件被独占」，即 DSH 很可能正在运行。 */
export type JarBytes =
  | { readonly ok: true; readonly raw: Buffer; readonly source: 'file' | 'borrowed-handle' }
  | { readonly ok: false; readonly reason: string; readonly locked: boolean };

/** TH32CS_SNAPPROCESS */
const SNAPSHOT_PROCESSES = 0x2;
/** PROCESSENTRY32W 的字节数。 */
const PROCESS_ENTRY_BYTES = 568;
/** SystemExtendedHandleInformation。 */
const HANDLE_INFORMATION_CLASS = 64;
/** 句柄表条目步长。 */
const HANDLE_ENTRY_STRIDE = 40;
/** PROCESS_DUP_HANDLE */
const PROCESS_DUP_HANDLE = 0x40;
/** DUPLICATE_SAME_ACCESS */
const DUPLICATE_SAME_ACCESS = 0x2;
/** STATUS_BUFFER_TOO_SMALL */
const STATUS_BUFFER_TOO_SMALL = 0xc0000004;
/** 句柄表初始缓冲；本机约 18 万条，32 MB 一次够。 */
const HANDLE_TABLE_INITIAL_BYTES = 32 << 20;
/** 缓冲不够时的余量。 */
const HANDLE_TABLE_SLACK_BYTES = 4 << 20;
/** 单次读取块。 */
const READ_CHUNK_BYTES = 1 << 20;
/** 读取总量上限：cookie 库正常只有几十 KB，8 MB 已远超。 */
const READ_LIMIT_BYTES = 8 << 20;
/** 路径缓冲的宽字符数。 */
const PATH_CHARS = 4096;
/** 目标库在句柄路径里的后缀（小写比对）。 */
const TARGET_SUFFIX = '\\network\\cookies';
/** 分区库（平台登录）不在这里统计。 */
const PARTITION_MARK = 'partitions';

/** DSH 桌面版的进程名特征（小写）。 */
const DSH_EXE_MARKS = ['deepseek', 'dsh-desktop'];

type Symbols = Record<string, (...args: never[]) => never>;

interface NativeApi {
  readonly kernel32: Symbols;
  readonly ntdll: Symbols;
}

let apiCache: { readonly ok: true; readonly api: NativeApi } | { readonly ok: false; readonly reason: string } | undefined;

/** 载入 kernel32 / ntdll；失败只回原因。 */
function nativeApi(): { readonly ok: true; readonly api: NativeApi } | { readonly ok: false; readonly reason: string } {
  if (apiCache !== undefined) return apiCache;
  if (process.platform !== 'win32') {
    apiCache = { ok: false, reason: '仅 Windows 支持在线读数（DSH 运行时借句柄）' };
    return apiCache;
  }
  try {
    apiCache = {
      ok: true,
      api: {
        kernel32: dlopen('kernel32.dll', {
          CreateToolhelp32Snapshot: { args: ['u32', 'u32'], returns: 'ptr' },
          Process32FirstW: { args: ['ptr', 'ptr'], returns: 'i32' },
          Process32NextW: { args: ['ptr', 'ptr'], returns: 'i32' },
          OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'ptr' },
          CloseHandle: { args: ['ptr'], returns: 'i32' },
          DuplicateHandle: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'u32', 'i32', 'u32'], returns: 'i32' },
          GetFinalPathNameByHandleW: { args: ['ptr', 'ptr', 'u32', 'u32'], returns: 'u32' },
          SetFilePointer: { args: ['ptr', 'i32', 'ptr', 'u32'], returns: 'u32' },
          ReadFile: { args: ['ptr', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'i32' },
          GetCurrentProcess: { args: [], returns: 'ptr' },
          GetFileType: { args: ['ptr'], returns: 'u32' },
        }).symbols as Symbols,
        ntdll: dlopen('ntdll.dll', {
          NtQuerySystemInformation: { args: ['u32', 'ptr', 'u32', 'ptr'], returns: 'i32' },
        }).symbols as Symbols,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    apiCache = { ok: false, reason: `加载 Win32 接口失败：${message}` };
  }
  return apiCache;
}

/** 空句柄判断。 */
function isNullHandle(handle: Handle): boolean {
  return handle === null || handle === undefined || handle === 0 || handle === 0n;
}

/** 文件是否被独占（DSH 运行中）；missing 表示路径不存在。 */
export function fileLockState(file: string): 'free' | 'locked' | 'missing' {
  try {
    const fd = openSync(file, 'r');
    closeSync(fd);
    return 'free';
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'locked';
    return 'locked';
  }
}

/** 直接读（DSH 未运行时走这条，快且不需要 FFI）。 */
function readDirectly(file: string): Buffer | undefined {
  try {
    const fd = openSync(file, 'r');
    try {
      const size = statSync(file).size;
      const buffer = Buffer.alloc(Math.max(size, 1) + READ_CHUNK_BYTES);
      let offset = 0;
      while (offset < buffer.length) {
        const got = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (got <= 0) break;
        offset += got;
      }
      if (offset === 0) return undefined;
      return Buffer.from(buffer.subarray(0, offset));
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** 找出可能打开着 cookie 库的进程：DSH 桌面版外壳与子进程。 */
function dshProcessIdsOf(api: NativeApi): number[] {
  const snapshot = api.kernel32.CreateToolhelp32Snapshot(SNAPSHOT_PROCESSES, 0);
  if (isNullHandle(snapshot)) return [];
  const entry = Buffer.alloc(PROCESS_ENTRY_BYTES);
  entry.writeUInt32LE(PROCESS_ENTRY_BYTES, 0);
  const found: number[] = [];
  try {
    let more = api.kernel32.Process32FirstW(snapshot, entry) !== 0;
    while (more) {
      const pid = entry.readUInt32LE(8);
      const exe = entry
        .toString('utf16le', 44, 44 + 520)
        .split('\u0000')[0]
        ?.toLowerCase();
      if (pid !== process.pid && typeof exe === 'string' && DSH_EXE_MARKS.some((mark) => exe.includes(mark))) {
        found.push(pid);
      }
      more = api.kernel32.Process32NextW(snapshot, entry) !== 0;
    }
  } finally {
    api.kernel32.CloseHandle(snapshot as never);
  }
  return found;
}

/**
 * 枚举全机句柄表，把 DSH 进程里指向 cookie 库的句柄复制出来，读完整字节。
 * @returns 文件字节；没有命中返回 undefined。
 */
function readThroughOpenHandle(api: NativeApi, pids: readonly number[]): Buffer | undefined {
  let size = HANDLE_TABLE_INITIAL_BYTES;
  let table = Buffer.alloc(size);
  const needed = Buffer.alloc(4);
  let status = Number(api.ntdll.NtQuerySystemInformation(HANDLE_INFORMATION_CLASS, table as never, size, needed as never)) >>> 0;
  if (status === STATUS_BUFFER_TOO_SMALL) {
    size = needed.readUInt32LE(0) + HANDLE_TABLE_SLACK_BYTES;
    table = Buffer.alloc(size);
    status = Number(api.ntdll.NtQuerySystemInformation(HANDLE_INFORMATION_CLASS, table as never, size, needed as never)) >>> 0;
  }
  if (status !== 0) throw new Error(`NtQuerySystemInformation 0x${status.toString(16)}`);

  const total = table.readUInt32LE(0);
  const wanted = new Set(pids);
  /** 每个进程只 OpenProcess 一次：句柄表里同进程的句柄成百上千，逐个打开会慢一个量级。 */
  const byPid = new Map<number, number[]>();
  for (let index = 0; index < total; index += 1) {
    const base = 16 + index * HANDLE_ENTRY_STRIDE;
    const pid = Number(table.readBigUInt64LE(base + 8));
    if (!wanted.has(pid)) continue;
    const list = byPid.get(pid);
    if (list === undefined) byPid.set(pid, [base]);
    else list.push(base);
  }

  const self = api.kernel32.GetCurrentProcess();
  const pathBuffer = Buffer.alloc(PATH_CHARS * 2);
  const handleOut = Buffer.alloc(8);
  const readBuffer = Buffer.alloc(READ_CHUNK_BYTES);
  const readOut = Buffer.alloc(4);

  for (const [pid, bases] of byPid) {
    const processHandle = api.kernel32.OpenProcess(PROCESS_DUP_HANDLE, 0, pid);
    if (isNullHandle(processHandle)) continue;
    try {
      for (const base of bases) {
        const handle = table.readBigUInt64LE(base + 16);
        const copied = Number(api.kernel32.DuplicateHandle(processHandle, handle as never, self as never, handleOut as never, 0, 0, DUPLICATE_SAME_ACCESS));
        if (copied === 0) continue;
        const duplicate = handleOut.readBigUInt64LE(0);
        try {
          // 只认磁盘文件：管道、事件等句柄不参与路径比对。
          if (api.kernel32.GetFileType(duplicate as never) !== 1) continue;
          const length = Number(api.kernel32.GetFinalPathNameByHandleW(duplicate as never, pathBuffer as never, PATH_CHARS, 0));
          const path = length > 0 ? pathBuffer.toString('utf16le', 0, length * 2).toLowerCase() : '';
          if (!path.endsWith(TARGET_SUFFIX) || path.includes(PARTITION_MARK)) continue;

          api.kernel32.SetFilePointer(duplicate as never, 0, null as never, 0);
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          for (;;) {
            const okRead = api.kernel32.ReadFile(duplicate as never, readBuffer as never, readBuffer.length, readOut as never, null as never) !== 0;
            const count = readOut.readUInt32LE(0);
            if (!okRead || count === 0) break;
            chunks.push(Buffer.from(readBuffer.subarray(0, count)));
            totalBytes += count;
            if (count < readBuffer.length || totalBytes >= READ_LIMIT_BYTES) break;
          }
          return Buffer.concat(chunks);
        } finally {
          api.kernel32.CloseHandle(duplicate as never);
        }
      }
    } finally {
      api.kernel32.CloseHandle(processHandle as never);
    }
  }
  return undefined;
}

/**
 * 取 cookie 库的原始字节：先试直接读，被锁时再借 DSH 已打开的句柄。
 * @param file - cookie 库绝对路径。
 */
export function readJarBytes(file: string): JarBytes {
  const direct = readDirectly(file);
  if (direct !== undefined && direct.length > 0) return { ok: true, raw: direct, source: 'file' };

  const state = fileLockState(file);
  if (state === 'missing') return { ok: false, reason: `找不到 cookie 库：${prettyPath(file)}`, locked: false };

  // macOS / Linux 没有强制文件锁，Chromium 开着也能直接读；读不到就是路径或权限问题。
  if (process.platform !== 'win32') {
    return { ok: false, reason: `读不到 cookie 库：${prettyPath(file)}（路径不对或权限不足）`, locked: false };
  }

  const ffi = nativeApi();
  if (!ffi.ok) return { ok: false, reason: ffi.reason, locked: state === 'locked' };

  let pids: number[];
  try {
    pids = dshProcessIdsOf(ffi.api);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `枚举进程失败：${message}`, locked: state === 'locked' };
  }
  if (pids.length === 0) {
    return {
      ok: false,
      reason: state === 'locked' ? 'cookie 库被独占，但没有找到 DSH 进程' : '没有找到正在运行的 DSH 进程',
      locked: state === 'locked',
    };
  }

  let raw: Buffer | undefined;
  try {
    raw = readThroughOpenHandle(ffi.api, pids);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `借句柄失败：${message}`, locked: state === 'locked' };
  }
  if (raw === undefined || raw.length === 0) {
    return { ok: false, reason: '没能从运行中的 DSH 借到 cookie 库句柄', locked: state === 'locked' };
  }
  return { ok: true, raw, source: 'borrowed-handle' };
}

/**
 * 当前运行中的 DSH 进程（仅 Windows 有实现；其他平台返回空数组）。
 * 供「是否要拦下清理」判断用。
 */
export function dshProcessIds(): number[] {
  if (process.platform !== 'win32') return [];
  const ffi = nativeApi();
  if (!ffi.ok) return [];
  try {
    return dshProcessIdsOf(ffi.api);
  } catch {
    return [];
  }
}
