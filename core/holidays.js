// 美国联邦法定节日（只用来在日历上显示，不会自动改排班或工资）。
// 全部按规则在本地算出来，不需要联网。节日碰上周六，补休在前一天周五；碰上周日，补休在后一天周一。
//
// holidaysOfYear(2026) → Map('YYYY-MM-DD' → { name, short, observed })
//   name 全名（如「感恩节」），short 日历格子里用的短名（最多 4 个字），observed=true 表示这天是补休日。
// holidayOn(date) → 那一天的节日，或者 null。

import {makeDate, weekdayOf, addDays, validDate} from './dates.js?v=89b9af5a97';

/** 某年某月第 n 个星期 wd（0=周日）；n = -1 表示最后一个。 */
function nthWeekday(year, month, wd, n) {
  if (n > 0) {
    const first = makeDate(year, month, 1);
    return addDays(first, (wd - weekdayOf(first) + 7) % 7 + (n - 1) * 7);
  }
  const last = addDays(makeDate(year, month + 1, 1), -1);
  return addDays(last, -((weekdayOf(last) - wd + 7) % 7));
}

const FIXED = [[1, 1, '元旦', '元旦'], [6, 19, '六月节', '六月节'], [7, 4, '独立日', '独立日'], [11, 11, '退伍军人节', '退伍军人'], [12, 25, '圣诞节', '圣诞节']];
const FLOATING = [
  [1, 1, 3, '马丁·路德·金纪念日', '金纪念日'],
  [2, 1, 3, '总统日', '总统日'],
  [5, 1, -1, '阵亡将士纪念日', '阵亡将士'],
  [9, 1, 1, '劳动节', '劳动节'],
  [10, 1, 2, '哥伦布日', '哥伦布日'],
  [11, 4, 4, '感恩节', '感恩节']
];

const cache = new Map();
export function holidaysOfYear(year) {
  if (!Number.isSafeInteger(year) || year < 1900 || year > 2199) return new Map();
  if (cache.has(year)) return cache.get(year);
  const out = new Map();
  for (const [m, wd, n, name, short] of FLOATING) out.set(nthWeekday(year, m, wd, n), {name, short, observed: false});
  // 固定日期的节日：本年的，加上下一年元旦落在今年 12/31 的补休
  for (const y of [year, year + 1]) for (const [m, d, name, short] of FIXED) {
    const day = makeDate(y, m, d), wd = weekdayOf(day);
    if (y === year) out.set(day, {name, short, observed: false});
    const obs = wd === 6 ? addDays(day, -1) : wd === 0 ? addDays(day, 1) : null;
    if (obs && obs.startsWith(String(year)) && !out.has(obs)) out.set(obs, {name: `${name}（补休）`, short: '补休', observed: true});
  }
  cache.set(year, out);
  return out;
}
export function holidayOn(date) {
  if (!validDate(date)) return null;
  return holidaysOfYear(Number(date.slice(0, 4))).get(date) ?? null;
}
