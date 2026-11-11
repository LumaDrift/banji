// JSON 导入：选公司 → 选文件 → previewImport 核对 → 用户确认 → applyImport。
// 支持两种内容：
//   1. 旧格式：发薪周期数组 [{type:'calendar', period, start, end, payday}, …]
//   2. 班记导入格式（见 examples/import-template.json）：
//      { "type":"banji-import", "version":1, "paySchedules":[…], "entries":{ "YYYY-MM-DD": 记录 或 [记录, …] } }
// 文件里的发薪周期和记录都归到导入时选的那家公司（记录里写了 jobId 也会被换成选的公司）。
// 规则：确认前不写入；周期重复/重叠整批拒绝；某天已有不同的记录也整批拒绝，绝不覆盖；
//       完全相同的记录视为已存在，跳过不算冲突。

import {validDate} from './dates.js?v=89b9af5a97';
import {validateDay, validateSchedules, importSchedules, jobFor, entriesOf} from './domain.js?v=89b9af5a97';

export const IMPORT_TYPE = 'banji-import';
const fail = m => { throw new Error(m); };
const MAX_TEXT = 5 * 1024 * 1024, MAX_ENTRIES = 5000;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 解析并校验，不修改任何数据。
 * 返回 { jobId, paySchedules, entries, skipped }，entries 只含需要新增的日期，skipped 是已存在且完全相同的日期。
 */
export function previewImport(state, text, jobId) {
  if (!jobFor(state, jobId)) fail('请先选择是哪家公司的数据');
  if (typeof text !== 'string' || !text.trim()) fail('文件是空的');
  if (text.length > MAX_TEXT) fail('文件太大（最多 5 MB）');
  let raw;
  try { raw = JSON.parse(text); } catch { fail('这不是有效的 JSON，请检查括号、引号和逗号'); }

  let schedules = [], entries = {};
  if (Array.isArray(raw)) schedules = raw;
  else if (raw && raw.type === IMPORT_TYPE) {
    if (raw.version !== 1) fail('导入格式版本不支持');
    schedules = raw.paySchedules ?? [];
    entries = raw.entries ?? {};
    if (!Array.isArray(schedules)) fail('paySchedules 必须是数组');
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) fail('entries 必须是「日期: 记录」的对象');
  } else fail('不认识这个文件：请使用班记导入模板，或发薪周期数组');

  const dates = Object.keys(entries);
  if (!schedules.length && !dates.length) fail('文件里没有可以导入的内容');
  if (dates.length > MAX_ENTRIES) fail(`一次最多导入 ${MAX_ENTRIES} 天的记录`);

  const paySchedules = schedules.length ? validateSchedules(schedules, state.schedules, jobId) : [];
  const ids = new Set(state.jobs.map(j => j.id));
  const add = {}, skipped = [], conflicts = [];
  for (const d of dates.sort()) {
    if (!validDate(d)) fail(`日期无效：${d}`);
    const list = (Array.isArray(entries[d]) ? entries[d] : [entries[d]]).map(e => e && e.status !== 'rest' ? {...e, jobId} : e);
    let day;
    try { day = validateDay(list, ids); } catch (err) { fail(`${d} 的记录无效：${err.message}`); }
    const cur = entriesOf(state, d);
    if (!cur.length) add[d] = day;
    else if (same(cur, day)) skipped.push(d);
    else conflicts.push(d);
  }
  if (conflicts.length) fail(`这些日期已经有不同的记录，为了不覆盖原数据，本次没有导入任何内容：${conflicts.slice(0, 10).join('、')}${conflicts.length > 10 ? ` 等 ${conflicts.length} 天` : ''}`);
  return {jobId, paySchedules, entries: add, skipped};
}

/** 用户确认后，把预览结果加入数据，返回新状态（不直接写存储）。会重新校验一次，防止预览后数据有变。 */
export function applyImport(state, preview) {
  let n = preview.paySchedules.length ? importSchedules(state, preview.jobId, preview.paySchedules) : structuredClone(state);
  const ids = new Set(n.jobs.map(j => j.id));
  for (const [d, list] of Object.entries(preview.entries)) {
    if (n.entries[d]) fail(`${d} 在预览之后已经有记录了，请重新预览`);
    n.entries[d] = validateDay(list, ids);
  }
  return n;
}
