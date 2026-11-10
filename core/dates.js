// Small date/time helpers shared by domain.js and plan.js.
// Dates are ISO strings "YYYY-MM-DD"; times of day are "HH:MM" (24h).

export function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || s < '1900-01-01' || s > '2199-12-31') return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

export function validTime(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

/** "09:30" -> 570 */
export function timeToMinutes(t) {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

/** Length of a shift in minutes; end earlier than start means it runs past midnight. */
export function spanMinutes(start, end) {
  return (timeToMinutes(end) - timeToMinutes(start) + 1440) % 1440;
}

/** 0 = Sunday ... 6 = Saturday, same as the calendar's Sunday-first columns. */
export function weekdayOf(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

const iso = d => d.toISOString().slice(0, 10);

/** "2026-10-28" + 5 -> "2026-11-02" (negative n goes back). */
export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/** Number of days in a month; month is 1–12. */
export function monthLength(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Build a date from parts; day is clamped to the month's last day (31 in February -> 28/29). */
export function makeDate(year, month, day) {
  const m = ((month - 1) % 12 + 12) % 12 + 1, y = year + Math.floor((month - 1) / 12);
  const dd = Math.min(day, monthLength(y, m));
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export const validMonth = s => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) && s >= '1900-01' && s <= '2199-12';
