/**
 * magpie 插件入口。
 *
 * magpie 在启动、插件开关变化、页面把请求写进插件 options 后都会重新调用这个函数。
 * 这里只做三件事：拿到（或复用）服务、启动巡检、把新请求交给服务——**不阻塞**，
 * 因为插件加载有 20 秒上限，而首次借 Windows 句柄可能要 4 秒。
 * @module magpie-dsh-cookie/index
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { magpieConfigDir } from './src/paths.ts';
import { CookieService, type ServiceOptions } from './src/service.ts';

/** 同一个插件宿主进程里只保留一个服务实例（插件重载会再次调用入口）。 */
const SERVICE_KEY = Symbol.for('magpie-dsh-cookie.service');

/** OpenCode v1 PluginInput 里我们用得到的字段。 */
interface PluginInput {
  readonly directory?: string;
  readonly client?: { readonly app?: { readonly log?: (entry: unknown) => void } };
}

/** 拿服务；目录变了才重建。 */
function serviceFor(directory: string, pluginRoot: string): CookieService {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  const existing = holder[SERVICE_KEY];
  if (existing instanceof CookieService) return existing;
  const options: ServiceOptions = {
    directory,
    pluginRoot,
    log: (level, message) => {
      console.error(`[magpie-dsh-cookie] ${level}: ${message}`);
    },
  };
  const service = new CookieService(options);
  holder[SERVICE_KEY] = service;
  return service;
}

/** magpie 插件函数。 */
export const DshCookiePlugin = async (input: PluginInput, options: unknown) => {
  const pluginRoot = dirname(fileURLToPath(import.meta.url));
  const directory = typeof input?.directory === 'string' && input.directory !== '' ? input.directory : magpieConfigDir();
  const service = serviceFor(directory, pluginRoot);
  service.start();
  service.applyOptions(options);

  return {
    tool: {
      dsh_cookie_status: {
        description:
          '查看 DeepSeek Harness 桌面版登录 cookie 的现状：条数、请求头占用百分比、还能再启动几次、按创建日期分布、累计历史。只读，不返回 cookie 值。',
        args: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => service.status(),
      },
      dsh_cookie_prune: {
        description:
          '清理 DSH 登录 cookie，保留最近 N 天（默认 7 天）且最多 M 条（默认 40 条），永远保留最新一条。默认只预演（dryRun=true），要真删必须显式传 dryRun=false；DSH 运行中无法写库，会改成「退出 DSH 后自动清理」排队。',
        args: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean', description: '默认 true，只预演不写库；false 才真正删除' },
            keepDays: { type: 'integer', minimum: 0, maximum: 90, description: '保留最近几天，默认 7' },
            keepMax: { type: 'integer', minimum: 1, maximum: 72, description: '最多保留几条，默认 40' },
          },
          additionalProperties: false,
        },
        execute: (args: { dryRun?: boolean; keepDays?: number; keepMax?: number }) => service.toolPrune(args ?? {}),
      },
      dsh_cookie_config: {
        description: '查看或保存 DSH cookie 的保留策略（keepDays 保留天数、keepMax 最多条数）。不传参数就是查看。',
        args: {
          type: 'object',
          properties: {
            keepDays: { type: 'integer', minimum: 0, maximum: 90, description: '保留最近几天' },
            keepMax: { type: 'integer', minimum: 1, maximum: 72, description: '最多保留几条' },
          },
          additionalProperties: false,
        },
        execute: (args: { keepDays?: number; keepMax?: number }) => service.toolConfig(args ?? {}),
      },
    },
  };
};
