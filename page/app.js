/* DSH Cookie 看板 —— 页面脚本。
 *
 * 页面跑在 magpie 的沙箱里：没有网络、没有内联脚本、拿不到 Node。
 * 所以只有两条数据通路：
 *   1. 读：每次由插件原子重写的 page/data.js（globalThis.DSH_COOKIE），本脚本每 5 秒
 *      重新插入 <script src="data.js?t=…"> 拿新快照，然后原地更新 DOM（不整页重绘、不动滚动）；
 *   2. 写：把 {id, action, config?} 存进插件选项 magpie.options.set()，magpie 重载插件后执行，
 *      结果以 data.reply = {id, action, ok, message, at} 回来，id 对上就展示。
 * 不在 magpie 里打开（本地浏览器预览）时，用 page/demo.js 的 DSH_COOKIE_DEMO，按钮不提交。
 */
(function () {
  "use strict";

  var CAP = 72;             // 第 72 条触发崩溃线
  var PER_COOKIE = 228;     // 一条 cookie 在请求头里占的字节
  var HEADER_MAX = 16384;   // Node 默认 maxHeaderSize
  var POLL_MS = 5000;
  var BUSY_TIMEOUT = 25000;
  var SET_GAP = 1100;       // magpie.options.set 最多一秒一次

  var FMT = new Intl.NumberFormat("zh-CN");
  var SOURCE = { "borrowed-handle": "借句柄读取", file: "文件直读" };
  var ACTION_LABEL = {
    refresh: "重新探测",
    plan: "预演清理",
    prune: "清理",
    "cancel-pending": "取消安排",
    config: "保存设置",
  };

  var inMagpie = typeof globalThis.magpie === "object" && globalThis.magpie !== null;
  var state = {
    view: null,
    build: null,
    pendingId: null,
    busySince: 0,
    busyAction: null,
    lastSet: 0,
    daySig: "",
    histSig: "",
    // 保留策略表单：用户改过但还没保存时，轮询不许覆盖输入框
    configDirty: false,
    configSaved: null,
  };

  /* ────────────────────────── 小工具 ────────────────────────── */

  function el(id) { return document.getElementById(id); }

  function has(v) { return v !== null && v !== undefined && v !== ""; }

  function firstNum() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (!has(v)) continue;
      var n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function clampPct(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  function fmtInt(v) {
    var n = Number(v);
    return Number.isFinite(n) ? FMT.format(Math.round(n)) : "—";
  }

  function fmtKiB(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return "—";
    if (n === 0) return "0 KiB";
    var k = n / 1024;
    return "≈" + (k >= 10 ? Math.round(k) : k.toFixed(1)) + " KiB";
  }

  function ymd(dt) {
    return dt.getFullYear() + "-" + pad2(dt.getMonth() + 1) + "-" + pad2(dt.getDate());
  }

  function md(dt) { return pad2(dt.getMonth() + 1) + "-" + pad2(dt.getDate()); }

  function whenText(iso) {
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return "—";
    var d = new Date(t);
    return md(d) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function agoText(iso) {
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 10) return "刚刚";
    if (s < 60) return s + " 秒前";
    var m = Math.round(s / 60);
    if (m < 60) return m + " 分钟前";
    var h = Math.round(m / 60);
    if (h < 24) return h + " 小时前";
    return Math.round(h / 24) + " 天前";
  }

  function setText(id, text) {
    var node = el(id);
    if (node) node.textContent = text;
  }

  /* ────────────────────────── 状态栏与提示 ────────────────────────── */

  function showNote(message, bad) {
    var note = el("note");
    if (!note) return;
    if (!message) {
      note.hidden = true;
      note.textContent = "";
      return;
    }
    note.hidden = false;
    note.textContent = message;
    note.dataset.kind = bad ? "bad" : "ok";
  }

  function showFormError(message) {
    var box = el("keep-error");
    if (!box) return;
    if (!message) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    box.hidden = false;
    box.textContent = message;
  }

  /* ────────────────────────── 仪表 ────────────────────────── */

  function buildScale() {
    var scale = el("scale");
    if (!scale) return;
    var frag = document.createDocumentFragment();
    for (var i = 1; i <= CAP; i++) {
      var tick = document.createElement("i");
      tick.className = "tick";
      tick.dataset.on = "0";
      tick.dataset.zone = i >= 71 ? "danger" : i >= 36 ? "warn" : "ok";
      frag.append(tick);
    }
    scale.replaceChildren(frag);
  }

  function paintScale(count) {
    var scale = el("scale");
    if (!scale) return;
    var n = Math.max(0, Math.min(CAP, Math.round(count || 0)));
    for (var i = 0; i < scale.children.length; i++) {
      scale.children[i].dataset.on = i < n ? "1" : "0";
    }
  }

  function levelOf(view, count) {
    var level = view && view.gauge ? view.gauge.level : null;
    if (level === "danger" || level === "critical" || level === "bad" || level === "error") return "danger";
    if (level === "warn" || level === "warning") return "warn";
    if (count !== null) return count >= 71 ? "danger" : count >= 36 ? "warn" : "ok";
    return "ok";
  }

  function renderChips(view) {
    var chip = el("chip-dsh");
    var running = view ? view.dshRunning : undefined;
    var tone = "unknown";
    var text = "正在读取";

    if (view) {
      if (running === true) { tone = "run"; text = "DSH 运行中"; }
      else if (running === false) { tone = "exit"; text = "DSH 已退出"; }
      else { tone = "unknown"; text = "DSH 状态未知"; }
    }

    var time = el("chip-time");
    if (view && view.generated) {
      var at = Date.parse(view.generated);
      if (Number.isFinite(at)) {
        var stale = view.stale === true || Date.now() - at > 180000;
        if (stale) tone = "stale";
        time.textContent = "数据 " + whenText(view.generated) + " · " + agoText(view.generated) + (stale ? "（可能已过期）" : "");
        time.title = new Date(at).toLocaleString("zh-CN");
        time.hidden = false;
      } else {
        time.textContent = "数据时间未知";
        time.title = "";
        time.hidden = false;
      }
    } else {
      time.textContent = "—";
      time.title = "";
      time.hidden = true;
    }

    if (chip) {
      chip.dataset.tone = tone;
      setText("chip-dsh-text", text);
    }
  }

  function renderGauge(view) {
    var gauge = el("gauge");
    var g = (view && view.gauge) || {};
    var db = (view && view.db) || {};
    var readError = view && view.readError ? String(view.readError) : "";
    var count = firstNum(g.count, db.dshCount);
    var loading = !view || (view.state === "unknown" && !readError && count === null);
    var error = !!readError || (view && view.state === "error" && count === null);

    var bytes = firstNum(g.bytes, count === null ? null : count * PER_COOKIE);
    var percent = firstNum(g.percent, bytes === null ? null : (bytes / HEADER_MAX) * 100);
    var launches = firstNum(g.remainingLaunches, bytes === null ? null : Math.max(0, Math.floor((HEADER_MAX - bytes) / PER_COOKIE)));
    var level = error ? "ok" : levelOf(view, count);

    if (gauge) {
      gauge.dataset.level = level;
      gauge.dataset.state = error ? "error" : loading ? "loading" : "ok";
    }

    setText("hero-count", count === null ? "—" : fmtInt(count));
    setText("stat-count", count === null ? "—" : fmtInt(count));
    setText("stat-count-sub", "条");
    setText("stat-bytes", bytes === null ? "—" : FMT.format(bytes) + " B");
    setText("stat-bytes-sub", bytes === null ? "" : clampPct(percent) + "% · " + fmtKiB(bytes));
    setText("stat-launches", launches === null ? "—" : fmtInt(launches));
    setText("stat-launches-sub", launches === null ? "次" : count !== null && count >= CAP ? "次 · 已到上限" : "次");

    paintScale(error || loading ? 0 : count);

    var sentence;
    if (error) sentence = "";
    else if (loading) sentence = "正在读取 DSH 的 cookie 库…";
    else if (count === null) sentence = "没拿到条数，也没报错；点右上角「重新探测」再看一次。";
    else if (has(g.text)) sentence = String(g.text);
    else {
      sentence = "cookie " + fmtInt(count) + " 条，请求头占 " + clampPct(percent) + "%";
      sentence += launches === null ? "。" : "，还能再启动 " + fmtInt(launches) + " 次。";
    }
    setText("gauge-text", sentence);

    var errBox = el("gauge-error");
    if (errBox) {
      if (error) {
        var reason = readError || "data.js 里没有写原因（readError 为空），看 magpie 的插件日志";
        reason = reason.replace(/[。．.!！?？\s]+$/, "");
        errBox.hidden = false;
        errBox.textContent = "读取失败：" + reason + "。条数留空，不显示假数字。";
      } else {
        errBox.hidden = true;
        errBox.textContent = "";
      }
    }

    setText("gauge-source", db.source ? "来源：" + (SOURCE[db.source] || db.source) : "");

    var bits = [];
    if (has(db.size)) bits.push("库文件 " + fmtKiB(db.size));
    if (has(db.otherCount)) bits.push("其它 cookie " + fmtInt(db.otherCount) + " 条");
    if (db.oldest) bits.push("最早 " + whenText(db.oldest));
    if (db.newest) bits.push("最新 " + whenText(db.newest));
    setText("dbline", bits.join(" · "));
  }

  /* ────────────────────────── 图表 ────────────────────────── */

  function dayPoints(view) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var map = {};
    var rows = view && Array.isArray(view.days) ? view.days : [];
    rows.forEach(function (row) {
      if (!row || typeof row.date !== "string") return;
      var n = Number(row.count);
      map[row.date] = Number.isFinite(n) ? n : 0;
    });
    var out = [];
    for (var i = 29; i >= 0; i--) {
      var dt = new Date(today.getTime() - i * 86400000);
      var key = ymd(dt);
      out.push({ key: key, short: md(dt), label: key, count: map[key] || 0, today: i === 0 });
    }
    return out;
  }

  function historyPoints(view) {
    var rows = (view && Array.isArray(view.history) ? view.history : []).filter(function (row) {
      return row && typeof row.date === "string";
    });
    rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var todayKey = ymd(new Date());
    return rows.slice(-14).map(function (row) {
      var n = Number(row.count);
      return {
        key: row.date,
        short: row.date.slice(5),
        label: row.date,
        count: Number.isFinite(n) ? n : 0,
        today: row.date === todayKey,
      };
    });
  }

  function drawChart(which, points, opts) {
    var host = el(which + "-chart");
    if (!host) return;
    var sig = points.map(function (p) { return p.key + ":" + p.count; }).join(",") + "|" + (opts && opts.empty ? opts.empty : "");
    var cacheKey = which === "days" ? "daySig" : "histSig";
    if (state[cacheKey] === sig) return;
    state[cacheKey] = sig;
    if (globalThis.DSHCharts && typeof globalThis.DSHCharts.render === "function") {
      globalThis.DSHCharts.render(host, points, opts);
    }
  }

  function renderDays(view) {
    var points = dayPoints(view);
    var failed = !!(view && (view.readError || view.state === "error"));
    var total = 0;
    var best = null;
    points.forEach(function (p) {
      total += p.count;
      if (!best || p.count > best.count) best = p;
    });

    if (!view || failed || !total) setText("days-hint", "最近 30 天");
    else setText("days-hint", "最近 30 天 · 最高 " + fmtInt(best.count) + " 条");

    var emptyText = "暂无日期分布";
    var note;
    if (!view) {
      emptyText = "读取中…";
      note = "读取中…";
    } else if (failed) {
      emptyText = "读取失败";
      note = "读取失败，所以没有日期分布可画。";
    } else if (!total) {
      note = "最近 30 天库里没有 dsh-auth-* 的新建记录。";
    } else {
      var todayCount = points[points.length - 1].count;
      note = "30 天里共 " + fmtInt(total) + " 条，最多的一天是 " + best.short + "（" + fmtInt(best.count) + " 条）；";
      note += todayCount ? "今天新增 " + fmtInt(todayCount) + " 条。" : "今天还没有新增。";
    }
    drawChart("days", failed || total === 0 ? [] : points, { values: "auto", empty: emptyText });
    setText("days-note", note);
  }

  function renderHistory(view) {
    var points = historyPoints(view);
    var failed = !!(view && (view.readError || view.state === "error"));

    setText("hist-hint", points.length && !failed ? "每日快照 · 最近 " + points.length + " 天" : "每日快照");

    var emptyText = "暂无每日快照";
    var note;
    if (!view) {
      emptyText = "读取中…";
      note = "读取中…";
    } else if (failed) {
      emptyText = "读取失败";
      note = "读取失败，所以没有快照可看。";
    } else if (!points.length) {
      note = "还没有每日快照；插件运行后每天记一条条数，保留 90 天。";
    } else if (points.length === 1) {
      note = "只有 " + points[0].short + " 一天：库里有 " + fmtInt(points[0].count) + " 条。";
    } else {
      var first = points[0];
      var last = points[points.length - 1];
      var delta = last.count - first.count;
      note = "最新 " + last.short + " · " + fmtInt(last.count) + " 条；比 " + (points.length - 1) + " 天前的 " + fmtInt(first.count) + " 条";
      note += delta === 0 ? "持平。" : delta > 0 ? "多了 " + fmtInt(delta) + " 条。" : "少了 " + fmtInt(-delta) + " 条。";
    }
    drawChart("hist", failed ? [] : points, { values: "auto", empty: emptyText });
    setText("hist-note", note);
  }

  function wireReadout(chart, readout) {
    if (!chart || !readout) return;
    var idleText = readout.textContent;
    var pinned = null;

    function show(bar) {
      if (!bar) return;
      readout.textContent = bar.dataset.label + " · " + bar.dataset.count + " 条";
      readout.dataset.live = "1";
    }
    function idle() {
      readout.textContent = idleText;
      delete readout.dataset.live;
    }
    function barOf(node) {
      return node && node.closest ? node.closest(".bar") : null;
    }

    chart.addEventListener("pointerover", function (e) { show(barOf(e.target)); });
    chart.addEventListener("pointerleave", function () { if (pinned) show(pinned); else idle(); });
    chart.addEventListener("focusin", function (e) { show(barOf(e.target)); });
    chart.addEventListener("focusout", function () { if (pinned) show(pinned); else idle(); });
    chart.addEventListener("click", function (e) {
      var bar = barOf(e.target);
      if (!bar) return;
      var wasPinned = pinned === bar;
      if (pinned) pinned.setAttribute("aria-pressed", "false");
      pinned = wasPinned ? null : bar;
      if (pinned) {
        pinned.setAttribute("aria-pressed", "true");
        show(pinned);
      } else {
        idle();
      }
    });
    chart.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (pinned) pinned.setAttribute("aria-pressed", "false");
      pinned = null;
      idle();
    });
  }

  /* ────────────────────────── 保留策略 ────────────────────────── */

  /** page/config.js 没载入时的兜底（范围与 src/retention.ts 一致）。 */
  var CONFIG_FALLBACK = {
    parseForm: function (daysText, maxText) {
      var days = Number(String(daysText).trim());
      var max = Number(String(maxText).trim());
      if (daysText === "" || maxText === "" || !Number.isInteger(days) || !Number.isInteger(max) || days < 0 || days > 90 || max < 1 || max > 72) {
        return { ok: false, errors: ["「保留最近」填 0–90 之间的整数天；「最多保留」填 1–72 之间的整数条"] };
      }
      return { ok: true, config: { keepDays: days, keepMax: max }, errors: [] };
    },
    same: function (left, right) {
      return !!left && !!right && left.keepDays === right.keepDays && left.keepMax === right.keepMax;
    },
  };

  function configKit() {
    return globalThis.DSHCookieConfig || CONFIG_FALLBACK;
  }

  function setInputValue(id, value) {
    var input = el(id);
    if (!input || !has(value)) return;
    if (document.activeElement === input) return; // 正在编辑就别动
    var next = String(value);
    if (input.value !== next) input.value = next;
  }

  /** 快照里「已保存」的保留策略；还没读到就是 null。 */
  function configOf(view) {
    var cfg = view ? view.config : null;
    if (!cfg) return null;
    var days = firstNum(cfg.keepDays);
    var max = firstNum(cfg.keepMax);
    if (days === null || max === null) return null;
    return { keepDays: days, keepMax: max };
  }

  function readConfigForm() {
    return {
      keepDays: String(el("keep-days") ? el("keep-days").value : ""),
      keepMax: String(el("keep-max") ? el("keep-max").value : ""),
    };
  }

  /** 正在等「保存设置」的回报。 */
  function savingConfig() {
    return state.busySince > 0 && state.busyAction === "config";
  }

  /**
   * 保留策略卡片。
   *
   * 硬规矩：**页面每 5 秒重读一次 data.js，但绝不覆盖用户正在填的/刚提交的值。**
   * magpie 收到 options.set 后要重启插件（Windows 首次借句柄约 4 秒），这期间页面读到的
   * 还是旧快照；以前这里无条件把旧 config 写回输入框，用户看到的就成了「改完又变回
   * 默认的 7 天 / 40 条」，像是默认值被固定住、改不了。
   */
  function renderConfig(view) {
    var saved = configOf(view);
    if (saved) state.configSaved = saved;

    if (!state.configDirty && !savingConfig() && state.configSaved) {
      setInputValue("keep-days", state.configSaved.keepDays);
      setInputValue("keep-max", state.configSaved.keepMax);
    }
    renderConfigState();
  }

  /** 「已保存 / 有未保存的修改 / 正在保存」这行小字。 */
  function renderConfigState() {
    var saved = state.configSaved;
    var saving = savingConfig();
    var dirty = state.configDirty;
    var undo = el("keep-undo");
    if (undo) undo.hidden = !dirty || saving;
    // 保存中不许再改：回报一到就会按服务器配置对齐，改了就白改
    ["keep-days", "keep-max"].forEach(function (id) {
      var input = el(id);
      if (input) input.disabled = saving;
    });

    var text;
    if (saving) {
      text = "正在保存：magpie 要重启插件，几秒后才回报；这期间你填的数不会被页面改掉。";
    } else if (dirty) {
      text = "有未保存的修改";
      if (saved) {
        text += "（已保存的是最近 " + fmtInt(saved.keepDays) + " 天 / 最多 " + fmtInt(saved.keepMax) + " 条）";
      }
      text += "，点「保存设置」写进插件。";
    } else if (saved) {
      text = "已保存：保留最近 " + fmtInt(saved.keepDays) + " 天 / 最多 " + fmtInt(saved.keepMax) + " 条；最新一条永远保留。";
    } else {
      text = "还没读到已保存的策略；先按 7 天 / 40 条显示，点「保存设置」会写进插件。";
    }

    var box = el("keep-state");
    if (box) {
      box.textContent = text;
      box.dataset.kind = saving ? "saving" : dirty ? "dirty" : "saved";
    }
  }

  /** 输入框一改就标记未保存；手动改回已保存的值则撤销标记。 */
  function markConfigDirty() {
    var form = readConfigForm();
    var parsed = configKit().parseForm(form.keepDays, form.keepMax);
    state.configDirty = !(parsed.ok && configKit().same(parsed.config, state.configSaved));
    showFormError("");
    renderConfigState();
  }

  /** 撤销未保存的修改，回到已保存的值。 */
  function restoreConfig() {
    var saved = state.configSaved;
    state.configDirty = false;
    showFormError("");
    if (saved) {
      setInputValue("keep-days", saved.keepDays);
      setInputValue("keep-max", saved.keepMax);
    }
    renderConfigState();
  }

  function saveConfig() {
    var form = readConfigForm();
    var parsed = configKit().parseForm(form.keepDays, form.keepMax);
    if (!parsed.ok) {
      showFormError(parsed.errors.join("；") + "。");
      return;
    }
    showFormError("");
    // 提交后先钉住用户的值：回报之前读到的是旧快照，不许动这两个框。
    state.configDirty = true;
    renderConfigState();
    submit("config", { config: parsed.config });
  }

  /* ────────────────────────── 清理卡 ────────────────────────── */

  function renderPrune(view) {
    var preview = view ? view.preview : null;
    var pending = view ? view.pending : null;
    var running = !!(view && view.dshRunning);
    var count = view ? firstNum(view.gauge && view.gauge.count, view.db && view.db.dshCount) : null;

    var dl = el("preview");
    var empty = el("preview-empty");
    if (preview && (has(preview.remove) || has(preview.keep))) {
      if (dl) dl.hidden = false;
      if (empty) empty.hidden = true;
      setText("pv-remove", has(preview.remove) ? fmtInt(preview.remove) + " 条" : "—");
      setText("pv-keep", has(preview.keep) ? fmtInt(preview.keep) + " 条" : "—");
      setText("pv-cutoff", preview.cutoff ? whenText(preview.cutoff) : "—");
      if (has(preview.removeBytes)) {
        var bytes = Number(preview.removeBytes);
        setText("pv-bytes", FMT.format(bytes) + " B" + (bytes >= 1024 ? "（" + fmtKiB(bytes) + "）" : ""));
      } else {
        setText("pv-bytes", "—");
      }
      setText("prune-hint", preview.at ? "预演于 " + whenText(preview.at) : "预演结果");
    } else {
      if (dl) dl.hidden = true;
      if (empty) empty.hidden = false;
      setText("prune-hint", "先预演，确认后再执行");
    }

    var box = el("pending");
    if (pending) {
      if (box) box.hidden = false;
      var bits = [];
      if (has(pending.keepDays)) bits.push("保留 " + fmtInt(pending.keepDays) + " 天");
      if (has(pending.keepMax)) bits.push("最多 " + fmtInt(pending.keepMax) + " 条");
      var line = "已排队：DSH 退出后自动清理";
      if (bits.length) line += "（" + bits.join(" / ") + "）";
      if (pending.at) line += "，排队于 " + whenText(pending.at);
      setText("pending-text", line + "。插件每 20 秒看一次，DSH 一退出就执行。");
    } else {
      if (box) box.hidden = true;
      setText("pending-text", "");
    }

    var prune = el("prune-btn");
    if (prune) {
      prune.textContent = count === 0 ? "没有可清理的" : running ? "DSH 退出后自动清理" : "执行清理";
      prune.title = running ? "DSH 运行中不能写库：点它会排队，等 DSH 退出后执行" : "清理前自动备份，失败自动回滚";
      prune.dataset.wantDisabled = count === 0 ? "1" : "0";
    }
    var plan = el("plan-btn");
    if (plan) plan.dataset.wantDisabled = count === 0 ? "1" : "0";

    var fine = el("prune-fine");
    if (fine) {
      if (running) {
        fine.textContent = "DSH 正在运行，cookie 库仍在使用中，现在写库会被拦下。点上面的按钮只是排队，等 DSH 退出后由插件自动执行；magpie 也一起退出时不执行，可以关掉 DSH 后跑 bun src/cli.ts prune。";
      } else if (view) {
        fine.textContent = "执行前整库复制一份到备份目录；删除后做完整性检查和条数复核，任何一步失败都会从备份回滚。";
      } else {
        fine.textContent = "读取中…";
      }
    }
  }

  /* ────────────────────────── 结果与页脚 ────────────────────────── */

  function renderResult(view) {
    var lp = view ? view.lastPrune : null;
    var body = el("result-body");
    var dl = el("result-dl");
    var backups = view && Array.isArray(view.backups) ? view.backups : [];
    var line = el("res-backups");

    if (line) {
      if (backups.length) {
        var top = backups[0] || {};
        line.hidden = false;
        line.textContent = "可用备份 " + backups.length + " 份，最新 " + (top.name || "—") +
          (top.at ? "（" + whenText(top.at) + "）" : "") + "。";
      } else {
        line.hidden = false;
        line.textContent = view ? "还没有备份：第一次执行清理时会先复制一份整库。" : "";
      }
    }

    if (!lp) {
      if (body) {
        body.hidden = false;
        body.textContent = view ? "还没有清理记录。第一次预演或执行之后，结果会留在这里。" : "读取中…";
      }
      if (dl) dl.hidden = true;
      setText("result-hint", "");
      return;
    }

    if (body) body.hidden = true;
    if (dl) dl.hidden = false;
    setText("result-hint", lp.at ? whenText(lp.at) : "");

    var badge = el("res-status");
    if (badge) {
      if (lp.ok === false) { badge.textContent = "失败，已回滚"; badge.dataset.tone = "bad"; }
      else if (lp.dryRun) { badge.textContent = "预演"; badge.dataset.tone = "soft"; }
      else { badge.textContent = "成功"; badge.dataset.tone = "ok"; }
    }
    setText("res-removed", has(lp.removed) ? fmtInt(lp.removed) + " 条" : "—");
    setText("res-remaining", has(lp.remaining) ? fmtInt(lp.remaining) + " 条" : "—");
    setText("res-backup", lp.backup || "—");

    var row = el("res-error-row");
    if (row) {
      if (lp.error) {
        row.hidden = false;
        setText("res-error", String(lp.error));
      } else {
        row.hidden = true;
        setText("res-error", "");
      }
    }
  }

  function renderFooter(view) {
    var db = (view && view.db) || {};
    var path = db.path ? String(db.path) : (view ? "没找到 cookie 库（只有 Windows 版 DSH 桌面端有在线读数）" : "—");
    setText("db-path", path);
  }

  /* ────────────────────────── 请求与轮询 ────────────────────────── */

  function labelOf(action) { return ACTION_LABEL[action] || action; }

  function submit(action, extra) {
    if (!inMagpie) {
      showNote(wantsReal()
        ? "只读预览（?real=1）：没有 magpie，按钮不会提交。"
        : "这是本地预览（示例数据）：没有 magpie，按钮不会提交。", true);
      return;
    }
    if (state.busySince) {
      showNote("上一个请求还在处理，等它回来再点。", true);
      return;
    }

    var now = Date.now();
    var id = now.toString(36) + Math.random().toString(36).slice(2, 8);
    state.busySince = now;
    state.busyAction = action;
    state.pendingId = id;
    syncButtons();
    showNote("已提交「" + labelOf(action) + "」，等插件执行后回报…");
    if (action === "config") renderConfigState();

    var send = function () {
      state.lastSet = Date.now();
      Promise.resolve()
        .then(function () { return magpie.options.get(); })
        .then(function (options) {
          var request = Object.assign({ id: id, action: action, at: Date.now() }, extra || {});
          return magpie.options.set(Object.assign({}, options || {}, { request: request }));
        })
        .then(function () {
          setTimeout(loadData, 1200);
        })
        .catch(function (err) {
          state.busySince = 0;
          state.busyAction = null;
          state.pendingId = null;
          syncButtons();
          if (action === "config") renderConfigState();
          showNote("提交失败：" + (err && err.message ? err.message : String(err)), true);
        });
    };

    var gap = SET_GAP - (now - state.lastSet);
    if (gap > 0) setTimeout(send, gap);
    else send();
  }

  function syncButtons() {
    var busy = state.busySince > 0;
    var buttons = document.querySelectorAll("button[data-action]");
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      btn.disabled = busy || btn.dataset.wantDisabled === "1";
    }
    var save = el("save-btn");
    if (save) save.disabled = busy;
  }

  function checkBusyTimeout() {
    if (!state.busySince) return;
    if (Date.now() - state.busySince < BUSY_TIMEOUT) return;
    var action = state.busyAction;
    state.busySince = 0;
    state.busyAction = null;
    state.pendingId = null;
    if (action === "config") {
      showNote(
        "「保存设置」超过 " + Math.round(BUSY_TIMEOUT / 1000) + " 秒没有回报：magpie 可能没重启插件。你填的数仍留在框里（没被改回默认值）；点「重新探测」看看，或再点一次「保存设置」。",
        true,
      );
      renderConfigState();
    } else {
      showNote("插件没有在 " + Math.round(BUSY_TIMEOUT / 1000) + " 秒内回报；它可能还在处理，页面会继续每 5 秒自己刷新。", true);
    }
  }

  function handleReply(view) {
    var reply = view ? view.reply : null;
    if (!reply || !reply.id || state.pendingId !== reply.id) return;
    state.pendingId = null;
    state.busySince = 0;
    state.busyAction = null;
    var label = labelOf(reply.action);
    if (reply.ok === false) {
      showNote("「" + label + "」失败：" + (reply.message ? String(reply.message) : "插件没给出原因。"), true);
      // 保留「未保存」状态：值还在框里，改完可以直接再存一次
    } else {
      showNote(reply.message ? String(reply.message) : label + "完成。");
      if (reply.action === "config") state.configDirty = false;
    }
  }

  function pickView() {
    if (inMagpie || wantsReal()) {
      var v = globalThis.DSH_COOKIE;
      if (v && typeof v === "object" && (v.gauge || v.db || v.readError || v.state === "error")) return v;
      return null;
    }
    return globalThis.DSH_COOKIE_DEMO || null;
  }

  // ?real=1：不用 magpie 也能看宿主写出的真实快照（验收、排查用），按钮同样不提交。
  function wantsReal() {
    try {
      return /[?&]real=1(?:&|$)/.test(String(location.search || ""));
    } catch (err) {
      return false;
    }
  }

  function loadData() {
    if (!inMagpie) return;
    var script = document.createElement("script");
    script.src = "data.js?t=" + Date.now();
    script.onload = script.onerror = function () {
      script.remove();
      var v = globalThis.DSH_COOKIE;
      if (v && v.build && state.build && v.build !== state.build) {
        location.reload();
        return;
      }
      if (v && typeof v === "object" && (v.gauge || v.db || v.readError || v.state === "error")) {
        state.view = v;
        if (v.build) state.build = v.build;
      }
      safeRender();
    };
    document.head.append(script);
  }

  /* ────────────────────────── 渲染入口 ────────────────────────── */

  function render() {
    var view = state.view;
    checkBusyTimeout();
    renderChips(view);
    renderGauge(view);
    renderDays(view);
    renderHistory(view);
    // 先消化回报（会解除「未保存」），再画表单，输入框才不会慢一拍
    handleReply(view);
    renderConfig(view);
    renderPrune(view);
    renderResult(view);
    renderFooter(view);
    syncButtons();
  }

  function safeRender() {
    try {
      render();
    } catch (err) {
      if (globalThis.console) console.error("[dsh-cookie] render failed", err);
      showNote("页面渲染出错：" + (err && err.message ? err.message : String(err)), true);
    }
  }

  function wire() {
    document.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("button[data-action]") : null;
      if (!btn || btn.disabled) return;
      var action = btn.dataset.action;
      if (!action) return;
      submit(action);
    });

    var form = el("config-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        saveConfig();
      });
    }

    // magpie 的插件页 iframe 是 sandbox="allow-scripts"，没有 allow-forms：
    // 沙箱里的表单提交（type=submit 的按钮、输入框里按回车）会被浏览器直接拦掉，
    // submit 事件根本不会触发。所以保存按钮必须是 type="button" + 自己的 click
    // 监听，跟预演/清理那些按钮一样走点击——这也是之前「保存设置点了没反应」的根因。
    var save = el("save-btn");
    if (save) {
      save.addEventListener("click", function (e) {
        e.preventDefault();
        saveConfig();
      });
    }

    ["keep-days", "keep-max"].forEach(function (id) {
      var input = el(id);
      if (!input) return;
      input.addEventListener("input", function () { markConfigDirty(); });
      input.addEventListener("change", function () { markConfigDirty(); });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          saveConfig();
        }
      });
    });

    var undo = el("keep-undo");
    if (undo) undo.addEventListener("click", restoreConfig);

    wireReadout(el("days-chart"), el("days-readout"));
    wireReadout(el("hist-chart"), el("hist-readout"));
  }

  function init() {
    buildScale();
    wire();
    state.view = pickView();
    state.build = state.view && state.view.build ? state.view.build : null;
    safeRender();
    if (inMagpie) {
      setInterval(loadData, POLL_MS);
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) loadData();
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
