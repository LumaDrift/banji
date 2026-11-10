// 英文工资单（美国常见写法）的补充识别。原来的识别规则（payroll/parser.mjs）只认中文字段，这里不改它，只在它没找到时补上。
// 日期按美国习惯「月/日/年」读；金额取标签后面的第一个数（工资单上常常「本期」在前、「年度累计」在后）。
const MONTHS = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12};
const iso = (y, m, d) => {
  y = +y; if (y < 100) y += 2000; m = +m; d = +d;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
};
const DATE = String.raw`(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})`;
function toDate(s) {
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/))) return iso(m[3], m[1], m[2]);
  if ((m = s.match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/)) && MONTHS[m[1].toLowerCase()]) return iso(m[3], MONTHS[m[1].toLowerCase()], m[2]);
  return '';
}
const SEP = String.raw`\s*[:#]?\s*`;
const AMOUNT = String.raw`\(?-?\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})`;
export function englishPayslip(input) {
  const text = String(input).normalize('NFKC').replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const found = {start: [], end: [], payday: [], gross: [], net: []};
  const put = (k, v, src) => { if (v) found[k].push({value: v, source: src.trim()}); };
  const all = (re, fn) => { for (const m of text.matchAll(new RegExp(re, 'gi'))) fn(m); };
  // “Pay Period: 10/01/2026 - 10/15/2026”
  all(String.raw`(?:pay(?:roll)?\s+period|period|earnings\s+period)${SEP}(${DATE})\s*(?:-|–|—|to|thru|through)\s*(${DATE})`, m => { const a = toDate(m[1]), b = toDate(m[2]); if (a && b && a <= b) { put('start', a, m[0]); put('end', b, m[0]); } });
  all(String.raw`(?:(?:pay\s+)?period\s+(?:begin(?:ning|s)?|start(?:ing|s)?)(?:\s+date)?|pay\s+begin\s+date|begin\s+date|start\s+date)${SEP}(${DATE})`, m => put('start', toDate(m[1]), m[0]));
  all(String.raw`(?:(?:pay\s+)?period\s+end(?:ing|s)?(?:\s+date)?|pay\s+end\s+date|end\s+date|week\s+ending)${SEP}(${DATE})`, m => put('end', toDate(m[1]), m[0]));
  all(String.raw`(?:pay\s*date|check\s+date|payment\s+date|advice\s+date|deposit\s+date|paid\s+on)${SEP}(${DATE})`, m => put('payday', toDate(m[1]), m[0]));
  all(String.raw`(?:net\s+pay|net\s+check|net\s+amount|take\s*-?\s*home(?:\s+pay)?|total\s+net(?:\s+pay)?)[^\n\d$]{0,24}${AMOUNT}`, m => put('net', String(Number(m[1].replaceAll(',', ''))), m[0]));
  all(String.raw`(?:gross\s+pay|gross\s+earnings|gross\s+wages|total\s+gross|total\s+earnings|gross)[^\n\d$]{0,24}${AMOUNT}`, m => put('gross', String(Number(m[1].replaceAll(',', ''))), m[0]));
  const out = {};
  for (const k of Object.keys(found)) {
    // 金额：同一个标签出现多次时取第一个（本期）；日期：出现不同的值就让人自己填，不猜
    const uniq = [...new Set(found[k].map(c => c.value))];
    const one = (k === 'net' || k === 'gross') ? uniq.slice(0, 1) : uniq;
    if (!found[k].length) continue;
    out[k] = one.length === 1 ? {value: one[0], source: found[k][0].source, status: 'detected'} : {value: '', source: '', status: 'conflict'};
  }
  return out;
}
