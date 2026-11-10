// 自动打卡：排了班的日子，到了上班时间就自动记成「上班了」；没去（请假）才需要动手取消。
//
// state.settings.autoClock  是否开启（新数据默认开启）
// state.autoSince           从哪天开始自动记（打开开关那天；之前漏记的日子不会被自动补上，仍然提醒你自己核对）
//
// 取消某段班用 skipShift：把这段班从「这一天的安排」里拿掉（单日安排），这样自动打卡不会再把它记回来。
import {addDays, daysBetween, validDate, timeToMinutes} from './dates.js?v=62be305706';
import {planFor, setDayPlan} from './plan.js?v=62be305706';
import {entriesOf, matchEntry, recordShift, removeEntry, addOvertime} from './domain.js?v=62be305706';

const LOOKBACK = 62; // 最多往回补这么多天（比如很久没打开 App）

/**
 * 把从 autoSince 到现在、已经到了上班时间却还没有记录的班，自动记成上班（打卡时间 = 上班时间）。
 * 没有需要记的就原样返回同一个对象，方便调用方判断要不要保存。
 * autoSince 还没设（第一次开启）就从今天开始，并写进数据里。
 */
export function autoRecord(s, today, nowMinutes) {
  if (!s.settings?.autoClock || !validDate(today)) return s;
  let n = s;
  if (!validDate(s.autoSince) || s.autoSince > today) { n = structuredClone(s); n.autoSince = today; }
  let from = n.autoSince;
  if (daysBetween(from, today) > LOOKBACK) from = addDays(today, -LOOKBACK);
  for (let d = from; d <= today; d = addDays(d, 1)) {
    if (entriesOf(n, d)[0]?.status === 'rest') continue;
    for (const sh of planFor(n, d).shifts) {
      if (d === today && nowMinutes < timeToMinutes(sh.start)) continue;
      if (matchEntry(n, d, sh) >= 0) continue;
      n = recordShift(n, d, sh.key, {clockIn: sh.start});
    }
  }
  return n;
}

/** 开关自动打卡。打开时从今天起算（已经设过的保留原来的起始日）。 */
export function setAutoClock(s, on, today) {
  const n = structuredClone(s);
  n.settings.autoClock = !!on;
  if (on && !validDate(n.autoSince)) n.autoSince = today;
  if (!on) n.autoSince = null;
  return n;
}

/**
 * 请假：这一天不上这段班。去掉这段班的上班记录（有加班的话加班保留），并把这段班从这一天的安排里拿掉；
 * 这天一段班都不剩就记成「放假」。只影响这一天。
 */
export function skipShift(s, date, key) {
  const plan = planFor(s, date), sh = plan.shifts.find(x => x.key === key);
  if (!sh) throw new Error('这天没有这段班');
  let n = s;
  const i = matchEntry(n, date, sh);
  if (i >= 0) {
    const e = entriesOf(n, date)[i];
    n = removeEntry(n, date, i);
    if (e.overtimeMinutes > 0) n = addOvertime(n, date, e.jobId, e.overtimeMinutes);
  }
  const rest = plan.shifts.filter(x => x.key !== key).map(({jobId, name, start, end, breakMinutes}) => ({jobId, name, start, end, breakMinutes}));
  return setDayPlan(n, date, rest.length ? {type: 'shifts', shifts: rest} : {type: 'off'});
}

/** 这一整天请假：去掉这天所有排班的上班记录（加班保留），这天记成放假。 */
export function skipDay(s, date) {
  let n = s;
  for (const sh of planFor(s, date).shifts) {
    const i = matchEntry(n, date, sh); if (i < 0) continue;
    const e = entriesOf(n, date)[i];
    n = removeEntry(n, date, i);
    if (e.overtimeMinutes > 0) n = addOvertime(n, date, e.jobId, e.overtimeMinutes);
  }
  return setDayPlan(n, date, {type: 'off'});
}
