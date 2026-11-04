/* 页面脚本的结构性约束。
 *
 * page/app.js 跑在 magpie 的沙箱 iframe 里，没有 DOM 测试环境；这里只钉住几条
 * **曾经真实坏过**的写法，改回去时立刻变红。每条都注明它对应哪次故障。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pageDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'page');
const html = readFileSync(join(pageDir, 'index.html'), 'utf8');
const app = readFileSync(join(pageDir, 'app.js'), 'utf8');
const charts = readFileSync(join(pageDir, 'charts.js'), 'utf8');

describe('页面脚本的结构性约束（回归钉子）', () => {
  test('保存按钮不是 submit：沙箱 iframe 没有 allow-forms，提交事件永远不会触发', () => {
    // 0.2.2 的根因：type="submit" 在 sandbox="allow-scripts" 里点了一点反应都没有。
    const save = html.match(/<button[^>]*id="save-btn"[^>]*>/)?.[0] ?? '';
    expect(save).toContain('type="button"');
    expect(html).not.toContain('type="submit"');
    expect(app).toContain('save.addEventListener("click"');
    // 输入框里回车也直接保存，不依赖 form 的 submit
    expect(app).toContain('e.key === "Enter"');
  });

  test('轮询不覆盖用户正在填的输入框，也不覆盖正在保存的值', () => {
    // 0.2.1 的根因：每 5 秒重读 data.js 时无条件写回输入框，看起来像「默认值锁死」。
    expect(app).toContain('document.activeElement === input');
    expect(app).toContain('!state.configDirty && !savingConfig()');
  });

  test('render() 先消化回报再判超时，否则成功回报会被当成超时丢掉', () => {
    const body = app.slice(app.indexOf('function render()'), app.indexOf('function safeRender()'));
    const replyAt = body.indexOf('handleReply(view)');
    const timeoutAt = body.indexOf('checkBusyTimeout()');
    expect(replyAt).toBeGreaterThan(-1);
    expect(timeoutAt).toBeGreaterThan(replyAt);
  });

  test('读不到库时清理按钮是禁用的（别让人点出一次真的写库请求）', () => {
    expect(app).toContain('var unknown = count === null');
    expect(app).toContain('prune.dataset.wantDisabled = blocked ? "1" : "0"');
    expect(app).toContain('plan.dataset.wantDisabled = blocked ? "1" : "0"');
  });

  test('柱子整批重画时撤销钉住的读数，并把键盘焦点还回去', () => {
    expect(app).toContain('readout.reset()');
    expect(charts).toContain('focusKey');
    expect(charts).toContain('opts.endLabel');
  });

  test('失败与预演都不显示「删除 0 条」', () => {
    expect(app).toContain('var nothingRemoved = failed || lp.dryRun === true');
    expect(app).toContain('lp.rolledBack === true ? "失败，已回滚" : "失败，未写库"');
  });
});
