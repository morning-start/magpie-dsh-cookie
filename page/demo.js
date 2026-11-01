/* 本地预览用的示例数据：只有「不在 magpie 里」打开 index.html 时才生成。
   magpie 里页面只读 data.js，这个文件对看板没有任何影响（`magpie` 存在时直接返回）。

   想看不同状态：在地址后面加 hash，可叠加（用 - 分隔）：
     #ok          默认：26 条，DSH 运行中，有预演结果和上次清理记录
     #danger      71 条，顶到崩溃线
     #pending     已排队，等 DSH 退出后自动清理
     #fail        读取失败（readError），仪表区只显示原因
     #prunefail   上次清理失败、已从备份回滚
     #fresh       新装的库，0 条，没有历史
     #stale       数字是上次缓存（stale: true），时间胶囊会提醒可能过期
     #dark        深色（只影响本地预览；magpie 里由 bridge 设 data-theme）
   例：page/index.html#pending-dark
*/
(function () {
  "use strict";

  if (globalThis.magpie) return;          // magpie 里不需要示例数据
  if (globalThis.DSH_COOKIE_DEMO) return; // 已经生成过了

  var hash = String(location.hash || "").replace(/^#/, "");
  var parts = hash.split(/[-+]/).filter(Boolean);
  var variants = ["danger", "pending", "fail", "prunefail", "fresh", "stale"];
  var variant = "ok";
  for (var i = 0; i < parts.length; i++) {
    if (variants.indexOf(parts[i]) >= 0) variant = parts[i];
  }

  var now = Date.now();
  var DAY = 86400000;

  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function ymd(dt) { return dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate()); }
  function at(msAgo) { return new Date(now - msAgo).toISOString(); }
  function daysAgo(n) { return new Date(now - n * DAY); }

  // counts: {"0": 14, "1": 12} —— 天数偏移（0 = 今天）到当天新建条数，只写非零
  function daysFrom(counts) {
    var out = [];
    for (var i = 29; i >= 0; i--) {
      var c = counts[i] || 0;
      if (c) out.push({ date: ymd(daysAgo(i)), count: c });
    }
    return out;
  }

  // values 从旧到新，最后一个是今天
  function historyFrom(values) {
    var n = values.length;
    return values.map(function (c, i) {
      return { date: ymd(daysAgo(n - 1 - i)), count: c, at: at((n - 1 - i) * DAY + 3600000) };
    });
  }

  var DB_PATH = "~\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop\\Network\\Cookies";

  function view(overrides) {
    var base = {
      build: 1,
      generated: at(8000),
      state: "ok",
      dshRunning: true,
      db: {
        path: DB_PATH,
        size: 28672,
        dshCount: 26,
        otherCount: 0,
        oldest: at(26 * 3600000),
        newest: at(300000),
        source: "borrowed-handle",
      },
      gauge: {
        count: 26,
        bytes: 5928,
        percent: 36,
        remainingLaunches: 45,
        level: "ok",
        text: "cookie 26 条，请求头占 36%，还能再启动 45 次。",
      },
      days: daysFrom({ 0: 14, 1: 12 }),
      history: historyFrom([4, 9, 13, 17, 22, 26]),
      config: { keepDays: 7, keepMax: 40 },
      preview: {
        at: at(60000),
        cutoff: at(7 * DAY),
        remove: 3,
        keep: 23,
        removeBytes: 684,
      },
      pending: null,
      lastPrune: {
        at: at(2 * DAY + 3600000),
        ok: true,
        dryRun: false,
        removed: 2,
        remaining: 9,
        backup: "Cookies-20261030-091200",
        error: null,
      },
      reply: null,
      backups: [
        { name: "Cookies-20261030-091200", at: at(2 * DAY + 3600000), size: 24576 },
        { name: "Cookies-20261028-101500", at: at(4 * DAY), size: 20480 },
      ],
      readError: null,
    };
    return Object.assign(base, overrides || {});
  }

  var demo;

  if (variant === "danger") {
    demo = view({
      generated: at(4000),
      dshRunning: false,
      db: {
        path: DB_PATH,
        size: 65536,
        dshCount: 71,
        otherCount: 2,
        oldest: at(30 * DAY),
        newest: at(120000),
        source: "file",
      },
      gauge: {
        count: 71,
        bytes: 16188,
        percent: 99,
        remainingLaunches: 0,
        level: "danger",
        text: "cookie 71 条，请求头已占 99%：下一次启动很可能被 431 挡掉，先清理再启动 DSH。",
      },
      days: daysFrom({ 0: 26, 1: 20, 2: 15, 3: 10 }),
      history: historyFrom([30, 38, 44, 52, 58, 63, 66, 68, 69, 70, 71]),
      preview: { at: at(120000), cutoff: at(7 * DAY), remove: 48, keep: 23, removeBytes: 10944 },
      lastPrune: {
        at: at(3 * DAY),
        ok: true,
        dryRun: false,
        removed: 2,
        remaining: 9,
        backup: "Cookies-20261029-211500",
        error: null,
      },
    });
  } else if (variant === "pending") {
    demo = view({
      pending: { at: at(45000), keepDays: 7, keepMax: 40, requestedBy: "page" },
    });
  } else if (variant === "fail") {
    demo = view({
      generated: at(6000),
      state: "error",
      dshRunning: true,
      db: { path: DB_PATH, source: "borrowed-handle" },
      gauge: null,
      days: [],
      history: [],
      preview: null,
      lastPrune: null,
      backups: [],
      readError: "借句柄失败：OpenProcess 被拒绝（拒绝访问 0x5）。DSH 可能以管理员权限运行，用管理员身份启动 magpie 后再试。",
    });
  } else if (variant === "prunefail") {
    demo = view({
      dshRunning: false,
      days: daysFrom({ 0: 0, 1: 12, 2: 9, 4: 5 }),
      lastPrune: {
        at: at(600000),
        ok: false,
        dryRun: false,
        removed: 0,
        remaining: 26,
        backup: "Cookies-20261101-230500",
        error: "删除后条数复核不一致（预期 23，实际 26）：疑似库在删除期间被写入，已从备份回滚。",
      },
      backups: [{ name: "Cookies-20261101-230500", at: at(600000), size: 28672 }],
    });
  } else if (variant === "stale") {
    demo = view({
      generated: at(9 * 60000),
      stale: true,
    });
  } else if (variant === "fresh") {
    demo = view({
      generated: at(3000),
      days: [],
      history: [],
      db: {
        path: DB_PATH,
        size: 4096,
        dshCount: 0,
        otherCount: 0,
        oldest: null,
        newest: null,
        source: "file",
      },
      gauge: {
        count: 0,
        bytes: 0,
        percent: 0,
        remainingLaunches: 71,
        level: "ok",
        text: "库里还没有 dsh-auth-* cookie：DSH 启动一次就会写一条。",
      },
      preview: null,
      lastPrune: null,
      backups: [],
    });
  } else {
    demo = view({});
  }

  globalThis.DSH_COOKIE_DEMO = demo;

  if (parts.indexOf("dark") >= 0) {
    try { document.documentElement.dataset.theme = "dark"; } catch (err) { /* 预览而已 */ }
  }
})();
