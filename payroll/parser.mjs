export const fields = [
  ['month','工资所属月份','month'], ['start','计薪开始日期','date'],
  ['end','计薪结束日期','date'], ['payday','表上发薪日期','date'],
  ['gross','应发金额（元）','number'], ['net','实发金额（元）','number']
];
const aliases = {
  month:'工资所属月份|工资月份|所属月份|薪资月份|工资年月|薪资年月',
  period:'计薪周期|计薪期间|工资周期|工资期间|考勤周期|考勤期间|薪资周期|薪资期间',
  start:'计薪开始日期|计薪起始日期|计薪开始|起薪日期',
  end:'计薪结束日期|计薪截止日期|计薪结束',
  payday:'工资发放日期|工资发放日|发薪日期|发薪日|发放日期|支付日期',
  gross:'应发工资合计|应发合计|应发总额|应发工资|应发金额|税前工资|应发',
  net:'实发工资合计|实发合计|实发总额|实发工资|实发金额|税后工资|实发'
};
const labelSource = Object.values(aliases).join('|');
const labelRE = new RegExp(labelSource, 'g');
const fullDate = /(?<!\d)((?:19|20)\d{2})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?(?!\d)/g;
const dateValue = (y,m,d) => {
  const t = new Date(Date.UTC(+y,+m-1,+d));
  return t.getUTCFullYear()===+y && t.getUTCMonth()===+m-1 && t.getUTCDate()===+d
    ? `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` : '';
};
function dates(s) { return [...s.matchAll(fullDate)].map(m=>dateValue(m[1],m[2],m[3])).filter(Boolean); }
function money(s) {
  const match = s.trim().match(/^[：:\s¥￥人民币CNYRMB]*(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?:\s*元)?\s*$/i);
  return match ? String(Number(match[1].replaceAll(',',''))) : '';
}
function normalize(text) { return text.normalize('NFKC').replace(/\r\n?/g,'\n').replace(/\u00a0/g,' '); }
export function parsePayslip(input) {
  const text=normalize(input), lines=text.split('\n').map(s=>s.trim()).filter(Boolean);
  const raw=Object.fromEntries(Object.keys(aliases).map(k=>[k,[]]));
  const warnings=[];
  let multi=false;
  const add=(key,value,source)=>{ if(value.trim())raw[key].push({value:value.trim(),source}); };
  for(let i=0;i<lines.length;i++) {
    const line=lines[i], cells=line.split(/\t+| {2,}/).map(s=>s.trim()).filter(Boolean);
    // A PDF table with a header row followed by equally aligned data cells.
    const exactKeys=cells.map(c=>Object.keys(aliases).find(k=>new RegExp(`^(?:${aliases[k]})[:：]?$`).test(c)));
    if(cells.length>1 && exactKeys.filter(Boolean).length>=2 && !/[:：]/.test(line)) {
      const rows=[];
      for(let j=i+1;j<lines.length;j++) {
        const row=lines[j].split(/\t+| {2,}/).map(s=>s.trim()).filter(Boolean);
        if(row.length!==cells.length || /合计|总计/.test(row[0]))break;
        if(row.some(c=>new RegExp(`^(?:${labelSource})$`).test(c)))break;
        rows.push(row);
      }
      if(rows.length>1) { multi=true; continue; }
      if(rows.length===1)exactKeys.forEach((key,c)=>{if(key)add(key,rows[0][c],`${line}\n${rows[0].join(' | ')}`);});
      continue;
    }
    const matches=[...line.matchAll(labelRE)];
    for(let n=0;n<matches.length;n++) {
      const m=matches[n];
      // Avoid interpreting a label contained inside another word.
      if(m.index>0 && /[\p{L}]/u.test(line[m.index-1]))continue;
      const key=Object.keys(aliases).find(k=>new RegExp(`^(?:${aliases[k]})$`).test(m[0]));
      let value=line.slice(m.index+m[0].length,matches[n+1]?.index??line.length).replace(/^\s*[:：]?\s*/,'').trim();
      let source=line;
      if(!value && matches.length===1 && lines[i+1] && !new RegExp(labelSource).test(lines[i+1])) { value=lines[i+1]; source+='\n'+value; }
      if(key)add(key,value,source);
    }
  }
  // Repeated personal identifiers indicate a multi-person document.
  if((text.match(/(?:员工姓名|姓名)\s*[:：]/g)||[]).length>1)multi=true;
  const candidates=Object.fromEntries(fields.map(([k])=>[k,[]]));
  const put=(key,value,source)=>{if(value)candidates[key].push({value,source});};
  for(const key of ['start','end','payday'])for(const r of raw[key]) {
    const ds=dates(r.value);
    if(ds.length===1)put(key,ds[0],r.source);
    else warnings.push(`${fields.find(f=>f[0]===key)[1]}没有唯一有效的完整年月日，请手动核对。`);
  }
  for(const r of raw.period) {
    let ds=dates(r.value);
    if(ds.length===1) {
      const m=r.value.match(/(?:至|到|~|—|–|－|\s-\s)\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?\s*$/);
      if(m) {
        const y=ds[0].slice(0,4), d=dateValue(y,m[1],m[2]);
        if(d && d>=ds[0])ds.push(d);
      }
    }
    if(ds.length===2 && ds[0]<=ds[1]) { put('start',ds[0],r.source); put('end',ds[1],r.source); }
    else warnings.push('计薪周期不完整或日期顺序异常，已留空；不会按月份猜测起止日期。');
  }
  for(const r of raw.month) {
    const m=r.value.match(/^((?:19|20)\d{2})\s*[年/.-]\s*(\d{1,2})\s*月?\s*$/);
    if(m && +m[2]>=1 && +m[2]<=12)put('month',`${m[1]}-${m[2].padStart(2,'0')}`,r.source);
  }
  // A title such as “2026年10月工资单” establishes a month, never a period.
  for(const line of lines) {
    const m=line.match(/((?:19|20)\d{2})年\s*(\d{1,2})月\s*(?:工资单|工资表|薪资单)/);
    if(m && +m[2]>=1 && +m[2]<=12)put('month',`${m[1]}-${m[2].padStart(2,'0')}`,line);
  }
  for(const key of ['gross','net'])for(const r of raw[key]) {
    const v=money(r.value);
    if(v!=='')put(key,v,r.source);
    else warnings.push(`${fields.find(f=>f[0]===key)[1]}格式不明确，请手动核对。`);
  }
  const result={};
  for(const [key] of fields) {
    const unique=[...new Set(candidates[key].map(c=>c.value))];
    result[key]={value:!multi&&unique.length===1?unique[0]:'',source:!multi&&unique.length===1?candidates[key][0].source:'',status:!multi&&unique.length===1?'detected':unique.length>1?'conflict':'missing'};
    if(unique.length>1)warnings.push(`${fields.find(f=>f[0]===key)[1]}出现多个不同值，已留空。请先只保留自己的单份工资单。`);
  }
  if(multi)warnings.unshift('检测到多行人员记录或多份工资单，本试用版不会自动选择某个人。请使用自己的单人单月工资单，或在原文里只保留自己的记录后重新识别。');
  if(result.start.value && result.end.value && result.start.value>result.end.value) {
    result.start.value='';result.end.value='';warnings.push('开始日期晚于结束日期，已清空，请核对。');
  }
  return {fields:result,warnings:[...new Set(warnings)],multi};
}

export function textFromItems(items) {
  const rows=[];
  for(const item of items) {
    if(!item.str?.trim())continue;
    const y=item.transform[5],x=item.transform[4];
    let row=rows.find(r=>Math.abs(r.y-y)<2.5);
    if(!row){row={y,items:[]};rows.push(row);}
    row.items.push({x,str:item.str,width:item.width||0});
  }
  return rows.sort((a,b)=>b.y-a.y).map(r=>{
    const cells=r.items.sort((a,b)=>a.x-b.x);
    return cells.map((c,i)=>i ? (c.x-(cells[i-1].x+cells[i-1].width)>9?'\t':'')+c.str:c.str).join('');
  }).join('\n');
}

// Payroll calendar rows are schedules, not multiple employees' pay amounts.
export function parsePayrollCalendar(input) {
  const text=normalize(input);
  if(!(/payroll\s+calendar|发薪日历|發薪日曆/i.test(text) && /pay\s*date|发薪日期|發薪日期/i.test(text)))return null;
  const rows=[],warnings=[];
  const us=/\b(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*((?:19|20)\d{2})\b/g;
  for(const line of text.split('\n')) {
    const n=line.trim().match(/^\|?\s*(\d{1,3})\s+(.*)$/);
    if(!n)continue;
    const matches=[...n[2].matchAll(us)];
    if(!matches.length)continue;
    const ds=matches.map(m=>dateValue(m[3],m[1],m[2]));
    const valid=ds.length===3 && ds.every(Boolean) && ds[0]<=ds[1];
    rows.push({period:Number(n[1]),start:ds[0]||'',end:ds[1]||'',payday:ds[2]||'',source:line.trim(),valid});
    if(!valid)warnings.push(`第 ${n[1]} 期未识别出三个有效日期，请修改后勾选。`);
  }
  const seen=new Set();
  for(let i=0;i<rows.length;i++){
    const r=rows[i];
    if(seen.has(r.period)){r.valid=false;warnings.push(`第 ${r.period} 期重复出现，请核对。`);}
    if(i&&r.period!==rows[i-1].period+1)warnings.push(`第 ${rows[i-1].period} 期之后的期数不连续，请核对原表是否漏行。`);
    if(r.end&&r.payday&&r.payday<r.end)warnings.push(`第 ${r.period} 期发薪日期早于计薪结束日期，请核对。`);
    seen.add(r.period);
  }
  if(!rows.length)warnings.push('检测到发薪日历，但未找到完整行。请检查 OCR 原文，或按“期数 开始日期 结束日期 发薪日期”逐行修正。');
  return {rows,warnings};
}
