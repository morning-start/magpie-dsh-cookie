# magpie-dsh-cookie 设计

> 目标：在 magpie 里给 DeepSeek Harness（DSH）桌面版的登录 cookie 做一个**能看、能压、能自定义保留天数**的看板，并提供一个完整可跑的服务。

## 1. 问题从哪来

DSH 桌面版每次启动都会在 Chromium 的 cookie 库里写一条新的 `dsh-auth-<43 位>`。路径按平台在 Electron userData 下（已对照 deepseek-harness 仓库 discussion #11160 / #10802 核实）：

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` |
| macOS | `~/Library/Application Support/@deepseek-ai/dsh-desktop/Network/Cookies` |
| Linux | `~/.config/@deepseek-ai/dsh-desktop/Network/Cookies` |

同目录的 `Partitions\<hash>\Network\Cookies` 是平台登录用的独立库，不参与本插件统计与清理。`Cookies-journal` 是 SQLite 回滚日志：上次异常退出留下热日志时，先让 SQLite 自愈再读/再写。

| 项 | 数值 |
| --- | --- |
| 一条 cookie 在请求头里占 | `dsh-auth-` + 43 字符名 + `=` + 173 字符值 + `; ` = **228 字节** |
| Node 默认 `maxHeaderSize` | **16384 字节** |
| 崩点 | `16384 / 228 ≈ 71.86` → **第 72 条**时 Host 根请求被 431 挡掉，桌面报 `desktop welcome: Web authentication failed` |
| 实测 | 本机 2026-11-01：两天累积 **26 → 28 条 / 28–32 KB**（每次启动 +1 条） |

旧能力（`dsh-cookie-guard`、`dsh-pet`）只解决了「看」。而看只能告诉你快撞墙了，不能把墙推远。这个插件补上「压」：

- 按**保留最近 N 天**（可自定义）清掉更早的登录 cookie；
- 只清 `dsh-auth-*`，绝不动同一库里其它 cookie（本机实测这个库里 26 条全是 `dsh-auth-*@127.0.0.1`，但代码不假设）；
- 清理前备份、清理后 `PRAGMA integrity_check` 与条数复核，失败自动回滚。

## 2. 为什么必须做成 magpie 插件

DSH 运行期间 `Network/Cookies` 由 Chromium 掌管：Windows 上是**独占打开**，本机实测 `openSync(..., 'r')` 与 `copyFileSync` 都是 `EBUSY`；macOS/Linux 是 POSIX 语义、没有强制文件锁，直接读没问题，但并发写会撞 SQLite 锁。所以：

| 时机 | Windows | macOS / Linux |
| --- | --- | --- |
| DSH 运行中 · 读 | 只能借句柄（枚举句柄表 → `DuplicateHandle` → 读字节） | 直接读文件（POSIX 无强制锁） |
| DSH 运行中 · 写 | 不能（文件被独占） | 不写（会撞 SQLite 锁，也避免与运行中的 Chromium 抢状态） |
| DSH 已退出 · 读写 | 都能（SQLite 事务） | 都能（SQLite 事务） |

`dsh-pet` 活在 DSH 进程内，所以永远等不到「文件解锁」的窗口；magpie 是**常驻独立进程**，两个窗口都拿得到。这是把清理放进 magpie 的根本理由，不是「顺手换个地方」。

## 3. 能力清单（这个服务有什么）

### 3.1 看

| 能力 | 说明 |
| --- | --- |
| 在线读 | DSH 开着也能读：Bun FFI 枚举全机句柄表 → `DuplicateHandle` 借外壳已打开的句柄 → 按路径认准 `...\network\cookies`（排除 `Partitions\`）→ 读原始字节 |
| 全量统计 | 原始字节写到临时文件，用 `bun:sqlite` 只读打开，真查 `cookies` 表：总条数、`dsh-auth-*` 条数、其它 cookie 数、按**创建日期**分布、最老/最新时间、库大小 |
| 请求头换算 | 条数 → 字节 → 百分比（0–100 夹取）→ 还能再启动几次；三档：正常 / ≥36 提醒 / ≥71 危险 |
| 诚实降级 | 读不到就显示原因（路径不对 / 找不到进程 / 借句柄失败 / 库损坏回退正则计数），**绝不猜 0 条** |
| 历史 | 每日一条条数快照，保留 90 天，看板画 14 天柱状趋势 |

### 3.2 压（核心新增）

| 能力 | 说明 |
| --- | --- |
| 保留天数 | `keepDays`，默认 **7 天**：早于 `now - keepDays` 的 `dsh-auth-*` 进删除名单 |
| 条数上限 | `keepMax`，默认 **40 条**：即使都在保留期内，也只留最新 40 条（防止「一天重启 30 次」把时间策略架空；40 仍在 72 崩点内，给最近会话留足） |
| 永远留最新一条 | 任何策略都不删最新那条；否则清完下次启动前手忙脚乱 |
| 预演 | 只算不删：显示 cutoff 时间、将删几条、留几条、释放多少请求头字节 |
| 执行 | DSH **未运行**时：备份 → 事务删除 → `integrity_check` → 复核（条数、非 DSH cookie 未变、至少剩 1 条）→ 失败自动从备份回滚 |
| 退出后自动清理 | DSH 运行中点「清理」不硬来，而是**排队**；插件每 20 秒检查一次，DSH 一退出就自动执行，结果回写看板 |
| 备份管理 | 每次写库前把 `Cookies` 复制到 `~/.config/magpie/dsh-cookie/backups/`，保留最近 10 份 |

### 3.3 用

| 入口 | 形态 |
| --- | --- |
| magpie 窗口 | 侧边栏「插件」分组里的「DSH Cookie」页（沙箱页面，无网络，靠 `page/data.js` 快照 + 插件选项投递请求） |
| Agent 工具 | `dsh_cookie_status`（读数）、`dsh_cookie_prune`（默认 dry-run，`dryRun:false` 才真删）、`dsh_cookie_config`（读写保留策略） |
| 离线 CLI | `bun src/cli.ts status` / `prune --keep-days 7 [--dry-run]` / `plan`（DSH 关掉后手动跑，或计划任务） |

### 3.4 明确不做

- 不解析、不上传、不打印 cookie 值（只数名字与创建时间，看板里名字只显示前 8 位）；
- 不杀 DSH 进程、不改 DSH 配置、不碰 `Partitions\` 下的平台登录库；
- 借句柄只有 Windows 需要：macOS/Linux 是 POSIX 语义、没有强制文件锁，直接读文件即可；两条路都只读，写库一律要求 DSH 已退出；
- 不做「每次退出自动清」的常驻守护——当前是一次性队列，避免插件变成常驻管家。

## 4. 页面沙箱约束（决定了架构）

magpie 的插件页跑在 `sandbox="allow-scripts"` + `connect-src 'none'` 里：**没有 fetch、没有 WebSocket、没有内联脚本**。所以不能像普通前后端那样起个 HTTP 服务给页面调。可行且已被社区验证（`magpie-workbuddy-plus`）的路子是：

```
插件宿主（Bun，常驻）
   ├─ 定时 / 请求时探测 cookie 库
   ├─ 写 page/data.js（globalThis.DSH_COOKIE = {...}）
   └─ 读 options.request 执行动作
          ▲                    │
          │ options.set()      │ 页面每 5 秒重新 <script src="data.js?t=…">
          │                    ▼
     page/app.js（沙箱里，只能加载自己的文件）
```

- 页面「刷新 / 预演 / 清理 / 保存设置」= 把 `{id, action, …}` 写进插件 options；
- magpie 因为 options 变化重启插件 → 插件 `load` 钩子识别新请求 → 执行 → 重写 `data.js`；
- 页面轮询 `data.js`，看到 `reply.id` 匹配就展示结果。

插件 `load` 里**不阻塞探测**（首次借句柄约 4 秒，magpie 单插件加载上限 20 秒）：先写一份旧快照，再 `setTimeout` 异步探。探测本身再放进 **Worker 线程**——借句柄是同步 FFI，留在插件宿主线程里会把 magpie 的网关请求一起卡住几秒；Worker 里跑，宿主照常服务，失败自动回退到当前线程。

## 5. 数据契约

`page/data.js`（由插件原子写入，页面只读）：

```js
globalThis.DSH_COOKIE = {
  build: 1,
  generated: "2026-11-01T14:00:00.000Z",
  state: "ok" | "unknown" | "error",
  dshRunning: true,
  db: {
    path: "~\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop\\Network\\Cookies", // 展示用，已脱敏
    size: 28672,
    dshCount: 26,            // 库里的 dsh-auth-* 条数
    otherCount: 0,           // 同一库里其它 cookie 条数（清理时保证不动）
    oldest: "2026-10-31T04:58:44.730Z" | null,
    newest: "2026-11-01T13:45:45.533Z" | null,
    source: "borrowed-handle" | "file",
  },
  gauge: { count: 26, bytes: 5928, percent: 36, remainingLaunches: 45, level: "ok", text: "cookie 26 条…" },
  days: [{ date: "2026-11-01", count: 3 }],       // 按创建日期（最近 30 天）
  history: [{ date: "2026-11-01", count: 26, at: "…" }], // 每日快照（90 天）
  config: { keepDays: 7, keepMax: 40 },
  preview: null | { at, cutoff, remove, keep, removeBytes },
  pending: null | { at, keepDays, keepMax, requestedBy },
  lastPrune: null | { at, ok, dryRun, removed, remaining, backup, error },
  reply: null | { id, action, ok, message, at },
  backups: [{ name, at, size }],
  readError: null | "…",
};
```

`options.request`（页面 → 插件）：

```json
{ "id": "m3k2-8f1a", "action": "refresh|plan|prune|cancel|cancel-pending|config", "config": { "keepDays": 7, "keepMax": 40 }, "at": 1793544000000 }
```

### 5.1 快照是「只读回显」，用户输入优先（保留策略表单）

页面每 5 秒重读一次 `page/data.js`，但**轮询只负责回显服务器状态，不许覆盖用户正在填的东西**。这条不变量是 0.2.2 修「默认值固定了、改不了」的根据：

| 状态 | 输入框 |
| --- | --- |
| 用户改过、还没保存（dirty） | 保持用户的值；轮询不写、快照不写；状态行提示「有未保存的修改」并给「撤销修改」 |
| 已点「保存设置」、还没回报（saving） | 锁定为提交的值（disabled），状态行「正在保存」；快照这期间还是旧的，绝不回写 |
| 没改过 | 跟随快照里的 `config`（Agent 工具/CLI 改了策略，页面也会同步） |
| 25 秒没回报 | 解除锁定、保留用户的值，明确提示「没被改回默认值」 |

保存的闭环是：`options.set({...options, request})` → magpie 重启插件 → 插件 `setConfig()` 落 `state.json` → 重写 `data.js`（新的 `config` + `reply`）→ 页面看到 `reply.id` 对上才解除 dirty 并按快照对齐。**在 `reply` 到之前，任何一方都不该把旧 `config` 当成"用户想要的"**——这正是之前出问题的地方：插件重启要 4–8 秒，页面在这段时间里把旧配置写回输入框，用户看到的就是"改完又变回 7 天 / 40 条"。

范围口径只有一份：`page/config.js`（浏览器）与 `src/retention.ts` 的 `normalizeConfig`（宿主/CLI/Agent 工具）都按 `keepDays 0–90`、`keepMax 1–72`；`bun test` 里有一条用例同时读 `page/index.html` 的 `min` / `max` 属性，防止两边再走偏。

## 6. 清理算法（写库那一步）

```
prune(dbPath, { keepDays, keepMax, dryRun }):
  1. 前置：库存在；DSH 未运行（Windows 看文件是否被独占，macOS/Linux 看进程表；运行中就拒绝/排队）
  2. 读全量 → rows = SELECT name, creation_utc FROM cookies WHERE name LIKE 'dsh-auth-%' ORDER BY creation_utc DESC
  3. cutoff = now - keepDays × 86400s
     drop = rows.filter(creation_utc < cutoff)          // 时间策略
     if rows.length - drop.length > keepMax:
         drop += 剩下的第 keepMax+1 条起（按创建时间从旧到新）   // 条数上限
     if drop 覆盖了最新一条 → 从 drop 里移除最新一条      // 永远留一条
  4. dryRun → 返回 { cutoff, remove, keep, removeBytes }
  5. 备份 → BEGIN IMMEDIATE; DELETE FROM cookies WHERE name IN (…精确名单…); COMMIT
  6. PRAGMA integrity_check == 'ok'
  7. 复核：剩余 dsh-auth 条数 == 预期；其它 cookie 条数前后一致；剩余 ≥ 1
  8. 任一步失败 → 用备份覆盖回去，报错
```

删除用**精确 name 名单**而不是 `WHERE creation_utc < ?`，避免「事务执行期间又被写入」导致多删。

## 7. 文件结构

```
magpie-dsh-cookie/
├── package.json            # magpie.page + main
├── index.ts                # 插件入口（load 钩子：识别请求、起定时器、写快照、注册工具）
├── src/
│   ├── paths.ts            # DSH 库路径、数据目录、环境变量覆盖
│   ├── probe.ts            # 探测调度（Worker 线程 + 当前线程回退）
│   ├── probe-worker.ts     # Worker 里的探测体
│   ├── win32.ts            # Bun FFI：枚举句柄表 → DuplicateHandle → 读字节
│   ├── jar.ts              # 字节 → 临时副本 → bun:sqlite 查询；损坏回退正则
│   ├── gauge.ts            # 228 / 16384 / 71 / 36 换算（全仓唯一）
│   ├── retention.ts        # 保留策略选行（纯函数，可单测）
│   ├── prune.ts            # 备份 / 删除 / 校验 / 回滚
│   ├── platform.ts         # 跨平台判断 DSH 是否在运行（Windows 独占锁 / POSIX 进程表）
│   ├── state.ts            # state.json（配置、历史、队列、最近结果）
│   ├── dashboard.ts        # 组装快照、原子写 page/data.js
│   ├── service.ts          # 编排：探测、缓存、请求、20s 定时
│   └── cli.ts              # 离线命令行
├── page/                   # 沙箱页面（index.html / app.js / config.js / style.css / data.js / icon.svg）
├── test/                   # bun test
├── screenshots/            # 文档用截图（demo 数据，路径已脱敏）
├── types/                  # bun:ffi / bun:sqlite 的最小类型声明
├── .gitignore              # 忽略 node_modules 与运行时生成的 page/data.js
└── DESIGN.md / README.md / CHANGELOG.md / LICENSE
```

## 8. 安全与数据

- 状态文件只有：日期、条数、清理结果、备份文件名 —— **没有任何 cookie 值**；
- 备份是整库副本，落在 magpie 配置目录，保留 10 份，可手动删；
- 页面 `data.js` 里 cookie 名只放前 8 位 + 每日计数，不放完整名（名字本身是随机摘要，仍按不必要就不暴露处理）；
- **不暴露本机用户名**：页面、Agent 工具、CLI 与错误消息里的路径统一走 `prettyPath()` / `maskText()`，把用户目录换成 `~`；`page/data.js` 里也只写 `~` 开头的展示路径，真实绝对路径只在进程内部用；
- 清理只允许在 DSH 退出后发生；队列执行前会再确认一次库未被锁。

## 9. 验证方式

| 层 | 怎么验 |
| --- | --- |
| 纯逻辑 | `bun test`：换算边界（71/72）、保留选行（时间/条数/永远留最新）、损坏库回退、state 合并 |
| 真机读 | 直接调 `probe()`：借句柄读本机 28 条、来源 `borrowed-handle`、耗时 |
| 真机预演 | `prune(..., {dryRun:true})`：应报 0 条可删（7 天保留期内） |
| 真机拒绝 | DSH 开着时 `prune(dryRun:false)` 必须拒绝（EBUSY），不得硬写 |
| 写库 | 对真实库的**副本**改 creation_utc 造旧数据 → 真删 → 复核条数/备份/回滚 |
| 页面 | 无 magpie 桥时用 `page/demo.js` 静态渲染截图检查；装进 magpie 后看板页与 `magpie plugin --json` 无加载错误 |

### 验证结果（2026-11-01，本机）

- **在线读**：DSH 运行中借句柄读到 **28 条 / 6,384 字节 / 39% / 还能开 43 次**，来源 `borrowed-handle`；首次探测约 4–5 秒（含全机句柄扫描，Worker 线程里跑），之后同进程内毫秒级。
- **单测**：`bun test` **61 通过 / 0 失败**（9 个文件），覆盖换算、保留选行、状态合并、损坏回退、真库副本删除与复核、排队巡检执行、跨平台路径与进程名匹配、路径脱敏。
- **真机动作链路**：按页面同样的方式把 `refresh / prune / cancel-pending` 写进插件 options，magpie 重载插件后宿主执行并回写 `page/data.js`：refresh 回「已重新读取 cookie 库」；prune 在 DSH 运行中回「已安排…」且 `pending` 落盘；cancel 后 `pending` 清空。
- **真机拒绝**：DSH 运行中 `cli prune` 明确报「DSH 正在运行：请先完全退出」，不写库。
- **写库安全**：在合成库上验证「只删过期 dsh-auth / 非 DSH 一条不删 / 备份落盘 / integrity_check / 条数复核」；损坏库拒绝清理；删除异常时从备份回滚。
- **页面**：380 / 700 / 1000 / 1200 四种宽度无横向溢出、无 NaN/undefined 文案；真实快照（history 1 条、days 2 天、preview/pending/lastPrune 为 null）与 7 种演示状态截图见 `screenshots/`。


## 10. 已知边界与后续

- 借句柄依赖 Win32 API，只在 Windows x64 验证过；ARM64 Windows 未验证；
- macOS/Linux 的读路径是 POSIX 直接读，逻辑与路径已用单测覆盖，但写库未在真机验证；
- 首次借句柄在个别杀软/驱动环境下有一次约 4 秒延迟（本机 OpenProcess 首次 3.8 秒，之后 <2ms），所以结果缓存 60 秒，不参与高频轮询；
- 队列依赖 magpie 常驻；magpie 与 DSH 都退出时不会执行，需要下次打开 magpie 或跑 CLI；
- 页面回执最多滞后一个轮询周期（5 秒）：插件写完 `data.js` 后，页面要等下一次 5 秒轮询才看到 `reply`，加上 magpie 重启插件，点「保存设置」到状态行变成「已保存」通常要 5–10 秒；这段期间输入框锁定并显示「正在保存」，不会被旧快照改回默认值；
- 后续可做：DSH 每次退出自动清理的守护模式、按 host 分组统计、清理前导出将被删除的 cookie 清单（只含名字与时间）。
