// 排班（计划）层：哪天应该上哪家公司的班、几点到几点。和实际出勤（state.entries）完全分开。
//
// state.shiftPlans  每周重复的班次
//   { id, jobId, name, start:'09:00', end:'18:00', breakMinutes:60, weekdays:[1,2,3,4,5], from:'2026-03-01', until:null }
//   - jobId：属于哪家公司（state.jobs 里的 id）
//   - weekdays：0 = 周日 … 6 = 周六；end 早于 start 表示跨过午夜
//   - 同一家公司在同一天有多条重复班次都适用时，只保留 from 最晚的那一批（「从某天起改成…」）；
//     from 相同的几条会同时保留（比如上午、晚上两段的分段班）。不同公司互不影响。
//
// state.dayPlans    只影响某一天的单独安排，优先于全部重复班次
//   { 'YYYY-MM-DD': { type:'off' } }                                         这天放假
//   { 'YYYY-MM-DD': { type:'shifts', shifts:[{ jobId, name, start, end, breakMinutes }] } }  这天按这几段上班
//
// 一段班用 key = `${jobId}@${start}` 识别。

import {validDate, validTime, spanMinutes, weekdayOf, timeToMinutes} from './dates.js?v=89b9af5a97';

const fail = m => { throw new Error(m); };
const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
export const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id);
export const shiftKey = sh => `${sh.jobId}@${sh.start}`;

function validateShift(x, what, jobIds) {
  if (!x || !validId(x.jobId) || (jobIds && !jobIds.has(x.jobId))) fail(`${what}要选择一家公司`);
  if (typeof x.name !== 'string' || !x.name.trim() || x.name.trim().length > 20) fail(`${what}名称须为 1–20 个字`);
  if (!validTime(x.start) || !validTime(x.end)) fail(`${what}时间须为 HH:MM`);
  const span = spanMinutes(x.start, x.end);
  if (span === 0) fail(`${what}上下班时间不能相同`);
  const breakMinutes = x.breakMinutes ?? 0;
  if (!int(breakMinutes, 0, span - 1)) fail(`${what}休息时长须为整分钟，且短于整个班次`);
  return {jobId: x.jobId, name: x.name.trim(), start: x.start, end: x.end, breakMinutes};
}

export function validateShiftPlan(p, jobIds) {
  if (!p || !validId(p.id)) fail('重复班次编号无效');
  const shift = validateShift(p, '班次', jobIds);
  if (!Array.isArray(p.weekdays) || !p.weekdays.length || p.weekdays.some(d => !int(d, 0, 6)) || new Set(p.weekdays).size !== p.weekdays.length) fail('请选择每周重复的星期（不能重复）');
  if (!validDate(p.from)) fail('开始日期无效');
  if (p.until !== null && p.until !== undefined && (!validDate(p.until) || p.until < p.from)) fail('结束日期无效，须不早于开始日期');
  return {id: p.id, ...shift, weekdays: [...p.weekdays].sort((a, b) => a - b), from: p.from, until: p.until ?? null};
}

export function validateDayPlan(p, jobIds) {
  if (p && p.type === 'off') return {type: 'off'};
  if (p && p.type === 'shifts') {
    if (!Array.isArray(p.shifts) || !p.shifts.length || p.shifts.length > 6) fail('这天至少安排一段班，最多 6 段');
    const shifts = p.shifts.map(x => validateShift(x, '当天班次', jobIds)).sort((a, b) => a.start.localeCompare(b.start));
    if (new Set(shifts.map(shiftKey)).size !== shifts.length) fail('同一家公司同一个上班时间只能排一段');
    return {type: 'shifts', shifts};
  }
  fail('单日安排只能是「放假」或「这几段班」');
}

export function validatePlans(shiftPlans, dayPlans, jobIds) {
  if (!Array.isArray(shiftPlans) || !dayPlans || typeof dayPlans !== 'object' || Array.isArray(dayPlans)) fail('排班格式无效');
  const plans = shiftPlans.map(p => validateShiftPlan(p, jobIds));
  if (new Set(plans.map(p => p.id)).size !== plans.length) fail('重复班次编号重复');
  const days = {};
  for (const [date, p] of Object.entries(dayPlans)) {
    if (!validDate(date)) fail('单日安排日期无效');
    days[date] = validateDayPlan(p, jobIds);
  }
  return {shiftPlans: plans, dayPlans: days};
}

const withMinutes = s => {
  const span = spanMinutes(s.start, s.end);
  return {...s, minutes: span - s.breakMinutes, spanMinutes: span, key: shiftKey(s)};
};

/**
 * 这一天的计划。
 * 返回 { kind:'shifts'|'off'|'none', source:'day'|'repeat'|null, shifts:[{ jobId, name, start, end, breakMinutes, minutes, spanMinutes, key, planId? }] }
 * shifts 按上班时间排序；minutes 是扣掉休息后的计薪分钟。
 */
export function planFor(s, date) {
  if (!validDate(date)) fail('日期无效');
  const day = s.dayPlans?.[date];
  if (day?.type === 'off') return {kind: 'off', source: 'day', shifts: []};
  if (day?.type === 'shifts') return {kind: 'shifts', source: 'day', shifts: day.shifts.map(withMinutes)};
  // 每个在这天生效的重复班次都排上（同一份工作可以一天几段）。
  // 只有「同一份工作、同一个上班时间」的两条会冲突：那就按开始日期晚的那条算（相当于从那天起换了班）。
  const wd = weekdayOf(date), byKey = new Map();
  for (const p of s.shiftPlans ?? []) {
    if (!(p.from <= date && (p.until === null || date <= p.until) && p.weekdays.includes(wd))) continue;
    const key = shiftKey(p), cur = byKey.get(key);
    if (!cur || p.from > cur.from) byKey.set(key, p);
  }
  const shifts = [...byKey.values()].map(p => ({...withMinutes({jobId: p.jobId, name: p.name, start: p.start, end: p.end, breakMinutes: p.breakMinutes}), planId: p.id}));
  shifts.sort((a, b) => a.start.localeCompare(b.start) || a.jobId.localeCompare(b.jobId));
  return shifts.length ? {kind: 'shifts', source: 'repeat', shifts} : {kind: 'none', source: null, shifts: []};
}

export const hasShift = (s, date) => planFor(s, date).kind === 'shifts';

/** 一段班在当天的分钟区间 [start, end)，跨午夜的 end 会超过 1440。 */
export function shiftWindow(sh) {
  const a = timeToMinutes(sh.start); let b = timeToMinutes(sh.end); if (b <= a) b += 1440;
  return {startMin: a, endMin: b};
}

const jobSet = s => new Set((s.jobs ?? []).map(j => j.id));
function nextId(s) {
  let n = (s.shiftPlans ?? []).length + 1;
  while (s.shiftPlans.some(p => p.id === 'plan-' + n)) n++;
  return 'plan-' + n;
}

/** 新增每周重复的班次；没给 id 时自动生成。 */
export function addShiftPlan(s, raw) {
  const p = validateShiftPlan({...raw, id: raw.id ?? nextId(s)}, jobSet(s));
  if (s.shiftPlans.some(x => x.id === p.id)) fail('重复班次编号已存在');
  const n = structuredClone(s);
  n.shiftPlans.push(p);
  return n;
}
export function updateShiftPlan(s, id, raw) {
  const i = s.shiftPlans.findIndex(p => p.id === id);
  if (i < 0) fail('找不到这个重复班次');
  const n = structuredClone(s);
  n.shiftPlans[i] = validateShiftPlan({...raw, id}, jobSet(s));
  return n;
}
export function removeShiftPlan(s, id) {
  if (!s.shiftPlans.some(p => p.id === id)) fail('找不到这个重复班次');
  const n = structuredClone(s);
  n.shiftPlans = n.shiftPlans.filter(p => p.id !== id);
  return n;
}
/** 让某个重复班次在 lastDate（含）之后不再重复。 */
export function endShiftPlan(s, id, lastDate) {
  const p = s.shiftPlans.find(x => x.id === id);
  if (!p) fail('找不到这个重复班次');
  return updateShiftPlan(s, id, {...p, until: lastDate});
}
/** 单独设置某一天（放假 / 这几段班）；传 null 恢复成按重复班次。只影响这一天。 */
export function setDayPlan(s, date, plan) {
  if (!validDate(date)) fail('日期无效');
  const n = structuredClone(s);
  if (plan === null) delete n.dayPlans[date];
  else n.dayPlans[date] = validateDayPlan(plan, jobSet(s));
  return n;
}
