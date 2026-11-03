/* 保留策略表单的解析与校验（页面和 bun test 共用的一份口径）。
 *
 * 为什么单独一个文件：范围必须与宿主侧 `src/retention.ts` 的 `normalizeConfig`
 * 完全一致——天数 0–90、条数 1–72。写成两边各一套时，页面曾把「0 天」判成非法，
 * 用户想改成「只按条数上限」就永远存不进去，看起来像「默认值固定了、改不了」。
 * 这里只放纯函数，不碰 DOM，测试可以直接 import。
 */
(function () {
  "use strict";

  var LIMITS = {
    keepDays: { min: 0, max: 90 },
    keepMax: { min: 1, max: 72 },
  };

  /** 解析整数；空串、小数、非数字一律 null（Number("") 是 0，必须先挡掉）。 */
  function toWholeNumber(text) {
    if (typeof text !== "string") return null;
    var trimmed = text.trim();
    if (trimmed === "") return null;
    var value = Number(trimmed);
    return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  }

  /**
   * 解析两个输入框；范围与宿主一致。
   * @param {string} daysText 「保留最近」的原始输入
   * @param {string} maxText 「最多保留」的原始输入
   * @returns {{ ok: boolean, config?: { keepDays: number, keepMax: number }, errors: string[] }}
   */
  function parseForm(daysText, maxText) {
    var errors = [];
    var keepDays = toWholeNumber(daysText);
    var keepMax = toWholeNumber(maxText);

    if (keepDays === null) errors.push("「保留最近」要填 0–90 之间的整数天");
    else if (keepDays < LIMITS.keepDays.min || keepDays > LIMITS.keepDays.max) {
      errors.push("「保留最近」只能在 0–90 天之间（0 表示不按天数删，只按条数上限）");
    }

    if (keepMax === null) errors.push("「最多保留」要填 1–72 之间的整数条");
    else if (keepMax < LIMITS.keepMax.min || keepMax > LIMITS.keepMax.max) {
      errors.push("「最多保留」只能在 1–72 条之间");
    }

    if (errors.length) return { ok: false, errors: errors };
    return { ok: true, config: { keepDays: keepDays, keepMax: keepMax }, errors: [] };
  }

  /** 两份配置是否相同（缺字段视为不同）。 */
  function sameConfig(left, right) {
    if (!left || !right) return false;
    return left.keepDays === right.keepDays && left.keepMax === right.keepMax;
  }

  globalThis.DSHCookieConfig = { LIMITS: LIMITS, parseForm: parseForm, same: sameConfig };
})();
