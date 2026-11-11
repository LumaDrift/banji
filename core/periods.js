// 发薪周期：每家公司各自一套。导入的周期（state.schedules 里 jobId 相同的）优先；
// 没有导入的日子按这家公司的发薪规则（state.jobs[i].payCycle）自动生成。
//
// payCycle 二选一（或 null 表示还没设置）：
//   每月：{ kind:'monthly', startDay:1, payMonthOffset:1, payDay:10, weekendRule:'before' }
//         从每月 startDay 号算到下月 startDay 前一天为一期；
//         发薪日 = 这一期结束那个月再往后 payMonthOffset 个月的 payDay 号（没有这天就用月底）。
//   每周 / 双周：{ kind:'weekly', lengthDays:7|14, anchor:'2026-01-05', payOffsetDays:5, weekendRule:'none' }
//         anchor 是某一期的第一天；发薪日 = 这一期最后一天 + payOffsetDays 天。
//   weekendRule：发薪日碰到周六日时 'none' 不变 / 'before' 提前到周五 / 'after' 推后到周一。
//   （不知道法定节假日，只处理周末。）
//
// 每个周期：{ jobId, start, end, payday, source:'imported'|'rule', period? } 起止都包含当天。

import {validDate, addDays, daysBetween, weekdayOf, makeDate} from './dates.js?v=89b9af5a97';

const fail = m => { throw new Error(m); };
const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const RULES = ['none', 'before', 'after'];

export function validatePayCycle(c) {
  if (c === null || c === undefined) return null;
  const weekendRule = c.weekendRule ?? 'none';
  if (!RULES.includes(weekendRule)) fail('周末发薪规则无效');
  if (c.kind === 'monthly') {
    if (!int(c.startDay, 1, 28)) fail('每月周期的起始日须为 1–28 号');
    if (!int(c.payMonthOffset, 0, 2)) fail('发薪月份须为当月、次月或再下个月');
    if (!int(c.payDay, 1, 31)) fail('发薪日须为 1–31 号');
    return {kind: 'monthly', startDay: c.startDay, payMonthOffset: c.payMonthOffset, payDay: c.payDay, weekendRule};
  }
  if (c.kind === 'weekly') {
    if (![7, 14].includes(c.lengthDays)) fail('按周发薪只支持每周或每两周');
    if (!validDate(c.anchor)) fail('请给出某一期的第一天');
    if (!int(c.payOffsetDays, 0, 60)) fail('发薪日须在周期结束后 0–60 天内');
    return {kind: 'weekly', lengthDays: c.lengthDays, anchor: c.anchor, payOffsetDays: c.payOffsetDays, weekendRule};
  }
  fail('发薪规则只能是「每月」或「每周/双周」');
}

function adjustWeekend(date, rule) {
  const wd = weekdayOf(date);
  if (rule === 'before') return wd === 6 ? addDays(date, -1) : wd === 0 ? addDays(date, -2) : date;
  if (rule === 'after') return wd === 6 ? addDays(date, 2) : wd === 0 ? addDays(date, 1) : date;
  return date;
}

/** 按规则算出包含 date 的那一期（不考虑导入的周期）。 */
export function cyclePeriodFor(c, date) {
  if (!c) return null;
  if (c.kind === 'monthly') {
    const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
    const start = d >= c.startDay ? makeDate(y, m, c.startDay) : makeDate(y, m - 1, c.startDay);
    const sy = Number(start.slice(0, 4)), sm = Number(start.slice(5, 7));
    const end = addDays(makeDate(sy, sm + 1, c.startDay), -1);
    const ey = Number(end.slice(0, 4)), em = Number(end.slice(5, 7));
    return {start, end, payday: adjustWeekend(makeDate(ey, em + c.payMonthOffset, c.payDay), c.weekendRule), source: 'rule'};
  }
  const k = Math.floor(daysBetween(c.anchor, date) / c.lengthDays);
  const start = addDays(c.anchor, k * c.lengthDays), end = addDays(start, c.lengthDays - 1);
  return {start, end, payday: adjustWeekend(addDays(end, c.payOffsetDays), c.weekendRule), source: 'rule'};
}

const imported = (p, jobId) => ({jobId, start: p.start, end: p.end, payday: p.payday, period: p.period, source: 'imported'});
export const periodKey = p => `${p.start}~${p.end}`;
const jobOf = (s, jobId) => (s.jobs ?? []).find(j => j.id === jobId) || null;

/** 某家公司在某天属于哪一期。导入的周期优先；按规则生成的周期会让开导入周期占用的日子。没有就返回 null。 */
export function periodFor(s, jobId, date) {
  if (!validDate(date)) fail('日期无效');
  const mine = s.schedules.filter(p => p.jobId === jobId);
  const hit = mine.find(p => date >= p.start && date <= p.end);
  if (hit) return imported(hit, jobId);
  const g = cyclePeriodFor(jobOf(s, jobId)?.payCycle ?? null, date);
  if (!g) return null;
  for (const p of mine) {
    if (p.end < date && p.end >= g.start) g.start = addDays(p.end, 1);
    if (p.start > date && p.start <= g.end) g.end = addDays(p.start, -1);
  }
  return {jobId, ...g};
}

/** 某家公司与 [from, to] 有交集的所有周期，按时间先后。 */
export function periodsBetween(s, jobId, from, to) {
  const out = [], mine = s.schedules.filter(p => p.jobId === jobId);
  let d = from;
  while (d <= to) {
    const p = periodFor(s, jobId, d);
    if (p) { out.push(p); d = addDays(p.end, 1); continue; }
    const next = mine.filter(x => x.start > d).sort((a, b) => a.start.localeCompare(b.start))[0];
    if (!next) break;
    d = next.start;
  }
  return out;
}

/** 发薪日落在 [from, to] 内的周期（不给 jobId 就是所有公司），按发薪日先后。 */
export function paydaysBetween(s, from, to, jobId) {
  const seen = new Map();
  for (const j of s.jobs ?? []) {
    if (jobId && j.id !== jobId) continue;
    for (const p of periodsBetween(s, j.id, addDays(from, -125), to)) if (p.payday >= from && p.payday <= to) seen.set(j.id + '|' + periodKey(p), p);
    for (const p of s.schedules) if (p.jobId === j.id && p.payday >= from && p.payday <= to) seen.set(j.id + '|' + periodKey(p), imported(p, j.id));
  }
  return [...seen.values()].sort((a, b) => a.payday.localeCompare(b.payday) || a.start.localeCompare(b.start) || a.jobId.localeCompare(b.jobId));
}

/** 从 today 起最近的一次发薪（不给 jobId 就是所有公司里最近的）：{ jobId, payday, daysLeft, period }；找不到返回 null。 */
export function nextPayday(s, today, jobId) {
  const p = paydaysBetween(s, today, addDays(today, 400), jobId)[0];
  return p ? {jobId: p.jobId, payday: p.payday, daysLeft: daysBetween(today, p.payday), period: p} : null;
}
