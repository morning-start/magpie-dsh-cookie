/**
 * 路径与常量：DSH 桌面版的 cookie 库位置、本插件的数据目录、页面快照文件。
 *
 * 只做路径解析，不读不写。桌面版把用户数据放在 Electron 的 userData 目录里，
 * 三个平台的默认位置（已对照 deepseek-harness 仓库 discussion #11160 / #10802 核实）：
 * - Windows：`%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies`
 * - macOS：`~/Library/Application Support/@deepseek-ai/dsh-desktop/Network/Cookies`
 * - Linux：`~/.config/@deepseek-ai/dsh-desktop/Network/Cookies`
 *
 * 环境变量覆盖是给排查、换安装形态和测试用的：
 * - `MAGPIE_DSH_COOKIE_DB`：cookie 库路径
 * - `MAGPIE_DSH_COOKIE_DATA`：本插件数据目录（默认 <magpie 配置目录>/dsh-cookie）
 * @module magpie-dsh-cookie/src/paths
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** DSH 桌面版在 Electron userData 下的目录名。 */
export const DSH_PROFILE_DIR = '@deepseek-ai/dsh-desktop';

/** 默认保留天数。 */
export const DEFAULT_KEEP_DAYS = 7;
/** 默认最多保留条数（时间策略之外的第二道闸；40 条仍在 72 条崩点内，且给最近会话留足）。 */
export const DEFAULT_KEEP_MAX = 40;
/** 备份保留份数。 */
export const KEEP_BACKUPS = 10;
/** 历史快照保留天数。 */
export const HISTORY_DAYS = 90;
/** 一天有多少毫秒。 */
export const DAY_MS = 86_400_000;

/**
 * 把路径里的本机用户目录换成 `~`，用于页面、工具和 CLI 的展示。
 *
 * 库的真实绝对路径只留在进程内部使用；凡是会给用户、Agent 或写进 page/data.js
 * 的地方都过这一层，避免把本地用户名带出去。
 */
export function prettyPath(path: string, home: string = homedir()): string {
  if (path === '' || home === '') return path;
  const normalized = path.replace(/\\/g, '/');
  const normalizedHome = home.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const lowerHome = normalizedHome.toLowerCase();
  if (lower === lowerHome) return '~';
  if (lower.startsWith(`${lowerHome}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/** 正则转义。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把任意文本里出现的本机用户目录替换成 `~`。
 *
 * 用于错误消息：Node / SQLite 的报错经常带完整路径（`EBUSY ... '%USERPROFILE%\...'`），
 * 只对「我们知道的那一个路径变量」做替换不够，必须对整段文本再擦一遍。
 */
export function maskText(text: string, home: string = homedir()): string {
  if (text === '' || home === '') return text;
  let out = text;
  const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')]);
  for (const variant of variants) {
    if (variant === '') continue;
    out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), '~');
  }
  return out;
}

/** Electron userData 根目录（按平台）。 */
function userDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = typeof env.HOME === 'string' && env.HOME.trim() !== '' ? env.HOME.trim() : homedir();
  if (platform === 'win32') {
    const appData = env.APPDATA;
    return typeof appData === 'string' && appData !== '' ? appData : join(home, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support');
  // Linux 与其他类 Unix：Electron 用 XDG_CONFIG_HOME，回退 ~/.config
  const xdg = env.XDG_CONFIG_HOME;
  return typeof xdg === 'string' && xdg.trim() !== '' ? xdg.trim() : join(home, '.config');
}

/**
 * 桌面版 cookie 库的默认位置；DSH 运行期间它由 Chromium 掌管（Windows 独占打开，POSIX 无强制锁）。
 * @param env - 环境变量（测试可注入）。
 * @param platform - 目标平台（测试可注入）。
 */
export function databasePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.MAGPIE_DSH_COOKIE_DB;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return join(userDataRoot(env, platform), ...DSH_PROFILE_DIR.split('/'), 'Network', 'Cookies');
}

/** 平台登录用的分区库目录前缀（不参与统计与清理）。 */
export function partitionNetworkDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(userDataRoot(env, platform), ...DSH_PROFILE_DIR.split('/'), 'Partitions');
}

/** magpie 的配置目录：插件宿主通过 `input.directory` 给，CLI 自己推。 */
export function magpieConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (typeof xdg === 'string' && xdg.trim() !== '') return join(xdg.trim(), 'magpie');
  return join(homedir(), '.config', 'magpie');
}

/** 本插件的数据目录（状态、备份）。 */
export function dataDir(configDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MAGPIE_DSH_COOKIE_DATA;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return join(configDir, 'dsh-cookie');
}

/** 状态文件。 */
export function stateFile(configDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(configDir, env), 'state.json');
}

/** 备份目录。 */
export function backupDir(configDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(configDir, env), 'backups');
}
