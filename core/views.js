// 给界面用的只读查询：日历每天的格子、漏记提醒、按公司按期/按月/按年汇总、历史账单、首页「钱在流」。
// 都是纯函数，不写存储。日历滑动时用 daysInfo 一次取一页需要的日期，不要逐格调用。

import {validDate, validMonth, addDays, daysBetween, monthLength, weekdayOf, timeToMinutes} from './dates.js?v=89b9af5a97';
import {planFor} from './plan.js?v=89b9af5a97';
import {periodFor, periodsBetween, paydaysBetween, nextPayday, periodKey} from './periods.js?v=89b9af5a97';
import {entryPay, summarize, receiptFor, entriesOf, matchEntry, jobName, dayPay} from './domain.js?v=89b9af5a97';

const fail = m => { throw new Error(m); };
const MAX_RANGE = 800;

/**
 * [start, end] 每一天的情况（最多 800 天），today 用来判断「漏记」。
 * 每项：{ date, weekday, plan:{kind, source}, shifts, entries, pay, unpriced, worked, overtime, rest, isPayday, paydays, missing }
 *   shifts   当天排的每段班：{ key, jobId, jobName, name, start, end, minutes, entry, entryIndex }（entry 是配对到的上班记录或 null）
 *   entries  当天全部记录（没记录是空数组，不等于休息）
 *   pay      当天工资合计（分）；unpriced 是没有工资规则、没算进去的条数
 *   paydays  这天发薪的周期：[{ jobId, jobName, period }]
 *   missing  今天之前、有排了班却没配到上班记录的段，且这天没记休息
 */
export function daysInfo(s, start, end, today) {
  if (!validDate(start) || !validDate(end) || start > end) fail('日期范围无效');
  if (daysBetween(start, end) >= MAX_RANGE) fail('一次最多取 800 天');
  const paydays = new Map();
  for (const p of paydaysBetween(s, start, end)) { if (!paydays.has(p.payday)) paydays.set(p.payday, []); paydays.get(p.payday).push({jobId: p.jobId, jobName: jobName(s, p.jobId), period: p}); }
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const plan = planFor(s, d), entries = entriesOf(s, d), rest = entries[0]?.status === 'rest';
    const shifts = plan.shifts.map(sh => { const i = matchEntry(s, d, sh); return {key: sh.key, jobId: sh.jobId, jobName: jobName(s, sh.jobId), name: sh.name, start: sh.start, end: sh.end, minutes: sh.minutes, entry: i >= 0 ? entries[i] : null, entryIndex: i}; });
    const {cents, unpriced} = dayPay(s, d);
    out.push({
      date: d, weekday: weekdayOf(d), plan: {kind: plan.kind, source: plan.source}, shifts, entries,
      pay: cents, unpriced,
      worked: entries.some(e => e.status === 'work'), overtime: entries.some(e => e.status === 'overtime' || e.overtimeMinutes > 0), rest,
      isPayday: paydays.has(d), paydays: paydays.get(d) ?? [],
      missing: !!today && d < today && !rest && shifts.some(x => !x.entry)
    });
  }
  return out;
}
export const dayInfo = (s, date, today) => daysInfo(s, date, date, today)[0];

/** 某个月（'YYYY-MM'）每一天的情况。 */
export function monthDays(s, month, today) {
  if (!validMonth(month)) fail('月份须为 YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  return daysInfo(s, month + '-01', `${month}-${String(monthLength(y, m)).padStart(2, '0')}`, today);
}

/** 有排班却没有配到上班记录的日子（from 到 to，都包含；记了休息的日子不算）。 */
export function missingRecords(s, from, to) {
  if (!validDate(from) || !validDate(to) || from > to) fail('日期范围无效');
  if (daysBetween(from, to) >= MAX_RANGE * 3) fail('范围太大');
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (entriesOf(s, d)[0]?.status === 'rest') continue;
    if (planFor(s, d).shifts.some(sh => matchEntry(s, d, sh) < 0)) out.push(d);
  }
  return out;
}

/**
 * 某家公司某一期的汇总：出勤、工时、预计工资，加上实际到账和差额。
 * status：'current' 进行中 / 'waiting' 已结束等发薪 / 'due' 已过发薪日但还没记到账 / 'received' 已记到账
 */
export function periodSummary(s, jobId, period, today) {
  const sum = summarize(s, period.start, period.end, jobId);
  const receipt = receiptFor(s, jobId, period);
  let status = 'waiting';
  if (receipt) status = 'received';
  else if (today && today <= period.end) status = 'current';
  else if (today && today > period.payday) status = 'due';
  return {
    jobId, jobName: jobName(s, jobId),
    period: {...period, key: periodKey(period)},
    ...sum, receipt,
    differenceCents: receipt && sum.unpriced === 0 ? receipt.amountCents - sum.cents : null,
    daysUntilPayday: today ? daysBetween(today, period.payday) : null,
    status
  };
}
/** 每家公司 today 所在的这一期（没设发薪的公司不在里面）。 */
export function currentPeriods(s, today) {
  return s.jobs.map(j => { const p = periodFor(s, j.id, today); return p ? periodSummary(s, j.id, p, today) : null; }).filter(Boolean);
}

/** 自然月汇总（'YYYY-MM'），给 jobId 就只算这家公司。 */
export function monthSummary(s, month, jobId) {
  if (!validMonth(month)) fail('月份须为 YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  return summarize(s, month + '-01', `${month}-${String(monthLength(y, m)).padStart(2, '0')}`, jobId);
}
/** 一年的汇总：全年合计、每月一行、全年实际到账合计（按到账日期所在年份）。 */
export function yearSummary(s, year) {
  if (!/^\d{4}$/.test(String(year))) fail('年份无效');
  const y = String(year), months = [];
  for (let m = 1; m <= 12; m++) { const k = `${y}-${String(m).padStart(2, '0')}`; months.push({month: k, ...monthSummary(s, k)}); }
  const receivedCents = Object.values(s.receipts).filter(r => r.date.startsWith(y)).reduce((a, r) => a + r.amountCents, 0);
  return {year: y, total: summarize(s, `${y}-01-01`, `${y}-12-31`), months, receivedCents};
}
/** 历史账单：每家公司 today 之前已经结束的各期，按发薪日从新到旧，最多 limit 期。 */
export function billHistory(s, today, limit = 24) {
  const out = [];
  for (const j of s.jobs) {
    const dates = Object.keys(s.entries).filter(d => s.entries[d].some(e => e.jobId === j.id)).sort();
    const first = [dates[0], s.schedules.find(p => p.jobId === j.id)?.start].filter(Boolean).sort()[0];
    if (!first || first >= today) continue;
    for (const p of periodsBetween(s, j.id, first, addDays(today, -1))) if (p.end < today) out.push(periodSummary(s, j.id, p, today));
  }
  return out.sort((a, b) => b.period.payday.localeCompare(a.period.payday) || a.jobName.localeCompare(b.jobName)).slice(0, limit);
}

// ---------- 首页「钱在流」 ----------
const abs = (date, seconds = 0) => daysBetween('1970-01-01', date) * 86400 + seconds;
/** 这条记录的钱从什么时候开始算「挣到了」：下班时刻（秒，以 date 当天 0 点为起点）。 */
function earnedAt(e) {
  if (e.clockOut) { let end = timeToMinutes(e.clockOut); if (e.clockIn && end <= timeToMinutes(e.clockIn)) end += 1440; return end * 60; }
  if (e.status === 'work' && e.end) { let end = timeToMinutes(e.end); if (e.start && end <= timeToMinutes(e.start)) end += 1440; return end * 60; }
  if (e.clockIn) return (timeToMinutes(e.clockIn) + (e.status === 'work' ? e.minutes : e.overtimeMinutes)) * 60;
  return 86400; // 不知道几点下班：按当天结束算
}
function jobFlow(s, jobId, today, now) {
  const next = nextPayday(s, today, jobId); if (!next) return null;
  const period = next.period, payAt = abs(period.payday);
  let flowing = 0, earned = 0, rate = 0, unpriced = 0; const days = new Set();
  for (const [d, list] of Object.entries(s.entries)) {
    if (d < period.start || d > period.end) continue;
    for (const e of list) {
      if (e.status === 'rest' || e.jobId !== jobId) continue;
      const cents = entryPay(s, d, e);
      if (cents === null) { unpriced++; continue; }
      const from = abs(d, earnedAt(e));
      if (now < from) continue; // 还没下班
      days.add(d); earned += cents;
      if (from >= payAt || now >= payAt) { flowing += cents; continue; }
      flowing += cents * (now - from) / (payAt - from);
      rate += cents / (payAt - from);
    }
  }
  return {jobId, jobName: jobName(s, jobId), period, payday: period.payday, isPayday: today === period.payday, secondsLeft: Math.max(0, payAt - now), flowingCents: flowing, earnedCents: earned, centsPerSecond: rate, days: days.size, unpriced};
}
/**
 * 首页的「待发工资」：每条已经下班的记录，从下班那一刻起把它的工资匀速流进来，
 * 流到这家公司这一期的发薪日 0 点，正好等于这一期已挣到的总数；发薪当天定格不动。几家公司加在一起。
 * 只用真实记录，不平摊、不预估。nowSeconds = 从 today 0 点起经过的秒数。没有任何公司设了发薪返回 null。
 * 返回 { jobs:[每家公司的一份], flowingCents, earnedCents, centsPerSecond, next:最近一次发薪（今天发的不算） }
 */
export function payFlow(s, today, nowSeconds) {
  const now = abs(today, nowSeconds);
  const jobs = s.jobs.map(j => jobFlow(s, j.id, today, now)).filter(Boolean);
  if (!jobs.length) return null;
  const upcoming = jobs.filter(j => !j.isPayday).sort((a, b) => a.secondsLeft - b.secondsLeft);
  return {
    jobs,
    flowingCents: jobs.reduce((a, j) => a + j.flowingCents, 0),
    earnedCents: jobs.reduce((a, j) => a + j.earnedCents, 0),
    centsPerSecond: jobs.reduce((a, j) => a + j.centsPerSecond, 0),
    next: upcoming[0] ?? null,
    paidToday: jobs.filter(j => j.isPayday)
  };
}
