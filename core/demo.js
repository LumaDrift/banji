// 示例数据：按「今天」往前生成两个多月真实感的记录，用来看清每个功能。全部用正常的数据函数生成，保证格式正确。
// demoState(today, nowMinutes) → 一份完整的考勤数据（不写存储）。
//
// 内容：
//   两份工作：超市（日薪 $150，加班 $25/小时，每月 10 号发上个月，碰周末提前）
//             晚上的餐厅（时薪 $18，每周一期 周一到周日，结束后 5 天（周五）发）
//   班次：超市 早班 09:00–17:00 周一到五（休息 30 分钟）；餐厅 晚班 18:00–22:00 周二、四、六
//   记录：大部分班都打了卡；有加班、半天、只加班的周六、请假休息一天、单独放假一天、
//         最近两个工作日超市漏记；过去的发薪期大部分记了实际到账，最近一期留着「待记到账」。
//   今天：如果现在已经过了上班时间，就当作已经打卡，首页能看到今天已赚在涨。

import {emptyState, addJob, addRule, setPayCycle, addShiftPlan, recordShift, setEntries, addOvertime, setDayPlan, setReceipt, summarize, planFor, periodsBetween} from './domain.js?v=89b9af5a97';
import {addDays, weekdayOf, makeDate, timeToMinutes, daysBetween} from './dates.js?v=89b9af5a97';

const MART = 'demo-mart', DINER = 'demo-diner';
const pad = n => String(n).padStart(2, '0');
const hm = min => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
/** 某天往前数第 n 个星期 wd（不含当天）。 */
const lastWeekday = (from, wd, n = 1) => addDays(from, -(((weekdayOf(from) - wd + 7) % 7) || 7) - (n - 1) * 7);

export function demoState(today, nowMinutes = 12 * 60) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const start = makeDate(y, m - 2, 1);
  let s = emptyState();
  s.settings = {halfDay: true, customHours: false, overtime: true, autoClock: true};
  s = addJob(s, {id: MART, name: '超市'});
  s = addJob(s, {id: DINER, name: '晚上的餐厅'});
  s = addRule(s, {jobId: MART, effective: start, mode: 'daily', rateCents: 15000, defaultMinutes: 450, overtimeRateCents: 2500});
  s = addRule(s, {jobId: DINER, effective: start, mode: 'hourly', rateCents: 1800, defaultMinutes: 240, overtimeRateCents: 2700});
  s = setPayCycle(s, MART, {kind: 'monthly', startDay: 1, payMonthOffset: 1, payDay: 10, weekendRule: 'before'});
  const anchor = addDays(start, -((weekdayOf(start) + 6) % 7)); // start 所在那周的周一
  s = setPayCycle(s, DINER, {kind: 'weekly', lengthDays: 7, anchor, payOffsetDays: 5, weekendRule: 'none'});
  s = addShiftPlan(s, {id: 'demo-early', jobId: MART, name: '早班', start: '09:00', end: '17:00', breakMinutes: 30, weekdays: [1, 2, 3, 4, 5], from: start, until: null});
  s = addShiftPlan(s, {id: 'demo-night', jobId: DINER, name: '晚班', start: '18:00', end: '22:00', breakMinutes: 0, weekdays: [2, 4, 6], from: start, until: null});

  // 特别的日子（都在今天之前）
  const yesterday = addDays(today, -1);
  const offDay = lastWeekday(today, 3, 3);           // 三周前的周三：单独放假
  const sickDay = lastWeekday(today, 4, 2);          // 两周前的周四：请假，记为休息
  const halfDay = lastWeekday(today, 1, 2);          // 两周前的周一：超市只上半天
  const otDays = new Set([lastWeekday(today, 5, 1), lastWeekday(today, 2, 3), lastWeekday(today, 5, 4)]); // 加班 2 小时
  const extraSat = lastWeekday(today, 6, 2);         // 两周前的周六：超市临时加班 3 小时（只加班）
  const martDays = [];
  for (let d = yesterday; d >= start && martDays.length < 2; d = addDays(d, -1)) if (planFor(s, d).shifts.some(x => x.jobId === MART) && d !== offDay && d !== sickDay) martDays.push(d);
  const missing = new Set(martDays);                 // 最近两个有超市班的日子：漏记

  s = setDayPlan(s, offDay, {type: 'off'});
  for (let d = start; d <= yesterday; d = addDays(d, 1)) {
    if (d === sickDay) { s = setEntries(s, d, [{status: 'rest'}]); continue; }
    const seed = daysBetween('2000-01-01', d);
    for (const sh of planFor(s, d).shifts) {
      if (sh.jobId === MART && missing.has(d)) continue;
      const clockIn = hm(timeToMinutes(sh.start) - (seed * 7 + sh.start.length) % 9);
      if (sh.jobId === MART && d === halfDay) s = recordShift(s, d, sh.key, {dayUnits: 1, minutes: 225, clockIn});
      else s = recordShift(s, d, sh.key, {overtimeMinutes: sh.jobId === MART && otDays.has(d) ? 120 : 0, clockIn});
    }
    if (d === extraSat) s = addOvertime(s, d, MART, 180, {start: '10:00', end: '13:00'});
  }
  // 今天：已经到了上班时间的班，当作已经打卡
  for (const sh of planFor(s, today).shifts) {
    const inAt = timeToMinutes(sh.start) + 2;
    if (nowMinutes >= inAt) s = recordShift(s, today, sh.key, {clockIn: hm(inAt)});
  }
  // 实际到账：过了发薪日的各期，除了最近一期，都记上（实际到手比预计少一点，像扣了税）
  for (const [jobId, cut] of [[MART, 0.89], [DINER, 0.92]]) {
    const past = periodsBetween(s, jobId, start, today).filter(p => p.payday < today);
    for (const p of past.slice(0, -1)) {
      const cents = summarize(s, p.start, p.end, jobId).cents;
      if (cents > 0) s = setReceipt(s, jobId, p, {amountCents: Math.round(cents * cut), date: p.payday, note: '示例：扣税后到手'});
    }
  }
  return s;
}
