/**
 * Bun 运行时的最小类型声明：插件宿主只跑在 Bun 里，这里不引入 @types/bun
 * （避免为了类型装一整套依赖），只声明本项目实际用到的两个模块。
 * @module magpie-dsh-cookie/types/bun-shims
 */

declare module "bun:ffi" {
  export interface SymbolDef {
    args: string[];
    returns: string;
  }
  export function dlopen(
    library: string,
    symbols: Record<string, SymbolDef>,
  ): { symbols: Record<string, (...args: never[]) => never> };
  export function toArrayBuffer(ptr: number, byteOffset?: number, byteLength?: number): ArrayBuffer;
}

declare module "bun:sqlite" {
  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  export class Statement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): RunResult;
  }
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean; strict?: boolean });
    query(sql: string): Statement;
    prepare(sql: string): Statement;
    run(sql: string, ...params: unknown[]): RunResult;
    exec(sql: string): void;
    close(): void;
  }
}
