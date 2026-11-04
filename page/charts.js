/* 柱状图：只用 DOM 与 CSS 变量画，不引外部库、不写内联样式属性（高度走 CSSOM）。
   沙箱页面里 CSP 只放行外部脚本，所以这里全部是普通 JS + aria-label。 */
(function () {
  "use strict";

  var MAX_LABELLED = 14;

  function text(tag, className, content) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (content != null) el.textContent = content;
    return el;
  }

  /**
   * @param {HTMLElement} host 图表容器
   * @param {Array<{key:string,short:string,label:string,count:number,today:boolean}>} points
   * @param {{values?: "all"|"auto"|"none", empty?: string, endLabel?: string}} [opts]
   */
  function render(host, points, opts) {
    if (!host) return;
    opts = opts || {};
    // 每次数据变化都会整体替换柱子。键盘用户可能正停在某根柱子上，
    // 先把「焦点在哪根」记下来，画完再还回去，别让人被弹回 body。
    var active = document.activeElement;
    var focusKey = active && active !== host && host.contains(active) && active.dataset ? active.dataset.key : null;

    var list = Array.isArray(points) ? points.filter(function (p) { return p && p.key; }) : [];
    if (!list.length) {
      host.replaceChildren(text("p", "chart-empty", opts.empty || "还没有数据"));
      return;
    }

    var max = 1;
    for (var i = 0; i < list.length; i++) {
      var c = Number(list[i].count);
      if (c > max) max = c;
    }
    var values = opts.values || "auto";
    var showValues = values === "all" || (values === "auto" && list.length <= MAX_LABELLED);

    var bars = document.createElement("div");
    bars.className = "bars" + (showValues ? " show-vals" : "");
    bars.style.setProperty("--n", String(list.length));

    var frag = document.createDocumentFragment();
    var barNodes = [];
    list.forEach(function (p) {
      var count = Number(p.count) || 0;
      var cell = document.createElement("div");
      cell.className = "bar-cell";

      var bar = document.createElement("button");
      bar.type = "button";
      bar.className = "bar" + (p.today ? " is-today" : "") + (count > 0 ? "" : " is-zero");
      bar.dataset.key = p.key;
      bar.dataset.label = p.label || p.key;
      bar.dataset.count = String(count);
      bar.setAttribute("aria-pressed", "false");
      bar.setAttribute("aria-label", (p.label || p.key) + "，" + count + " 条");
      bar.style.setProperty("--h", (count / max).toFixed(4));
      barNodes.push(bar);

      bar.append(text("span", "bar-fill"));
      if (count > 0) {
        var val = text("span", "bar-val", String(count));
        val.setAttribute("aria-hidden", "true");
        bar.append(val);
      }

      cell.append(bar);
      frag.append(cell);
    });
    bars.append(frag);

    var axis = document.createElement("div");
    axis.className = "axis";
    axis.append(text("span", "", list[0].short || list[0].key));
    // 右端不一定是「今天」：历史趋势的最后一条是最近一次快照，可能停在几天前。
    axis.append(text("span", "now", opts.endLabel || "今天"));

    host.replaceChildren(bars, axis);

    if (focusKey) {
      for (var index = 0; index < barNodes.length; index++) {
        if (barNodes[index].dataset.key === focusKey) {
          barNodes[index].focus();
          break;
        }
      }
    }
  }

  globalThis.DSHCharts = { render: render };
})();
