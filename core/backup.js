// 完整备份：考勤（banji.attendance.v1）、PDF 工资单（banji-payslips-v1）和个人资料（banji.profile.v1，可选）放进同一个文件。
// 两边仍然分开存储；备份只是把两份一起导出、一起恢复。
// 恢复是用户明确操作：先 parseBackup + describeBackup 给用户看清楚，确认后再 restoreBackup。
// 恢复后请重新创建 LocalRepository 并 load（旧实例记着恢复前的内容，会拒绝保存）。

import {validateState, emptyState} from './domain.js?v=89b9af5a97';
import {STORAGE_KEY} from './storage.js?v=89b9af5a97';
import {PROFILE_KEY, validateProfile} from './profile.js?v=89b9af5a97';

export const PAYSLIP_KEY = 'banji-payslips-v1';
export const BACKUP_FORMAT = 'banji-backup';
const fail = m => { throw new Error(m); };
const MAX_TEXT = 20 * 1024 * 1024;

function validatePayslips(list) {
  if (!Array.isArray(list) || list.some(r => !r || typeof r !== 'object' || Array.isArray(r))) fail('PDF 工资单数据格式无效');
  return structuredClone(list);
}

/** 读出两份数据，生成备份对象。任何一份损坏都会停下并说明，不会导出半份。 */
export function createBackup(storage, now = new Date()) {
  let attendance, payslips;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    attendance = raw === null ? emptyState() : validateState(JSON.parse(raw));
  } catch (e) { fail('考勤数据无法读取，未生成备份：' + e.message); }
  try {
    const raw = storage.getItem(PAYSLIP_KEY);
    payslips = raw === null ? [] : validatePayslips(JSON.parse(raw));
  } catch (e) { fail('PDF 工资单数据无法读取，未生成备份：' + e.message); }
  let profile = null;
  try { const raw = storage.getItem(PROFILE_KEY); profile = raw === null ? null : validateProfile(JSON.parse(raw)); }
  catch { profile = null; } // 资料损坏不影响备份考勤和工资单
  return {format: BACKUP_FORMAT, version: 1, exportedAt: now.toISOString(), attendance, payslips, ...(profile ? {profile} : {})};
}

export const backupText = backup => JSON.stringify(backup, null, 2);
export const backupFileName = (date) => `banji-backup-${date}.json`;

/**
 * 解析备份文件内容。也接受旧版只含考勤的备份（那种情况下 payslips 为 null，表示恢复时不碰 PDF 数据）。
 * 返回 { attendance, payslips, exportedAt }。
 */
export function parseBackup(text) {
  if (typeof text !== 'string' || !text.trim()) fail('备份文件是空的');
  if (text.length > MAX_TEXT) fail('备份文件太大');
  let raw;
  try { raw = JSON.parse(text); } catch { fail('这不是有效的 JSON 备份文件'); }
  if (raw && raw.format === BACKUP_FORMAT) {
    if (raw.version !== 1) fail('备份文件版本不支持');
    return {attendance: validateState(raw.attendance), payslips: validatePayslips(raw.payslips), profile: raw.profile === undefined ? null : validateProfile(raw.profile), exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null};
  }
  return {attendance: validateState(raw), payslips: null, profile: null, exportedAt: null};
}

/** 给用户确认用的一句话摘要数据。 */
export function describeBackup(b) {
  return {
    exportedAt: b.exportedAt,
    jobs: b.attendance.jobs.length,
    entries: Object.keys(b.attendance.entries).length,
    rules: b.attendance.rules.length,
    shiftPlans: b.attendance.shiftPlans.length,
    paySchedules: b.attendance.schedules.length,
    receipts: Object.keys(b.attendance.receipts).length,
    payslips: b.payslips === null ? null : b.payslips.length,
    profile: !!b.profile
  };
}

function put(storage, key, value) {
  if (value === null) { if (typeof storage.removeItem === 'function') storage.removeItem(key); else storage.setItem(key, ''); }
  else storage.setItem(key, value);
}

/**
 * 用备份替换当前数据。两份都写成功才算完成；任何一步失败，两份都退回恢复前的内容。
 * 返回恢复前的原始文本 { attendance, payslips }，可另存以防万一。
 */
export function restoreBackup(storage, parsed) {
  const before = {attendance: storage.getItem(STORAGE_KEY), payslips: storage.getItem(PAYSLIP_KEY), profile: storage.getItem(PROFILE_KEY)};
  const next = {attendance: JSON.stringify(validateState(parsed.attendance)), payslips: parsed.payslips === null ? null : JSON.stringify(validatePayslips(parsed.payslips)), profile: parsed.profile ? JSON.stringify(validateProfile(parsed.profile)) : null};
  try {
    storage.setItem(STORAGE_KEY, next.attendance);
    if (storage.getItem(STORAGE_KEY) !== next.attendance) throw new Error('考勤写入后校验失败');
    if (next.payslips !== null) {
      storage.setItem(PAYSLIP_KEY, next.payslips);
      if (storage.getItem(PAYSLIP_KEY) !== next.payslips) throw new Error('PDF 工资单写入后校验失败');
    }
    if (next.profile !== null) {
      storage.setItem(PROFILE_KEY, next.profile);
      if (storage.getItem(PROFILE_KEY) !== next.profile) throw new Error('个人资料写入后校验失败');
    }
  } catch (e) {
    try { put(storage, STORAGE_KEY, before.attendance); put(storage, PAYSLIP_KEY, before.payslips); put(storage, PROFILE_KEY, before.profile); } catch { /* 尽力回退 */ }
    fail('恢复失败，已退回恢复前的数据：' + e.message);
  }
  return before;
}
