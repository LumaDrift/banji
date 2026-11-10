// 考勤与计薪的纯函数。所有金额用整数「分」，所有时长用整数「分钟」。
//
// 数据版本 3：
//   - jobs：公司（工作）。每家公司有自己的工资规则、发薪规则（payCycle）、导入的发薪周期、到账记录。
//   - shiftPlans / dayPlans：排班（计划），每段班属于一家公司，一天可以有好几段，见 plan.js。
//   - entries：实际出勤，每天是一个列表，一条对应一段班（或只加班、或休息）：
//       { status:'work', jobId, dayUnits:1|2, minutes, overtimeMinutes, clockIn?, clockOut?, start?, end? }
//       { status:'overtime', jobId, overtimeMinutes, clockIn?, clockOut? }   只加班，不算一天出勤
//       { status:'rest' }                                                    这天明确休息（只能单独一条）
//     start / end 记的是这条对应的排班时间，用来和排班配对、算跳动收入的下班时刻。
//   - 打卡只在这段班的时间段里开放：上班前 60 分钟到下班。错过了在日历里补记。
// 版本 1、2 的数据读入时自动升级：原来的一切归到一家「我的工作」下，记录不丢、不改金额。

import {validDate, validTime, timeToMinutes} from './dates.js?v=62be305706';
import {planFor, validatePlans, validId, shiftKey, shiftWindow} from './plan.js?v=62be305706';
import {validatePayCycle, periodKey} from './periods.js?v=62be305706';

export {validDate} from './dates.js?v=62be305706';
export {planFor, hasShift, addShiftPlan, updateShiftPlan, removeShiftPlan, endShiftPlan, setDayPlan, shiftKey, shiftWindow} from './plan.js?v=62be305706';
export {periodFor, periodsBetween, paydaysBetween, nextPayday, periodKey, cyclePeriodFor} from './periods.js?v=62be305706';

export const VERSION = 3;
export const OPEN_BEFORE_MINUTES = 60;
const fail = m => { throw new Error(m); };
const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const hm = min => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export const emptyState = () => ({version: VERSION, jobs: [], entries: {}, rules: [], schedules: [], shiftPlans: [], dayPlans: {}, receipts: {}, settings: {halfDay: false, customHours: false, overtime: false, autoClock: true}, autoSince: null});

/** 设备当前时区的今天。 */
export function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
/** 指定时区（如 'America/New_York'、'Asia/Shanghai'）的今天。 */
export function todayIn(timeZone, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(now).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function moneyInput(s) {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(String(s))) fail('金额须为非负数，最多两位小数、七位整数');
  const [a, b = ''] = String(s).split('.'); return Number(a) * 100 + Number(b.padEnd(2, '0'));
}
export function minutesInput(s) {
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(String(s))) fail('工时最多两位小数');
  const n = Number(s) * 60; if (!Number.isInteger(Math.round(n * 100) / 100) || n < 0 || n > 1440) fail('工时须为整分钟，且在 0–24 小时内'); return Math.round(n);
}
export const formatMoney = cents => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(cents / 100);

// ---------- 公司 ----------
const jobIdsOf = s => new Set(s.jobs.map(j => j.id));
function validateJob(j) {
  if (!j || !validId(j.id)) fail('公司编号无效');
  if (typeof j.name !== 'string' || !j.name.trim() || j.name.trim().length > 20) fail('公司名称须为 1–20 个字');
  return {id: j.id, name: j.name.trim(), payCycle: validatePayCycle(j.payCycle ?? null)};
}
function validateJobs(list) {
  if (!Array.isArray(list) || list.length > 20) fail('公司列表无效（最多 20 家）');
  const jobs = list.map(validateJob);
  if (new Set(jobs.map(j => j.id)).size !== jobs.length) fail('公司编号重复');
  if (new Set(jobs.map(j => j.name.toLowerCase())).size !== jobs.length) fail('公司名称不能重复');
  return jobs;
}
export const jobFor = (s, id) => s.jobs.find(j => j.id === id) || null;
export const jobName = (s, id) => jobFor(s, id)?.name ?? '未知公司';
/** 新增一家公司；没给 id 时自动生成。 */
export function addJob(s, {name, payCycle = null, id} = {}) {
  let nid = id; if (!nid) { let n = s.jobs.length + 1; while (s.jobs.some(j => j.id === 'job-' + n)) n++; nid = 'job-' + n; }
  const n = structuredClone(s); n.jobs.push({id: nid, name, payCycle});
  n.jobs = validateJobs(n.jobs); return n;
}
/** 改名或改发薪规则（不给的字段保持原样）。 */
export function updateJob(s, id, patch) {
  const i = s.jobs.findIndex(j => j.id === id); if (i < 0) fail('找不到这家公司');
  const n = structuredClone(s); n.jobs[i] = {...n.jobs[i], ...(patch.name !== undefined ? {name: patch.name} : {}), ...(patch.payCycle !== undefined ? {payCycle: patch.payCycle} : {})};
  n.jobs = validateJobs(n.jobs); return n;
}
export const setPayCycle = (s, jobId, cycle) => updateJob(s, jobId, {payCycle: cycle});
/** 删除一家还没有任何记录、规则、排班、周期、到账的公司。 */
export function removeJob(s, id) {
  if (!jobFor(s, id)) fail('找不到这家公司');
  const used = [];
  const days = Object.values(s.entries).filter(l => l.some(e => e.jobId === id)).length; if (days) used.push(`${days} 天出勤`);
  const rules = s.rules.filter(r => r.jobId === id).length; if (rules) used.push(`${rules} 条工资规则`);
  const plans = s.shiftPlans.filter(p => p.jobId === id).length + Object.values(s.dayPlans).filter(d => d.type === 'shifts' && d.shifts.some(x => x.jobId === id)).length; if (plans) used.push(`${plans} 个班次`);
  const sch = s.schedules.filter(p => p.jobId === id).length; if (sch) used.push(`${sch} 期导入的发薪周期`);
  const rec = Object.keys(s.receipts).filter(k => k.startsWith(id + '|')).length; if (rec) used.push(`${rec} 条到账记录`);
  if (used.length) fail(`这家公司还有 ${used.join('、')}，不能删除；可以改名`);
  const n = structuredClone(s); n.jobs = n.jobs.filter(j => j.id !== id); return n;
}

// ---------- 出勤记录 ----------
function times(e) {
  const t = {};
  for (const k of ['clockIn', 'clockOut', 'start', 'end']) if (e[k] !== undefined) { if (!validTime(e[k])) fail('时间须为 HH:MM'); t[k] = e[k]; }
  if ((t.start === undefined) !== (t.end === undefined)) fail('排班时间要么都有，要么都没有');
  return t;
}
export function validateEntry(e, jobIds) {
  if (!e || !['work', 'rest', 'overtime'].includes(e.status)) fail('记录状态无效');
  if (e.status === 'rest') return {status: 'rest'};
  if (!validId(e.jobId) || (jobIds && !jobIds.has(e.jobId))) fail('记录要属于一家公司');
  if (e.status === 'overtime') {
    if (!int(e.overtimeMinutes, 1, 1440)) fail('加班时长须为 1 分钟到 24 小时');
    const {clockIn, clockOut} = times(e);
    return {status: 'overtime', jobId: e.jobId, overtimeMinutes: e.overtimeMinutes, ...(clockIn ? {clockIn} : {}), ...(clockOut ? {clockOut} : {})};
  }
  if (![1, 2].includes(e.dayUnits) || !int(e.minutes, 1, 1440) || !int(e.overtimeMinutes, 0, 1440) || e.minutes + e.overtimeMinutes > 1440) fail('工时或半天设置无效，总工时不可超过 24 小时');
  return {status: 'work', jobId: e.jobId, dayUnits: e.dayUnits, minutes: e.minutes, overtimeMinutes: e.overtimeMinutes, ...times(e)};
}
const entryMinutes = e => e.status === 'work' ? e.minutes + e.overtimeMinutes : e.status === 'overtime' ? e.overtimeMinutes : 0;
const sortKey = e => e.start || e.clockIn || '99:99';
/** 校验一天的全部记录。 */
export function validateDay(list, jobIds) {
  if (!Array.isArray(list) || !list.length || list.length > 8) fail('一天的记录须为 1–8 条');
  const out = list.map(e => validateEntry(e, jobIds));
  if (out.some(e => e.status === 'rest') && out.length > 1) fail('记了休息的日子不能再有上班或加班');
  if (out.reduce((a, e) => a + entryMinutes(e), 0) > 1440) fail('一天的总工时不能超过 24 小时');
  const works = out.filter(e => e.status === 'work' && e.start).map(e => e.jobId + '@' + e.start);
  if (new Set(works).size !== works.length) fail('同一段班不能记两次');
  const ots = out.filter(e => e.status === 'overtime').map(e => e.jobId);
  if (new Set(ots).size !== ots.length) fail('同一家公司一天只记一条「只加班」，可以把时长加在一起');
  return out.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}
export const entriesOf = (s, date) => s.entries[date] ?? [];
/** 整天替换（传 null 清空这天）。 */
export function setEntries(s, date, list) {
  if (!validDate(date)) fail('日期无效');
  const n = structuredClone(s);
  if (list === null || (Array.isArray(list) && !list.length)) delete n.entries[date]; else n.entries[date] = validateDay(list, jobIdsOf(s));
  return n;
}
export const addEntry = (s, date, e) => setEntries(s, date, [...entriesOf(s, date).filter(x => !(e.status !== 'rest' && x.status === 'rest')), e]);
export function removeEntry(s, date, index) {
  const list = entriesOf(s, date); if (!list[index]) fail('找不到这条记录');
  return setEntries(s, date, list.filter((_, i) => i !== index));
}
export function replaceEntry(s, date, index, e) {
  const list = entriesOf(s, date); if (!list[index]) fail('找不到这条记录');
  return setEntries(s, date, list.map((x, i) => i === index ? e : x));
}

// ---------- 工资规则（每家公司各自一套，按生效日期） ----------
function validateRule(r, jobIds) {
  if (!r || !validId(r.jobId) || (jobIds && !jobIds.has(r.jobId))) fail('工资规则要属于一家公司');
  if (!validDate(r.effective) || !['daily', 'hourly'].includes(r.mode) || !int(r.rateCents, 0, 999999999) || !int(r.defaultMinutes, 1, 1440) || !int(r.overtimeRateCents, 0, 999999999)) fail('工资规则格式无效');
  return {jobId: r.jobId, effective: r.effective, mode: r.mode, rateCents: r.rateCents, defaultMinutes: r.defaultMinutes, overtimeRateCents: r.overtimeRateCents};
}
const sortRules = rules => rules.sort((a, b) => a.jobId.localeCompare(b.jobId) || a.effective.localeCompare(b.effective));
export const ruleFor = (s, date, jobId) => [...s.rules].reverse().find(r => r.jobId === jobId && r.effective <= date);
export const rulesOf = (s, jobId) => s.rules.filter(r => r.jobId === jobId);
export function defaultEntry(s, date, jobId) { const r = ruleFor(s, date, jobId); return {status: 'work', jobId, dayUnits: 2, minutes: r?.defaultMinutes ?? 480, overtimeMinutes: 0}; }
const ruleEnd = (s, jobId, effective) => rulesOf(s, jobId).find(x => x.effective > effective)?.effective ?? '9999-12-31';
const jobEntries = (s, jobId) => Object.entries(s.entries).flatMap(([d, l]) => l.filter(e => e.jobId === jobId).map(e => [d, e]));
const usedDays = (s, jobId, effective) => { const end = ruleEnd(s, jobId, effective); return new Set(jobEntries(s, jobId).filter(([d]) => d >= effective && d < end).map(([d]) => d)).size; };
export function addRule(s, raw) {
  const r = validateRule(raw, jobIdsOf(s));
  if (rulesOf(s, r.jobId).some(x => x.effective === r.effective)) fail('这家公司这个生效日已有规则，请选择新的生效日期');
  // 新规则可以给还没计价的记录计价，但绝不改变已经计价的记录。
  const end = ruleEnd(s, r.jobId, r.effective);
  if (jobEntries(s, r.jobId).some(([d]) => d >= r.effective && d < end && ruleFor(s, d, r.jobId))) fail('此规则会改变已记录日期的工资，请将生效日期设在这些记录之后');
  const n = structuredClone(s); n.rules.push(r); sortRules(n.rules); return n;
}
/** 删除一条还没被任何记录用到的规则。 */
export function removeRule(s, jobId, effective) {
  if (!rulesOf(s, jobId).some(r => r.effective === effective)) fail('找不到这条工资规则');
  const used = usedDays(s, jobId, effective);
  if (used) fail(`这条规则已经用来计算 ${used} 天的工资，删掉会改变这些天的工资，所以不能删除`);
  const n = structuredClone(s); n.rules = n.rules.filter(r => !(r.jobId === jobId && r.effective === effective)); return n;
}
/** 修改一条还没被任何记录用到的规则（例如刚填错）。 */
export function updateRule(s, jobId, effective, raw) {
  if (!rulesOf(s, jobId).some(r => r.effective === effective)) fail('找不到这条工资规则');
  const used = usedDays(s, jobId, effective);
  if (used) fail(`这条规则已经用来计算 ${used} 天的工资，不能直接修改；如果是涨薪，请新增一条从以后某天开始生效的规则`);
  return addRule(removeRule(s, jobId, effective), {...raw, jobId});
}

// ---------- 发薪周期（导入的）、到账 ----------
export function validateSchedules(items, existing = [], jobId) {
  if (!Array.isArray(items) || !items.length || items.length > 10000) fail('发薪安排必须是非空数组（最多 10000 项）');
  const parsed = items.map(x => {
    if (!x || x.type !== 'calendar' || !int(x.period, 1, 999999) || !validDate(x.start) || !validDate(x.end) || !validDate(x.payday) || x.start > x.end) fail('发薪安排的类型、期号或日期无效');
    const jid = jobId ?? x.jobId; if (!validId(jid)) fail('发薪周期要属于一家公司');
    return {jobId: jid, type: 'calendar', period: x.period, start: x.start, end: x.end, payday: x.payday};
  });
  const byJob = new Map();
  for (const p of [...existing, ...parsed]) { if (!byJob.has(p.jobId)) byJob.set(p.jobId, []); byJob.get(p.jobId).push(p); }
  for (const list of byJob.values()) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < list.length; i++) if (list[i].start <= list[i - 1].end) fail('计薪周期重复或重叠（起止日均包含），未导入任何数据');
  }
  return parsed;
}
export function importSchedules(s, jobId, items) {
  if (!jobFor(s, jobId)) fail('请先选择是哪家公司的发薪周期');
  const n = structuredClone(s); n.schedules.push(...validateSchedules(items, s.schedules, jobId));
  n.schedules.sort((a, b) => a.jobId.localeCompare(b.jobId) || a.start.localeCompare(b.start)); return n;
}
export function uncovered(s) { return Object.keys(s.entries).filter(d => s.entries[d].some(e => e.status !== 'rest' && !s.schedules.some(p => p.jobId === e.jobId && d >= p.start && d <= p.end))); }

const RECEIPT_KEY = /^([A-Za-z0-9_-]{1,40})\|(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/;
export const receiptKey = (jobId, period) => `${jobId}|${periodKey(period)}`;
function validateReceipt(r) {
  if (!r || !int(r.amountCents, 0, 999999999)) fail('到账金额无效');
  if (!validDate(r.date)) fail('到账日期无效');
  if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 100)) fail('备注最多 100 个字');
  return r.note ? {amountCents: r.amountCents, date: r.date, note: r.note} : {amountCents: r.amountCents, date: r.date};
}
function validateReceipts(raw, jobIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('到账记录格式无效');
  const out = {};
  for (const [k, r] of Object.entries(raw)) {
    const m = RECEIPT_KEY.exec(k); if (!m || !jobIds.has(m[1]) || !validDate(m[2]) || !validDate(m[3]) || m[2] > m[3]) fail('到账记录的周期无效');
    out[k] = validateReceipt(r);
  }
  return out;
}
/** 记下某家公司某一期实际到手的钱（与预计工资分开保存）；传 null 删除。 */
export function setReceipt(s, jobId, period, receipt) {
  if (!jobFor(s, jobId)) fail('找不到这家公司');
  if (!period || !validDate(period.start) || !validDate(period.end) || period.start > period.end) fail('周期无效');
  const key = receiptKey(jobId, period), n = structuredClone(s);
  if (receipt === null) delete n.receipts[key]; else n.receipts[key] = validateReceipt(receipt);
  return n;
}
export const receiptFor = (s, jobId, period) => s.receipts[receiptKey(jobId, period)] ?? null;

// ---------- 整份数据 ----------
function upgrade(raw) {
  // 版本 1、2 → 3：原来的一切归到一家「我的工作」下。
  const J = 'job-1';
  const entries = {};
  for (const [d, e] of Object.entries(raw.entries)) {
    if (raw.version === 1 && e?.status === 'overtime') fail('记录状态无效');
    entries[d] = e?.status === 'rest' ? [{status: 'rest'}] : [{...e, jobId: J}];
  }
  const dayPlans = {};
  for (const [d, p] of Object.entries(raw.dayPlans ?? {})) {
    if (p?.type === 'shift') { const {type, ...sh} = p; dayPlans[d] = {type: 'shifts', shifts: [{...sh, jobId: J}]}; }
    else dayPlans[d] = p;
  }
  const receipts = Object.fromEntries(Object.entries(raw.receipts ?? {}).map(([k, v]) => [`${J}|${k}`, v]));
  const shiftPlans = (raw.shiftPlans ?? []).map(p => ({...p, jobId: J}));
  const used = Object.keys(entries).some(d => entries[d][0].status !== 'rest') || raw.rules.length || raw.schedules.length || shiftPlans.length || raw.payCycle || Object.keys(receipts).length || Object.values(dayPlans).some(p => p?.type === 'shifts');
  return {
    version: VERSION, settings: raw.settings,
    jobs: used ? [{id: J, name: '我的工作', payCycle: raw.payCycle ?? null}] : [],
    entries, rules: raw.rules.map(r => ({...r, jobId: J})), schedules: raw.schedules.map(p => ({...p, jobId: J})),
    shiftPlans, dayPlans, receipts
  };
}
/** 校验整份数据；版本 1、2 自动升级为版本 3。 */
export function validateState(input) {
  if (!input || ![1, 2, VERSION].includes(input.version) || !input.entries || Array.isArray(input.entries) || typeof input.entries !== 'object' || !Array.isArray(input.rules) || !Array.isArray(input.schedules) || !input.settings) fail('备份格式或版本不支持');
  const raw = input.version < VERSION ? upgrade(input) : input;
  const s = emptyState();
  for (const k of Object.keys(s.settings)) { if (raw.settings[k] === undefined && k === 'autoClock') continue; if (typeof raw.settings[k] !== 'boolean') fail('设置格式无效'); s.settings[k] = raw.settings[k]; }
  if (raw.autoSince !== undefined && raw.autoSince !== null) { if (!validDate(raw.autoSince)) fail('自动打卡起始日期无效'); s.autoSince = raw.autoSince; }
  s.jobs = validateJobs(raw.jobs);
  const ids = jobIdsOf(s);
  for (const [date, list] of Object.entries(raw.entries)) { if (!validDate(date)) fail('记录日期无效'); s.entries[date] = validateDay(list, ids); }
  s.rules = sortRules(raw.rules.map(r => validateRule(r, ids)));
  for (let i = 1; i < s.rules.length; i++) if (s.rules[i].jobId === s.rules[i - 1].jobId && s.rules[i].effective === s.rules[i - 1].effective) fail('工资规则生效日期重复');
  s.schedules = raw.schedules.length ? validateSchedules(raw.schedules) : [];
  if (s.schedules.some(p => !ids.has(p.jobId))) fail('发薪周期属于不存在的公司');
  Object.assign(s, validatePlans(raw.shiftPlans, raw.dayPlans, ids));
  s.receipts = validateReceipts(raw.receipts ?? {}, ids);
  return s;
}

// ---------- 计价与汇总 ----------
/**
 * 一条记录的工资（分）；没有工资规则返回 null。
 * 按天算的工资，同一份工作同一天不管上了几段班，合起来只算一天（两个半天 = 一天）；
 * 这一天的钱按每段的天数（半天 1、整天 2）分到各段上，加起来正好是一天。按小时算的各段各算。
 */
export function entryPay(s, date, e) {
  if (!e || e.status === 'rest') return 0;
  const r = ruleFor(s, date, e.jobId); if (!r) return null;
  // 整数分、整数分钟计算；每条记录四舍五入一次。
  const ot = r.overtimeRateCents * e.overtimeMinutes;
  if (e.status === 'overtime') return Math.floor((ot + 30) / 60);
  if (r.mode === 'hourly') return Math.floor((r.rateCents * e.minutes + ot + 30) / 60);
  const same = x => x.status === 'work' && x.jobId === e.jobId;
  const sibs = entriesOf(s, date).filter(same);
  let i = sibs.indexOf(e);
  if (i < 0) i = sibs.findIndex(x => x.start === e.start && x.end === e.end && x.clockIn === e.clockIn && x.dayUnits === e.dayUnits && x.minutes === e.minutes);
  if (i < 0 || sibs.length < 2) return Math.floor((r.rateCents * e.dayUnits * 30 + ot + 30) / 60);
  const units = sibs.reduce((a, x) => a + x.dayUnits, 0), day = Math.floor((r.rateCents * Math.min(2, units) * 30 + 30) / 60);
  const before = sibs.slice(0, i).reduce((a, x) => a + Math.floor(day * x.dayUnits / units), 0);
  const share = i === sibs.length - 1 ? day - before : Math.floor(day * e.dayUnits / units);
  return share + Math.floor((ot + 30) / 60);
}
/** 一天的工资：{ cents, unpriced }，unpriced 是还没有工资规则、没算进去的条数。 */
export function dayPay(s, date, jobId) {
  let cents = 0, unpriced = 0;
  for (const e of entriesOf(s, date)) { if (jobId && e.jobId !== jobId) continue; const p = entryPay(s, date, e); if (p === null) unpriced++; else cents += p; }
  return {cents, unpriced};
}
/**
 * 汇总起止日期（都包含）内的记录；给 jobId 就只算这家公司。
 * days = 有上班记录的天数；shifts = 上班的段数；只加班的日子单独数在 overtimeDays。
 */
export function summarize(s, start, end, jobId) {
  let days = 0, shifts = 0, dayUnits = 0, minutes = 0, cents = 0, unpriced = 0, rest = 0, overtimeDays = 0, overtimeMinutes = 0;
  for (const [d, all] of Object.entries(s.entries)) {
    if (d < start || d > end) continue;
    if (!jobId && all[0].status === 'rest') { rest++; continue; }
    const list = all.filter(e => e.status !== 'rest' && (!jobId || e.jobId === jobId));
    if (!list.length) continue;
    const works = list.filter(e => e.status === 'work');
    if (works.length) days++; else overtimeDays++;
    for (const e of list) {
      if (e.status === 'work') { shifts++; dayUnits += e.dayUnits; minutes += e.minutes; }
      minutes += e.overtimeMinutes; overtimeMinutes += e.overtimeMinutes;
      const p = entryPay(s, d, e); if (p === null) unpriced++; else cents += p;
    }
  }
  return {days, shifts, dayUnits, minutes, cents, unpriced, rest, overtimeDays, overtimeMinutes};
}

// ---------- 打卡 ----------
/** 某段班对应的那条上班记录的下标（没有返回 -1）。 */
export function matchEntry(s, date, sh) {
  const list = entriesOf(s, date);
  const exact = list.findIndex(e => e.status === 'work' && e.jobId === sh.jobId && e.start === sh.start);
  if (exact >= 0) return exact;
  const sameJob = planFor(s, date).shifts.filter(x => x.jobId === sh.jobId).length;
  return sameJob === 1 ? list.findIndex(e => e.status === 'work' && e.jobId === sh.jobId && !e.start) : -1;
}
/**
 * 这段班现在能不能打卡。nowMinutes = 当天 0 点起的分钟数。
 * 返回 { ok, reason, message, shift?, opensAt? }；reason：off / noShift / rest / recorded / early / closed。
 */
export function clockInStatus(s, date, key, nowMinutes) {
  const plan = planFor(s, date);
  if (plan.kind === 'off') return {ok: false, reason: 'off', message: '今天放假，不用打卡'};
  const sh = plan.shifts.find(x => x.key === key);
  if (!sh) return {ok: false, reason: 'noShift', message: '这天没有这段班'};
  if (entriesOf(s, date)[0]?.status === 'rest') return {ok: false, reason: 'rest', message: '今天已记为休息', shift: sh};
  if (matchEntry(s, date, sh) >= 0) return {ok: false, reason: 'recorded', message: '这段班已经打过卡了', shift: sh};
  const {startMin, endMin} = shiftWindow(sh), open = Math.max(0, startMin - OPEN_BEFORE_MINUTES);
  if (nowMinutes < open) return {ok: false, reason: 'early', message: `${hm(open)} 之后才能打卡`, shift: sh, opensAt: hm(open)};
  if (nowMinutes > endMin) return {ok: false, reason: 'closed', message: '已过下班时间，可以到日历里补记', shift: sh};
  return {ok: true, reason: null, message: '', shift: sh};
}
/** 在这段班的时间段里打卡（上班前 60 分钟到下班）。 */
export function clockIn(s, date, key, time) {
  if (!validTime(time)) fail('打卡时间须为 HH:MM');
  const st = clockInStatus(s, date, key, timeToMinutes(time)); if (!st.ok) fail(st.message);
  const sh = st.shift;
  return addEntry(s, date, {status: 'work', jobId: sh.jobId, dayUnits: 2, minutes: sh.minutes, overtimeMinutes: 0, clockIn: time, start: sh.start, end: sh.end});
}
/** 撤销这段班的上班记录；如果上面记过加班，加班单独保留下来。 */
export function undoClockIn(s, date, key) {
  const sh = planFor(s, date).shifts.find(x => x.key === key); if (!sh) fail('这天没有这段班');
  const i = matchEntry(s, date, sh); if (i < 0) fail('这段班没有上班记录可以撤销');
  const e = entriesOf(s, date)[i];
  let n = removeEntry(s, date, i);
  if (e.overtimeMinutes > 0) n = addOvertime(n, date, e.jobId, e.overtimeMinutes);
  return n;
}
/** 在日历里补记（或改）某段班：不受打卡时间段限制。 */
export function recordShift(s, date, key, {dayUnits = 2, minutes, overtimeMinutes = 0, clockIn} = {}) {
  const sh = planFor(s, date).shifts.find(x => x.key === key); if (!sh) fail('这天没有这段班');
  const e = {status: 'work', jobId: sh.jobId, dayUnits, minutes: minutes ?? (dayUnits === 1 ? Math.max(1, Math.round(sh.minutes / 2)) : sh.minutes), overtimeMinutes, start: sh.start, end: sh.end, ...(clockIn ? {clockIn} : {})};
  const i = matchEntry(s, date, sh);
  return i >= 0 ? replaceEntry(s, date, i, e) : addEntry(s, date, e);
}
/** 记一段加班。当天这家公司已有上班记录就加在上面；没有（包括休息日）就单独记一条「只加班」。 */
export function addOvertime(s, date, jobId, minutes, {start, end} = {}) {
  if (!int(minutes, 1, 1440)) fail('加班时长须为 1 分钟到 24 小时');
  if (!jobFor(s, jobId)) fail('请选择是哪家公司的加班');
  const list = entriesOf(s, date);
  let i = list.findIndex(e => e.status === 'work' && e.jobId === jobId);
  if (i < 0) i = list.findIndex(e => e.status === 'overtime' && e.jobId === jobId);
  if (i >= 0) return replaceEntry(s, date, i, {...list[i], overtimeMinutes: list[i].overtimeMinutes + minutes});
  const t = {}; if (start !== undefined) t.clockIn = start; if (end !== undefined) t.clockOut = end;
  return addEntry(s, date, {status: 'overtime', jobId, overtimeMinutes: minutes, ...t});
}

/**
 * 跳动收入：某条上班记录从打卡到下班之间，按时间比例算出已经挣到的正班工资（不含加班）。
 * nowSeconds = 从 date 当天 0 点起经过的秒数（跨午夜可超过 86400）。
 * 返回 null 表示没打卡或没有工资规则；否则 { exactCents, cents, totalCents, progress, finished, endsAt }。
 */
export function liveEarnings(s, date, e, nowSeconds) {
  if (e?.status !== 'work' || !e.clockIn) return null;
  const total = entryPay(s, date, {...e, overtimeMinutes: 0}); if (total === null) return null;
  const startSec = timeToMinutes(e.clockIn) * 60;
  let endMin = e.end ? timeToMinutes(e.end) : null;
  if (endMin !== null && endMin * 60 <= startSec) endMin += 1440;
  let endSec = endMin === null ? startSec + e.minutes * 60 : endMin * 60;
  if (endSec <= startSec) endSec = startSec + e.minutes * 60;
  const progress = Math.min(1, Math.max(0, (nowSeconds - startSec) / (endSec - startSec)));
  const exactCents = total * progress;
  return {exactCents, cents: Math.floor(exactCents), totalCents: total, progress, finished: progress >= 1, endsAt: e.end ?? null};
}
