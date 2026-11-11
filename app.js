'use strict';
// 班记 App 界面脚本（数据版本 3：可以有几份工作，每段班属于一份工作）。
// - 业务计算全部来自 core/（由 boot.js 放进 window.Banji），这里只负责显示和交互。
// - 日历的年/月/周原生分页、DOM 缓存、rAF 轻量提交、滚动结束后补缓存，原样沿用 ui-preview，
//   只把演示规则换成真实数据（info()），并且绝不在滑动过程中计算业务或重建格子。
// - 整个 App 不用 alert / confirm / prompt / 弹窗 / 抽屉：提示原位显示，需要确认的操作原位二次点击。

const $ = id => document.getElementById(id);
const icon = name => `<svg class="ui-icon" viewBox="0 0 256 256" aria-hidden="true"><use href="assets/icons.svg#${name}"></use></svg>`;
document.querySelectorAll('[data-icon]').forEach(el => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));

let B = null, repo = null, state = null, undoStack = null;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function clock() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).formatToParts(new Date()).map(x => [x.type, x.value]));
  return {date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, seconds: +p.hour * 3600 + +p.minute * 60 + +p.second};
}
let today = clock().date;
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const nowMin = () => Math.floor(clock().seconds / 60);

// ---------- 小工具 ----------
const WEEK = '日一二三四五六';
const wdOf = d => new Date(d + 'T12:00:00Z').getUTCDay();
const dateLabel = d => `${+d.slice(5, 7)}月${+d.slice(8)}日 周${WEEK[wdOf(d)]}`;
const shortDate = d => `${+d.slice(5, 7)}月${+d.slice(8)}日`;
function rangeLabel(p) {
  const a = p.start, b = p.end;
  if (a.slice(0, 7) === b.slice(0, 7)) return `${+a.slice(5, 7)}月${+a.slice(8)}日–${+b.slice(8)}日`;
  return `${shortDate(a)}–${shortDate(b)}`;
}
const money = c => c === null || c === undefined ? '—' : B.formatMoney(c);
const moneyFloor = exact => B.formatMoney(Math.floor(exact));
function dur(min) { const h = Math.floor(min / 60), m = min % 60; return h ? `${h}小时${m ? m + '分' : ''}` : `${m}分钟`; }
const hoursText = min => String(+(min / 60).toFixed(2));
function hoursToMinutes(text, {allowZero = true} = {}) {
  const t = String(text ?? '').trim();
  if (!t) { if (allowZero) return 0; throw new Error('请填写小时数'); }
  const n = B.minutesInput(t);
  if (!allowZero && n === 0) throw new Error('时长要大于 0');
  return n;
}
function say(el, text, kind = '') { el.hidden = !text; el.textContent = text || ''; el.classList.toggle('error', kind === 'error'); }
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el[k] = v; else if (k === 'text') el.textContent = v; else if (k === 'value') el.value = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}
/** 需要确认的按钮：第一次点变成「再点一次确认」，4 秒内再点才执行。 */
function armed(btn, prompt, fn) {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.classList.remove('danger'); fn(); return; }
  btn.dataset.label = btn.textContent; btn.dataset.armed = '1'; btn.textContent = prompt; btn.classList.add('danger');
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; btn.classList.remove('danger'); } }, 4000);
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  const a = h('a', {href: url, download: name}); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function segSet(seg, v) { seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v))); }

// ---------- 工作（公司） ----------
const multiJob = () => state.jobs.length > 1;
const jobName = id => B.jobName(state, id);
function jobOptions(select, value) {
  select.replaceChildren(...state.jobs.map(j => h('option', {value: j.id, text: j.name})));
  if (value && state.jobs.some(j => j.id === value)) select.value = value;
}
const ruleText = r => `${r.mode === 'daily' ? '一天' : '一小时'} ${money(r.rateCents)}${r.overtimeRateCents ? ` · 加班每小时 ${money(r.overtimeRateCents)}` : ''}`;
function cycleText(c) {
  if (!c) return null;
  const wk = c.weekendRule === 'before' ? '，碰上周末提前' : c.weekendRule === 'after' ? '，碰上周末推后' : '';
  if (c.kind === 'monthly') {
    if (c.startDay === 1 && c.payMonthOffset === 1) return `每月 ${c.payDay} 号发上个月的工资${wk}`;
    if (c.startDay === 1 && c.payMonthOffset === 0) return `每月 ${c.payDay} 号发这个月的工资${wk}`;
    return `每月 ${c.startDay} 号起算一期，${['当月', '次月', '再下个月'][c.payMonthOffset]} ${c.payDay} 号发${wk}`;
  }
  return `${c.lengthDays === 14 ? '两周' : '每周'}发一次，每期结束后 ${c.payOffsetDays} 天发${wk}`;
}
const jobSchedules = id => state.schedules.filter(p => p.jobId === id);
const shiftLabel = sh => `${multiJob() ? jobName(sh.jobId) + ' · ' : ''}${sh.name} ${sh.start}–${sh.end}`;

// ---------- 保存与撤销 ----------
/** 计算新状态 → 保存 → 记入撤销 → 刷新界面。出错时原位显示，不改任何数据。 */
function act(note, label, make, okText) {
  let next;
  try { next = make(state); } catch (e) { if (note) say(note, e.message, 'error'); return false; }
  try { next = B.autoRecord(next, today, nowMin()); const prev = state; state = repo.save(next); undoStack.record(prev, label); }
  catch (e) { if (note) say(note, e.message, 'error'); return false; }
  afterChange();
  if (note) say(note, okText || '');
  return true;
}
function undoLast(note) {
  const item = undoStack.undo(); if (!item) return;
  try { state = repo.save(item.state); } catch (e) { undoStack.restore(item); say(note, e.message, 'error'); return; }
  afterChange(); say(note, '已撤销：' + item.label);
}
function reloadFromStorage(message) {
  try { repo = new B.LocalRepository(localStorage); state = repo.load(); $('storage-alert').hidden = true; }
  catch (e) { state = B.emptyState(); showStorageAlert(e.message); }
  try { ({profile, broken: profileBroken} = B.loadProfile(localStorage)); } catch { profile = B.emptyProfile(); }
  undoStack.clear(); runAuto({render: false}); afterChange();
  if (message) { $('storage-alert').hidden = false; $('storage-alert').textContent = message; setTimeout(() => { if ($('storage-alert').textContent === message) $('storage-alert').hidden = true; }, 6000); }
}
function showStorageAlert(msg) { const el = $('storage-alert'); el.hidden = false; el.textContent = msg + ' 可以到「设置 › 备份与恢复」用备份恢复。'; }
// 页面不能放大缩小（iPhone 的 Safari 不认 user-scalable=no，要拦手势）。日历的双指缩放用的是 touch 事件，不受影响。
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, e => e.preventDefault(), {passive: false, capture: true});
document.addEventListener('touchstart', e => { if (e.touches.length > 1) e.preventDefault(); }, {passive: false, capture: true});
document.addEventListener('touchmove', e => { if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault(); }, {passive: false, capture: true});
// 双击放大由 CSS 的 touch-action: manipulation 关掉（不拦 touchend，免得「再点一次确认」点不动）
document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, {passive: false});

// 自动打卡：到了上班时间就把排了班的记成上班（不进撤销列表）。打开 App、每分钟、回到页面时都检查一次。
const autoOn = () => !!state.settings.autoClock;
function runAuto({render = true} = {}) {
  if (!B || !repo) return false;
  let n; try { n = B.autoRecord(state, today, nowMin()); } catch { return false; }
  if (n === state) return false;
  try { state = repo.save(n); } catch { return false; }
  if (render) afterChange();
  return true;
}
function afterChange() {
  dayCache.clear();
  repaintCalendar();
  updateHome();
  if (current !== 'home') renderers[current]?.();
  updateUndoBar();
}

// ---------- 页面切换 ----------
const roots = ['home', 'calendar', 'pay', 'settings']; let current = 'home', activeRoot = 'home', trail = [];
const renderers = {};
function show(id, root, remember = true) {
  if (!$(id)) return;
  if (remember && id !== current) trail.push({id: current, root: activeRoot});
  current = id; if (root) activeRoot = root;
  document.querySelector('.app').classList.toggle('is-home', id === 'home');
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== id; el.classList.remove('enter'); });
  $(id).classList.add('enter');
  document.querySelectorAll('[data-page]').forEach(el => { if (el.dataset.page === activeRoot) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  window.scrollTo({top: 0, behavior: 'instant'});
  if (B) { if (id === 'home') updateHome({roll: true}); else renderers[id]?.(); }
  if (id === 'calendar') requestAnimationFrame(() => renderCalendar());
}
document.querySelectorAll('[data-page]').forEach(el => el.onclick = () => { trail = []; show(el.dataset.page, el.dataset.page, false); });
document.querySelectorAll('[data-open]').forEach(el => el.onclick = () => show(el.dataset.open));
document.querySelectorAll('[data-back]').forEach(el => el.onclick = () => { const prev = trail.pop() || {id: activeRoot, root: activeRoot}; show(prev.id, prev.root, false); });

// ---------- 首页 ----------
// 大数字 = 待发工资：每段上完的班，从下班起匀速流进来，流到那家公司的发薪日正好是这一期的总数，发薪当天定格（core: payFlow）。
// 每次回到首页，数字从 0 滚上来；之后每秒按真实速度往上走。
// 打卡按钮跟着「现在这段班」走：上班前 1 小时到下班之间可以打卡；不在这个时间段就到日历里补记。
let profile = null, profileBroken = false, homeFocusKey = null, homeSig = '';
const nf2 = new Intl.NumberFormat('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const nf4 = new Intl.NumberFormat('zh-CN', {minimumFractionDigits: 4, maximumFractionDigits: 4});
// 首页金额显示几位小数：只是这台设备上的显示偏好，默认 2 位，可在「记录选项」里打开 4 位。
const DISPLAY_KEY = 'banji.display.v1';
let fineDigits = false, showHolidays = true;
try { const d = JSON.parse(localStorage.getItem(DISPLAY_KEY) || '{}'); fineDigits = d.fine4 === true; showHolidays = d.holidays !== false; } catch { fineDigits = false; }
function saveDisplay() {
  try { localStorage.setItem(DISPLAY_KEY, JSON.stringify({fine4: fineDigits, holidays: showHolidays})); say($('opt-note'), '已保存。'); }
  catch { say($('opt-note'), '这台设备不能保存这个设置，刷新后会恢复默认。', 'error'); }
}
const holidayOf = date => showHolidays && B ? B.holidayOn(date) : null;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function odometer(el, text, ms) {
  const shape = text.replace(/\d/g, '0');
  if (el.dataset.shape !== shape) {
    el.replaceChildren(...[...text].map(ch => {
      if (!/\d/.test(ch)) return h('span', {class: 'odo-sep', text: ch});
      return h('span', {class: 'odo-digit'}, h('span', {class: 'odo-strip'}, ...'0123456789'.split('').map(d => h('span', {text: d}))));
    }));
    el.dataset.shape = shape;
  }
  [...el.children].forEach((c, i) => {
    if (!c.classList.contains('odo-digit')) return;
    const strip = c.firstChild; strip.style.transitionDuration = reduceMotion.matches ? '0ms' : ms + 'ms';
    strip.style.transform = `translateY(-${Number(text[i]) * 10}%)`;
  });
}
function setMoney(exactCents, {roll = false} = {}) {
  const c = Math.max(0, exactCents || 0);
  const text = fineDigits ? nf4.format(Math.floor(c * 100) / 10000) : nf2.format(Math.floor(c) / 100);
  $('money-sr').textContent = `$${nf2.format(Math.floor(c) / 100)}`;
  if (roll) { odometer($('money-odo'), text.replace(/\d/g, '0'), 0); requestAnimationFrame(() => requestAnimationFrame(() => odometer($('money-odo'), text, 1300))); }
  else odometer($('money-odo'), text, 600);
}
function greeting() {
  const hr = Math.floor(clock().seconds / 3600);
  const word = hr < 5 ? '夜深了' : hr < 11 ? '早上好' : hr < 13 ? '中午好' : hr < 18 ? '下午好' : '晚上好';
  return profile?.nickname ? `${word}，${profile.nickname}` : word;
}
/** 一条记录今天到现在挣到多少（正在上的班按时间比例算；加班部分一次算上）。 */
function entryNow(date, e, sec) {
  const p = B.entryPay(state, date, e); if (p === null) return {cents: null, live: false};
  const l = date === today && e.status === 'work' ? B.liveEarnings(state, date, e, sec) : null;
  if (l && !l.finished) return {cents: l.exactCents + (p - l.totalCents), live: true};
  return {cents: p, live: false};
}
function todayMoney(sec) {
  let cents = 0, unpriced = 0, any = false, live = false;
  for (const e of B.entriesOf(state, today)) {
    if (e.status === 'rest') continue; any = true;
    const x = entryNow(today, e, sec); if (x.cents === null) { unpriced++; continue; }
    cents += x.cents; live ||= x.live;
  }
  return {any, cents, unpriced, live};
}
function monthEarnedExact(sec) {
  let c = 0;
  for (const [d, list] of Object.entries(state.entries)) {
    if (!d.startsWith(today.slice(0, 7)) || d > today) continue;
    for (const e of list) if (e.status !== 'rest') c += entryNow(d, e, sec).cents || 0;
  }
  return c;
}
/** 今天每段班的情况，以及「现在这段班」（按钮绑定的那段）。 */
function todayShifts() {
  const plan = B.planFor(state, today), m = nowMin(), list = B.entriesOf(state, today);
  const items = plan.shifts.map(sh => { const i = B.matchEntry(state, today, sh); return {sh, st: B.clockInStatus(state, today, sh.key, m), entry: i >= 0 ? list[i] : null, win: B.shiftWindow(sh)}; });
  const focus = items.find(x => x.st.ok) || items.find(x => x.entry && m >= x.win.startMin - B.OPEN_BEFORE_MINUTES && m <= x.win.endMin) || items.find(x => x.st.reason === 'early') || items.at(-1) || null;
  return {plan, items, focus, rest: list[0]?.status === 'rest'};
}
function shiftState(x) {
  if (x.entry) return x.entry.clockIn ? `已打卡 ${x.entry.clockIn}` : '已记上班';
  if (autoOn() && (x.st.ok || x.st.reason === 'early')) return `${x.sh.start} 自动打卡`;
  if (x.st.ok) return '现在可以打卡';
  if (x.st.reason === 'early') return `${x.st.opensAt} 起可打卡`;
  if (x.st.reason === 'closed') return '没打卡 · 去日历补记';
  if (x.st.reason === 'rest') return '已记休息';
  return '';
}
// 首页只显示两个数：大数字是待发工资，下面一行是今天已赚。每秒多少、发薪倒计时都只在后台算，不显示。
function updateMoney({roll = false} = {}) {
  const sec = clock().seconds;
  const flow = state.jobs.length ? B.payFlow(state, today, sec) : null;
  const t = todayMoney(sec), ts = todayShifts();
  // 大数字：待发工资。一段班下完，这段的钱就算挣到了、只是还没发；从下班那一刻起往这里流，流到发薪日正好流完，发薪当天定格。
  let label = '待发工资', value = 0;
  if (flow) { value = flow.flowingCents; if (flow.paidToday.length && !flow.next) label = '今天发薪'; }
  else if (state.rules.length) { label = `本月已赚 · ${+today.slice(5, 7)}月`; value = monthEarnedExact(sec); }
  $('money-label').textContent = label;
  setMoney(value, {roll});
  $('money-card').classList.toggle('flowing', !!flow && flow.centsPerSecond > 0);
  // 下面一行：今天已赚（上班时一秒一秒往上涨），也是滚动数字。
  const tl = ts.plan.kind === 'off' && !t.any ? '今天放假' : ts.rest ? '今天休息' : t.any && !t.live && !ts.items.some(x => !x.entry && x.st.reason !== 'closed') ? '今天挣到' : '今天已赚';
  $('flow-label').textContent = tl;
  const ttext = '$' + nf2.format(Math.floor(Math.max(0, t.cents)) / 100), tel = $('flow-amount');
  tel.setAttribute('aria-label', ttext);
  if (roll) { odometer(tel, ttext.replace(/\d/g, '0'), 0); requestAnimationFrame(() => requestAnimationFrame(() => odometer(tel, ttext, 1300))); }
  else odometer(tel, ttext, 600);
  return ts.items.map(x => (x.st.reason || 'ok') + (x.entry ? 1 : 0)).join() + '|' + t.live;
}
function homeReminders() {
  const items = [];
  const missing = B.missingRecords(state, B.addDays(today, -60), B.addDays(today, -1));
  if (missing.length) items.push({text: `${missing.length} 天排了班还没记录，去补记`, go: () => { pick(missing.at(-1)); trail = []; show('calendar', 'calendar', false); }});
  const due = B.billHistory(state, today, 24).filter(b => b.status === 'due');
  if (due.length) items.push({text: `${due.length} 期工资过了发薪日，还没记实际到账`, go: () => show('history')});
  for (const j of state.jobs) {
    const hasShift = state.shiftPlans.some(p => p.jobId === j.id) || Object.values(state.dayPlans).some(d => d.type === 'shifts' && d.shifts.some(x => x.jobId === j.id));
    if (!B.rulesOf(state, j.id).length) items.push({text: `「${j.name}」还没填工资`, go: () => openJob(j.id, 'rate')});
    else if (!j.payCycle && !jobSchedules(j.id).length) items.push({text: `「${j.name}」还没设发薪日`, go: () => openJob(j.id, 'cycle')});
    else if (!hasShift) items.push({text: `「${j.name}」还没排上班时间`, go: () => openJob(j.id, 'shift')});
  }
  return items;
}
function updateHome({roll = false} = {}) {
  if (!B) return;
  $('home-date').textContent = dateLabel(today);
  $('home-greet').textContent = greeting();
  renderAvatar($('home-avatar'), profile);
  const ts = todayShifts(), f = ts.focus, btn = $('checkin');
  homeFocusKey = f?.sh.key ?? null;
  // 今天的几段班
  $('today-shifts').replaceChildren(...(ts.items.length > 1 || (ts.items.length && multiJob()) ? ts.items.map(x => h('div', {class: 'ts-row' + (x === f ? ' focus' : '') + (x.entry ? ' done' : '')},
    h('span', {class: 'ts-name', text: shiftLabel(x.sh)}), h('span', {class: 'ts-state', text: shiftState(x)}))) : []));
  let label, cls = 'checkin', ic = 'clock', enabled = false, sub = '';
  if (ts.plan.kind === 'off') { label = '今天放假'; cls += ' rest'; sub = '只这一天，之后照常排班'; }
  else if (ts.rest) { label = '今天已记为休息'; cls += ' rest'; }
  else if (!f) {
    label = '今天没有排班'; cls += ' rest';
    sub = !state.jobs.length ? '' : B.entriesOf(state, today).length ? '今天的记录在日历里' : '临时上班可以到日历里点今天补记';
  }
  else if (f.st.ok) { label = '上班打卡'; ic = 'plus'; enabled = true; sub = autoOn() ? `不点也会在 ${f.sh.start} 自动打卡` : shiftLabel(f.sh); }
  else if (f.entry) {
    const all = ts.items.every(x => x.entry);
    label = f.entry.clockIn ? `已上班 · ${f.entry.clockIn} 打卡` : '这段班已记上班'; cls += ' recorded'; ic = 'check';
    sub = all && ts.items.length > 1 ? '今天的班都记好了' : autoOn() && f.entry.clockIn === f.sh.start ? '到点自动打的卡' : shiftLabel(f.sh);
  }
  else if (f.st.reason === 'early') { label = autoOn() ? `${f.sh.start} 自动打卡` : `${f.st.opensAt} 起可以打卡`; cls += ' rest'; sub = autoOn() ? `${shiftLabel(f.sh)} · 请假的话到日历里点今天取消` : shiftLabel(f.sh); }
  else { label = '已过下班时间'; cls += ' rest'; sub = `${shiftLabel(f.sh)} · 可以到日历里补记`; }
  btn.disabled = !enabled; btn.className = cls; $('checkin-label').textContent = label; $('checkin-icon').innerHTML = icon(ic);
  if ($('today-shifts').children.length && !/补记|放假|日历|自动/.test(sub)) sub = '';
  $('checkin-sub').textContent = sub; $('checkin-sub').hidden = !sub;
  $('undo').hidden = !(f?.entry?.clockIn); $('undo').textContent = autoOn() ? '今天没去？点这里请假' : '撤销这次打卡';
  homeSig = updateMoney({roll});
  $('reminders').replaceChildren(...homeReminders().map(it => h('button', {class: 'reminder', type: 'button', onclick: it.go}, h('span', {text: it.text}), h('span', {class: 'reminder-go', 'aria-hidden': 'true', text: '›'}))));
  $('setup-card').hidden = state.jobs.length > 0;
}
$('checkin').onclick = () => { const key = homeFocusKey; if (key) act($('home-note'), '打卡上班', s => B.clockIn(s, today, key, clock().hm), ''); };
$('undo').onclick = () => {
  const key = homeFocusKey; if (!key) return;
  if (autoOn()) armed($('undo'), '再点一次：今天这段班请假', () => act($('home-note'), '今天请假', s => B.skipShift(s, today, key), '已记为请假，这段班今天不算。可以在日历里撤销。'));
  else act($('home-note'), '撤销打卡', s => B.undoClockIn(s, today, key), '已撤销这次打卡。');
};
let autoMinute = -1;
setInterval(() => {
  if (!B) return;
  const c = clock();
  if (c.date !== today) { today = c.date; dayCache.clear(); runAuto({render: false}); repaintCalendar(); updateHome({roll: true}); return; }
  if (c.seconds % 60 === 0 || autoMinute !== Math.floor(c.seconds / 60)) { autoMinute = Math.floor(c.seconds / 60); if (runAuto()) return; }
  if (current !== 'home' || document.hidden) return;
  const sig = updateMoney();
  if (sig !== homeSig) updateHome();
}, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && B) { const c = clock(); if (c.date !== today) { today = c.date; dayCache.clear(); repaintCalendar(); } runAuto(); if (current === 'home') updateHome({roll: true}); } });

// ---------- 头像 ----------
const AVATAR_BG = {mint: '#cff3e3', sky: '#d6e9fb', peach: '#ffe1d2', lemon: '#fff1b0', lilac: '#e6dcfa', sand: '#efe4d3'};
const ANIMAL_NAMES = {cat: '小猫', dog: '小狗', rabbit: '兔子', bear: '小熊', panda: '熊猫', fox: '狐狸', frog: '青蛙', chick: '小鸡'};
const EYES = '<circle cx="40" cy="54" r="4" fill="#26312c"/><circle cx="60" cy="54" r="4" fill="#26312c"/>';
const CHEEKS = '<circle cx="31" cy="63" r="5" fill="#ff9d8a" opacity=".45"/><circle cx="69" cy="63" r="5" fill="#ff9d8a" opacity=".45"/>';
const SMILE = '<path d="M45 66 q5 4 10 0" stroke="#26312c" stroke-width="2.4" fill="none" stroke-linecap="round"/>';
const ANIMAL_ART = {
  cat: `<path d="M24 36 L30 14 L44 28 Z M76 36 L70 14 L56 28 Z" fill="#f2a65a"/><circle cx="50" cy="56" r="28" fill="#f2a65a"/>${EYES}<path d="M47 61 h6 l-3 3 z" fill="#d9605a"/>${SMILE}<path d="M20 60 h12 M20 66 h12 M68 60 h12 M68 66 h12" stroke="#b9773b" stroke-width="1.6" stroke-linecap="round"/>`,
  dog: `<circle cx="50" cy="55" r="28" fill="#d9a066"/><ellipse cx="25" cy="48" rx="9" ry="17" fill="#8b5a3c" transform="rotate(18 25 48)"/><ellipse cx="75" cy="48" rx="9" ry="17" fill="#8b5a3c" transform="rotate(-18 75 48)"/><ellipse cx="50" cy="66" rx="13" ry="10" fill="#f3d7b6"/>${EYES}<ellipse cx="50" cy="61" rx="4.5" ry="3.2" fill="#26312c"/>${SMILE}`,
  rabbit: `<ellipse cx="38" cy="22" rx="7" ry="18" fill="#fff"/><ellipse cx="62" cy="22" rx="7" ry="18" fill="#fff"/><ellipse cx="38" cy="23" rx="3" ry="12" fill="#ffc9d3"/><ellipse cx="62" cy="23" rx="3" ry="12" fill="#ffc9d3"/><circle cx="50" cy="58" r="26" fill="#fff"/>${EYES}${CHEEKS}<path d="M47 61 h6 l-3 3 z" fill="#e57b8c"/>${SMILE}`,
  bear: `<circle cx="28" cy="32" r="10" fill="#a47148"/><circle cx="72" cy="32" r="10" fill="#a47148"/><circle cx="50" cy="56" r="28" fill="#a47148"/><ellipse cx="50" cy="66" rx="13" ry="10" fill="#d9b48f"/>${EYES}<ellipse cx="50" cy="61" rx="4.5" ry="3.2" fill="#26312c"/>${SMILE}`,
  panda: `<circle cx="28" cy="32" r="10" fill="#26312c"/><circle cx="72" cy="32" r="10" fill="#26312c"/><circle cx="50" cy="56" r="28" fill="#fff"/><ellipse cx="39" cy="53" rx="7" ry="9" fill="#26312c" transform="rotate(-20 39 53)"/><ellipse cx="61" cy="53" rx="7" ry="9" fill="#26312c" transform="rotate(20 61 53)"/><circle cx="40" cy="53" r="2.6" fill="#fff"/><circle cx="60" cy="53" r="2.6" fill="#fff"/><ellipse cx="50" cy="63" rx="4" ry="2.8" fill="#26312c"/>${SMILE}`,
  fox: `<path d="M22 40 L28 12 L46 30 Z M78 40 L72 12 L54 30 Z" fill="#ee7a3a"/><path d="M50 30 C70 30 80 44 78 58 C70 74 58 80 50 82 C42 80 30 74 22 58 C20 44 30 30 50 30 Z" fill="#ee7a3a"/><path d="M50 82 C42 80 30 74 24 60 C34 64 44 62 50 70 C56 62 66 64 76 60 C70 74 58 80 50 82 Z" fill="#fff"/>${EYES}<ellipse cx="50" cy="70" rx="3.6" ry="2.6" fill="#26312c"/>`,
  frog: `<circle cx="34" cy="34" r="12" fill="#7cc56f"/><circle cx="66" cy="34" r="12" fill="#7cc56f"/><ellipse cx="50" cy="60" rx="31" ry="25" fill="#7cc56f"/><circle cx="34" cy="34" r="7" fill="#fff"/><circle cx="66" cy="34" r="7" fill="#fff"/><circle cx="35" cy="35" r="3.6" fill="#26312c"/><circle cx="65" cy="35" r="3.6" fill="#26312c"/>${CHEEKS}<path d="M38 64 q12 9 24 0" stroke="#26312c" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
  chick: `<path d="M50 22 q-4 -8 2 -10 q-1 6 4 8 z" fill="#f6b73c"/><circle cx="50" cy="56" r="30" fill="#ffd54a"/>${EYES}${CHEEKS}<path d="M44 62 L56 62 L50 70 Z" fill="#f28c28"/>`
};
function avatarSVG(animal) { return `<svg viewBox="0 0 100 100" aria-hidden="true">${ANIMAL_ART[animal] || ANIMAL_ART.cat}</svg>`; }
function renderAvatar(el, p) {
  const a = p?.avatar || {kind: 'animal', animal: 'cat', color: 'mint'};
  if (a.kind === 'image') { el.style.background = 'var(--card)'; el.replaceChildren(h('img', {src: a.dataUrl, alt: ''})); }
  else { el.style.background = AVATAR_BG[a.color] || AVATAR_BG.mint; el.innerHTML = avatarSVG(a.animal); }
}

// ---------- 日历（分页机制沿用 ui-preview） ----------
const dateKey = d => d.toISOString().slice(0, 10);
const dateObject = key => new Date(key + 'T12:00:00Z');
const addDays = (key, days) => { const d = dateObject(key); d.setUTCDate(d.getUTCDate() + days); return dateKey(d); };
const weekStart = key => addDays(key, -dateObject(key).getUTCDay());
let year = +today.slice(0, 4), month = +today.slice(5, 7), selected = today, calendarMode = 'month';
// selected：翻页时的定位日期（不高亮）；picked：你亲手点过的那一天（只有它高亮，下面显示当天详情）。
let picked = null;
function setSelected(key) { selected = key; year = +key.slice(0, 4); month = +key.slice(5, 7); }
function pick(key) { setSelected(key); picked = key; }
// 按月缓存每天的数据；数据变了整体清空，再按需重算（不在滑动中进行）。
const dayCache = new Map();
function info(date) {
  const m = date.slice(0, 7); let c = dayCache.get(m);
  if (!c) { c = new Map(); if (B) for (const d of B.monthDays(state, m, today)) c.set(d.date, d); dayCache.set(m, c); }
  return c.get(date) || {date, plan: {kind: 'none', source: null}, shifts: [], entries: [], pay: 0, unpriced: 0, worked: false, overtime: false, rest: false, isPayday: false, paydays: [], missing: false};
}
function cellText(d) {
  const n = d.shifts.length, done = d.shifts.filter(x => x.entry).length;
  if (d.plan.kind === 'off' && !d.entries.length) return '放假';
  if (d.isPayday) return '发薪';
  if (d.rest) return '休息';
  if (d.worked) {
    if (n > 1 && done < n) return `${done}/${n}`;
    const w = d.entries.filter(e => e.status === 'work');
    return w.length === 1 && w[0].dayUnits === 1 ? '半天' : '已上班';
  }
  if (d.overtime) return '加班';
  if (d.missing) return '漏记';
  const hol = holidayOf(d.date); if (hol) return hol.short;
  if (n === 1) return [...d.shifts[0].name].slice(0, 3).join('');
  if (n > 1) return `${n}段班`;
  return '';
}
function paintCalendarDate(b, date, displayMonth) {
  const d = info(date);
  const wd = wdOf(date), hol = holidayOf(date);
  b.className = (wd === 0 || wd === 6 ? 'weekend ' : '') + (hol ? 'holiday ' : '') + (d.shifts.length ? 'planned ' : '') + (d.worked ? 'worked ' : '') + (d.overtime ? 'extra ' : '') + (d.plan.kind === 'off' ? 'off ' : '') + (d.missing ? 'missing ' : '') + (d.rest ? 'rest ' : '') + (date === today ? 'today ' : '') + (date === picked ? 'selected ' : '') + (d.isPayday ? 'pay ' : '') + (+date.slice(5, 7) !== displayMonth ? 'other-month' : '');
  const text = cellText(d);
  const label = `${date} ${text || '没有排班'}${d.isPayday && text !== '发薪' ? ' 发薪日' : ''}${hol && text !== hol.short ? ' ' + hol.name : ''}`;
  if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
  b.setAttribute('aria-pressed', String(date === picked));
  if (date === today) b.setAttribute('aria-current', 'date'); else b.removeAttribute('aria-current');
  if (b.lastElementChild.textContent !== text) b.lastElementChild.textContent = text;
}
function repaintCalendar() {
  for (const mode of ['month', 'week']) for (const panel of pagers[mode].cache.values()) panel.querySelectorAll('[data-date]').forEach(b => paintCalendarDate(b, b.dataset.date, +b.dataset.date.slice(5, 7)));
  if (current === 'calendar' && calendarMode !== 'year') renderCalendarDetails();
}
function calendarDateButton(date, displayMonth) {
  const b = document.createElement('button'); b.type = 'button'; b.dataset.date = date;
  const number = document.createElement('span'), label = document.createElement('small'); number.textContent = +date.slice(8); b.append(number, label);
  paintCalendarDate(b, date, displayMonth);
  b.onclick = () => { pick(date); renderCalendar(); };
  b.onkeydown = e => {
    const steps = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7};
    if (!(e.key in steps)) return; e.preventDefault(); pick(addDays(date, steps[e.key])); renderCalendar(); document.querySelector(`#dates [data-date="${selected}"]`)?.focus({preventScroll: true});
  }; return b;
}
const monthKey = (y = year, m = month) => `${y}-${String(m).padStart(2, '0')}`;
function shiftMonthKey(key, step) { const d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5) - 1 + step, 1)); return monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1); }
function buildMonthPanel(key) {
  const grid = document.createElement('div'); grid.className = 'date-grid'; grid.dataset.month = key;
  const y = +key.slice(0, 4), m = +key.slice(5), offset = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let i = 0; i < offset; i++) grid.append(document.createElement('span'));
  for (let day = 1; day <= days; day++) grid.append(calendarDateButton(key + '-' + String(day).padStart(2, '0'), m));
  while (grid.children.length < 42) grid.append(document.createElement('span')); return grid;
}
function buildWeekPanel(key) {
  const grid = document.createElement('div'); grid.className = 'date-grid'; grid.dataset.week = key;
  for (let i = 0; i < 7; i++) { const date = addDays(key, i); grid.append(calendarDateButton(date, +date.slice(5, 7))); } return grid;
}
function refreshVisibleSelection() {
  const root = $('calendar');
  root.querySelectorAll('button.selected').forEach(b => { if (b.dataset.date !== picked) { b.classList.remove('selected'); b.setAttribute('aria-pressed', 'false'); } });
  const active = $('dates'), b = picked ? active?.querySelector(`button[data-date="${picked}"]`) : null;
  if (b) { b.classList.add('selected'); b.setAttribute('aria-pressed', 'true'); }
  const yearGrid = $('year-grid');
  if (yearGrid) yearGrid.querySelectorAll('[data-year-month]').forEach(button => button.classList.toggle('chosen-month', selected.startsWith(yearGrid.dataset.year + '-' + String(button.dataset.yearMonth).padStart(2, '0'))));
}
function renderRangeSummary() {
  const week = calendarMode === 'week';
  const start = week ? weekStart(selected) : `${monthKey()}-01`;
  const end = week ? addDays(start, 6) : `${monthKey()}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
  let planned = 0, missing = 0; const paydays = [];
  for (let d = start; d <= end; d = addDays(d, 1)) { const x = info(d); if (x.shifts.length) planned++; if (x.missing) missing++; for (const p of x.paydays) paydays.push({date: d, ...p}); }
  const sum = B.summarize(state, start, end);
  $('selected-date').textContent = week ? `${shortDate(start)} – ${shortDate(end)}` : `${year} 年 ${month} 月`;
  $('shift-title').textContent = week ? '这一周' : '这个月';
  $('shift-badge').hidden = !missing; $('shift-badge').textContent = `漏记 ${missing} 天`; $('shift-badge').className = 'badge warn';
  $('day-shifts').replaceChildren();
  $('dt-plan').textContent = '排班'; $('day-plan').textContent = planned ? `有班 ${planned} 天` : '没有排班';
  $('dt-actual').textContent = '实际'; $('day-actual').textContent = `上班 ${sum.days} 天${sum.overtimeMinutes ? ` · 加班 ${dur(sum.overtimeMinutes)}` : ''}`;
  $('dt-pay').textContent = '预计工资'; $('day-pay').textContent = state.rules.length ? money(sum.cents) : '—';
  const pn = $('day-payday'); pn.hidden = !paydays.length;
  if (paydays.length) pn.textContent = paydays.map(x => `${shortDate(x.date)}${multiJob() ? ' ' + x.jobName : ''} 发 ${rangeLabel(x.period)} 的工资`).join('；');
  const hols = []; for (let d = start; d <= end; d = addDays(d, 1)) { const h0 = holidayOf(d); if (h0) hols.push(`${shortDate(d)} ${h0.name}`); }
  $('day-holiday').hidden = !hols.length; $('day-holiday').textContent = hols.join('；');
  for (const id of ['leave', 'day-add-open', 'day-add']) $(id).hidden = true;
  $('day-hint').hidden = false;
  say($('day-note'), '');
}
const entryText = e => e.status === 'overtime' ? `只加班 ${dur(e.overtimeMinutes)}${e.clockIn ? `（${e.clockIn}${e.clockOut ? '–' + e.clockOut : ''}）` : ''}` : `${e.dayUnits === 1 ? '半天' : '已上班'}${e.clockIn ? ` · ${e.clockIn} 打卡` : ''}${e.overtimeMinutes ? ` · 加班 ${dur(e.overtimeMinutes)}` : ''}`;
function dayRow(title, status, actions) {
  return h('div', {class: 'ds-row'}, h('div', {class: 'ds-main'}, h('strong', {text: title}), h('span', {text: status})), actions.length ? h('div', {class: 'ds-actions'}, ...actions) : null);
}
const smallBtn = (text, onclick, strong) => h('button', {class: 'soft-button' + (strong ? ' strong' : ''), type: 'button', text, onclick});
function renderCalendarDetails() {
  if (!B) return;
  if (!picked) { renderRangeSummary(); return; }
  const date = selected, note = $('day-note');
  $('day-hint').hidden = true; $('shift-badge').hidden = false; $('day-add-open').hidden = false; syncDayAdd(date0());
  $('dt-plan').textContent = '排班'; $('dt-actual').textContent = '实际'; $('dt-pay').textContent = '当天工资';
  const d = info(date), off = d.plan.kind === 'off', n = d.shifts.length, done = d.shifts.filter(x => x.entry).length;
  $('selected-date').textContent = dateLabel(date) + (date === today ? ' · 今天' : '');
  $('shift-title').textContent = off ? '这天放假' : n ? d.shifts.map(x => x.name).join(' + ') : d.rest ? '休息' : d.entries.length ? '临时记录' : '没有排班';
  $('day-plan').textContent = off ? '放假（只这一天）' : n ? `${n} 段班${d.plan.source === 'day' ? '（只这一天）' : ''}` : '没有排班';
  const works = d.entries.filter(e => e.status === 'work').length, ot = d.entries.reduce((a, e) => a + (e.overtimeMinutes || 0), 0);
  $('day-actual').textContent = d.rest ? '休息' : d.entries.length ? `${works ? `上班 ${works} 段` : '没上班'}${ot ? ` · 加班 ${dur(ot)}` : ''}` : d.missing ? '排了班，还没记录' : date > today ? '还没到' : '没有记录';
  $('day-pay').textContent = d.entries.length && !d.rest ? (d.unpriced && !d.pay ? '还没填工资' : money(d.pay) + (d.unpriced ? `（${d.unpriced} 条没填工资）` : '')) : '—';
  const badge = $('shift-badge');
  badge.textContent = off ? '仅这一天' : d.rest ? '休息' : d.missing ? '漏记' : n && done === n ? '已记录' : n ? (date === today && !autoOn() ? '待打卡' : '有班') : d.entries.length ? '有记录' : '没有排班';
  badge.className = 'badge' + (d.missing ? ' warn' : '');
  // 每段班，以及没对上班次的其它记录
  const rows = [], used = new Set();
  for (const x of d.shifts) {
    if (x.entry) used.add(x.entryIndex);
    const status = (multiJob() ? x.jobName + ' · ' : '') + (x.entry ? entryText(x.entry) : d.rest ? '休息' : autoOn() && (date > today || (date === today && nowMin() < toMin(x.start))) ? `${x.start} 自动打卡` : date > today ? '还没到' : date === today ? '还没打卡' : '没记录');
    const actions = [];
    const due = date < today || (date === today && nowMin() >= toMin(x.start));
    if (!x.entry && !d.rest && date <= today && (!autoOn() || !due || (state.autoSince && date < state.autoSince))) {
      if (date === today && B.clockInStatus(state, date, x.key, nowMin()).ok) actions.push(smallBtn('打卡', () => act(note, '打卡上班', s => B.clockIn(s, date, x.key, clock().hm), '已打卡。'), true));
      else if (date < today || due) actions.push(smallBtn('补记上班', () => act(note, `补记 ${shortDate(date)} ${x.name}`, s => B.recordShift(s, date, x.key), `已补记 ${x.name}。`), true));
    }
    if (autoOn() && !d.rest && (x.entry || date >= today)) actions.push(smallBtn('请假', e => armed(e.currentTarget, '再点一次请假', () => act(note, `${shortDate(date)} ${x.name} 请假`, s => B.skipShift(s, date, x.key), `已记为请假：${shortDate(date)} ${x.name} 不算上班。`))));
    else if (x.entry) actions.push(smallBtn('清除', e => armed(e.currentTarget, '再点一次清除', () => act(note, `清除 ${shortDate(date)} ${x.name}`, s => B.removeEntry(s, date, x.entryIndex), '已清除，可以在下面撤销。'))));
    rows.push(dayRow(`${x.name} ${x.start}–${x.end}`, status, actions));
  }
  d.entries.forEach((e, i) => {
    if (used.has(i) || e.status === 'rest') return;
    const title = e.status === 'overtime' ? '加班' : e.start ? `上班 ${e.start}–${e.end}` : '上班';
    rows.push(dayRow(title, (multiJob() || !n ? jobName(e.jobId) + ' · ' : '') + entryText(e) + (e.status === 'work' ? ` · 正班 ${dur(e.minutes)}` : ''),
      [smallBtn('清除', ev => armed(ev.currentTarget, '再点一次清除', () => act(note, `清除 ${shortDate(date)} 的一条记录`, s => B.removeEntry(s, date, i), '已清除，可以在下面撤销。')))]));
  });
  if (d.rest) rows.push(dayRow('记为休息', '这天不算上班和加班', [smallBtn('清除', ev => armed(ev.currentTarget, '再点一次清除', () => act(note, `清除 ${shortDate(date)} 的休息`, s => B.setEntries(s, date, null), '已清除。')))]));
  $('day-shifts').replaceChildren(...rows);
  const hol = holidayOf(date); $('day-holiday').hidden = !hol; if (hol) $('day-holiday').textContent = hol.observed ? `${hol.name}：联邦机构这天放假` : `美国法定节日：${hol.name}`;
  const pn = $('day-payday'); pn.hidden = !d.isPayday;
  if (d.isPayday) pn.textContent = '这天发薪：' + d.paydays.map(p => `${multiJob() ? p.jobName + ' ' : ''}发 ${rangeLabel(p.period)} 的工资`).join('；');
  const leave = $('leave'), dayOff = state.dayPlans[date]?.type === 'off';
  leave.hidden = !(dayOff || n); leave.textContent = dayOff ? '恢复排班' : '这天放假';
  say(note, '');
}
$('leave').onclick = () => { const date = selected, off = state.dayPlans[date]?.type === 'off'; act($('day-note'), off ? `恢复 ${shortDate(date)} 排班` : `${shortDate(date)} 放假`, s => off ? B.setDayPlan(s, date, null) : B.skipDay(s, date), off ? '已恢复这天的排班。' + (autoOn() && date <= today ? '已经到点的班会自动记成上班。' : '') : '这天设为放假，只影响这一天。'); };
$('day-more').onclick = () => { dayEditDate = selected; show('day'); };
// 「＋ 加一条」：就地展开，记加班或者改这一天的班；换一天就自动收起
let dayAddFor = null;
const date0 = () => selected;
// 常用班次：每周重复的班次 + 以前单独排过的班，去重。加班的时候点一下就套用，不用再输时间。
function shiftTemplates() {
  const out = new Map(), ok = new Set(state.jobs.map(j => j.id));
  const add = x => { if (!ok.has(x.jobId) || !x.start || !x.end) return; const k = `${x.jobId}|${x.start}|${x.end}|${x.breakMinutes || 0}`; if (!out.has(k)) out.set(k, {jobId: x.jobId, name: x.name || '班', start: x.start, end: x.end, breakMinutes: x.breakMinutes || 0}); };
  for (const p of state.shiftPlans) add(p);
  for (const d of Object.keys(state.dayPlans).sort().reverse()) if (state.dayPlans[d].type === 'shifts') state.dayPlans[d].shifts.forEach(add);
  return [...out.values()].slice(0, 8);
}
const tplLabel = t => `${state.jobs.length > 1 ? jobName(t.jobId) + ' · ' : ''}${t.name} ${t.start}–${t.end}`;
/** 给某天加一段常用班：这天的安排 = 原来的班 + 这一段；已经到点（过去的日子，或今天已过上班时间）就同时记成上班。 */
function addTemplateShift(date, t) {
  const now = B.planFor(state, date).shifts;
  if (now.some(x => x.jobId === t.jobId && x.start === t.start)) { say($('day-note'), `${shortDate(date)} 已经有 ${tplLabel(t)} 这段班了。`, 'error'); return; }
  const due = date < today || (date === today && nowMin() >= toMin(t.start));
  const shifts = [...now.map(({jobId, name, start, end, breakMinutes}) => ({jobId, name, start, end, breakMinutes})), {...t}];
  if (act($('day-note'), `${shortDate(date)} 加 ${t.name}`, s => {
    let n = B.setDayPlan(s, date, {type: 'shifts', shifts});
    if (due && !B.entriesOf(n, date).some(e => e.status === 'rest')) n = B.recordShift(n, date, `${t.jobId}@${t.start}`);
    return n;
  }, `已给 ${shortDate(date)} 加上 ${tplLabel(t)}${due ? '，记成上班了' : ''}。只影响这一天。`)) { dayAddFor = null; syncDayAdd(date); }
}
function tplButtons(onPick) {
  return shiftTemplates().map(t => h('button', {class: 'tpl-chip', type: 'button', onclick: () => onPick(t)}, h('b', {text: '＋ ' + t.name}), h('span', {text: `${state.jobs.length > 1 ? jobName(t.jobId) + ' · ' : ''}${t.start}–${t.end}`})));
}
function syncDayAdd(date) {
  const open = dayAddFor === date;
  $('day-add').hidden = !open; $('day-add-open').setAttribute('aria-expanded', String(open)); $('day-add-open').textContent = open ? '收起' : '＋ 加一条';
  if (!open) { dayAddFor = null; return; }
  jobOptions($('da-job'), $('da-job').value || info(date).shifts[0]?.jobId || state.jobs[0]?.id); $('da-job-field').hidden = state.jobs.length < 2;
  $('da-ot').hidden = !state.jobs.length;
  const tpl = tplButtons(t => addTemplateShift(date, t));
  $('da-tpl').hidden = !tpl.length;
  $('da-tpl').replaceChildren(...(tpl.length ? [h('p', {class: 'da-title', text: '加一段班（点一下套用）'}), h('div', {class: 'tpl-list'}, ...tpl)] : []));
  requestAnimationFrame(() => $('day-add').scrollIntoView({block: 'nearest'}));
}
$('day-add-open').onclick = () => { dayAddFor = dayAddFor === selected ? null : selected; syncDayAdd(selected); };
$('da-ot').onsubmit = ev => {
  ev.preventDefault();
  const date = selected, jobId = $('da-job').value;
  if (act($('day-note'), `记 ${shortDate(date)} 加班`, s => B.addOvertime(s, date, jobId, hoursToMinutes($('da-hours').value, {allowZero: false}), {}), `已记下 ${shortDate(date)} 的加班。`)) { $('da-hours').value = ''; dayAddFor = null; syncDayAdd(date); }
};
function updateUndoBar() { const bar = $('undo-bar'); bar.hidden = !undoStack?.canUndo; if (undoStack?.canUndo) bar.textContent = `撤销上一步：${undoStack.nextLabel}`; }
$('undo-bar').onclick = () => undoLast($('day-note'));

function updateCalendarLabels() {
  const annual = calendarMode === 'year', week = calendarMode === 'week';
  const t = $('month-title'), html = annual ? `<b>${year}年</b>` : `<b>${month}月</b><span>${year}年</span>`;
  if (t.innerHTML !== html) t.innerHTML = html;
  const start = weekStart(selected);
  $('calendar-range').textContent = week ? `${shortDate(start)} – ${shortDate(addDays(start, 6))}` : '';
  refreshVisibleSelection(); if (!annual) renderCalendarDetails();
}
function renderCalendar() {
  const annual = calendarMode === 'year', week = calendarMode === 'week';
  $('calendar-card').classList.toggle('year-view', annual); $('calendar').classList.toggle('year-active', annual);
  $('year-overview').hidden = !annual;
  document.querySelector('#calendar-card .weekdays').hidden = annual; $('date-viewport').hidden = annual;
  document.querySelector('#calendar-card .legend').hidden = annual; $('calendar-grip').hidden = annual; $('day-card').hidden = annual; $('undo-bar').classList.toggle('in-year', annual);
  for (const mode of ['year', 'month', 'week']) { $('mode-' + mode).setAttribute('aria-pressed', String(calendarMode === mode)); pagers[mode].element.hidden = calendarMode !== mode; }
  $('calendar-grip').setAttribute('aria-expanded', String(!week)); $('grip-label').textContent = week ? '下拉展开月历' : '上滑收起月历';
  const key = annual ? String(year) : week ? weekStart(selected) : monthKey(); pagers[calendarMode].show(key);
  fitViewport(); updateCalendarLabels();
}
/** 月历只露出这个月实际有的几周（4–6 行），周历一行。只在翻页停下后调整，滑动中不动。 */
function fitViewport() {
  if (calendarMode === 'year' || !$('dates')) return;
  let rows = 1;
  if (calendarMode === 'month') rows = Math.ceil((new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + new Date(Date.UTC(year, month, 0)).getUTCDate()) / 7);
  const size = parseFloat(getComputedStyle($('calendar-card')).getPropertyValue('--day-size')) || 54;
  const gap = parseFloat(getComputedStyle($('dates')).rowGap) || 0;
  const px = `${rows * size + (rows - 1) * gap}px`;
  if ($('date-viewport').style.height !== px) $('date-viewport').style.height = px;
}
function gentleZoom(element) { if (!matchMedia('(prefers-reduced-motion: reduce)').matches) element.animate([{opacity: .4, transform: 'scale(.96)'}, {opacity: 1, transform: 'scale(1)'}], {duration: 220, easing: 'ease-out'}); }
function openMonth(m, targetMode = 'month') {
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  setSelected(`${year}-${String(m).padStart(2, '0')}-${String(Math.min(+selected.slice(8), last)).padStart(2, '0')}`);
  picked = null; calendarMode = targetMode; renderCalendar(); gentleZoom($('date-viewport'));
}
function buildYearPanel(key) {
  const displayYear = +key;
  const grid = document.createElement('div'); grid.className = 'year-grid'; grid.dataset.year = key;
  for (let m = 1; m <= 12; m++) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'mini-month'; b.dataset.yearMonth = m;
    const prefix = `${displayYear}-${String(m).padStart(2, '0')}`;
    b.classList.toggle('chosen-month', selected.startsWith(prefix));
    b.setAttribute('aria-label', `${displayYear} 年 ${m} 月，点击展开`);
    b.classList.toggle('this-month', today.startsWith(prefix));
    b.innerHTML = `<span class="mini-heading">${m}月</span>`;
    const dates = document.createElement('span'); dates.className = 'mini-dates'; dates.setAttribute('aria-hidden', 'true');
    const offset = new Date(Date.UTC(displayYear, m - 1, 1)).getUTCDay(), count = new Date(Date.UTC(displayYear, m, 0)).getUTCDate();
    for (let i = 0; i < 42; i++) {
      const span = document.createElement('span'), day = i - offset + 1;
      if (day > 0 && day <= count) {
        const date = prefix + '-' + String(day).padStart(2, '0'); span.textContent = day; span.dataset.miniDate = date;
        if (date === today) span.classList.add('mini-today');
        if (date === picked) span.classList.add('mini-selected');
        if (holidayOf(date)) span.classList.add('mini-holiday');
        const wd = (offset + day - 1) % 7; if (wd === 0 || wd === 6) span.classList.add('mini-weekend');
      } dates.append(span);
    }
    b.append(dates); b.onclick = () => { year = displayYear; openMonth(m); }; grid.append(b);
  }
  return grid;
}
function setCalendarMode(mode) {
  if (calendarMode === mode) return;
  if (calendarMode === 'year' && mode !== 'year') { openMonth(month, mode); return; }
  calendarMode = mode; renderCalendar();
  if (mode === 'year') gentleZoom($('year-grid'));
}
function moveCalendar(step) {
  if (calendarMode === 'year') { year += step; renderCalendar(); return; }
  picked = null;
  if (calendarMode === 'week') setSelected(addDays(selected, step * 7));
  else {
    const d = new Date(Date.UTC(year, month - 1 + step, 1));
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    setSelected(`${y}-${String(m).padStart(2, '0')}-${String(Math.min(+selected.slice(8), last)).padStart(2, '0')}`);
  }
  renderCalendar();
}
$('calendar-today').onclick = () => { pick(today); renderCalendar(); };
$('mode-year').onclick = () => setCalendarMode('year');
$('month-title').onclick = () => setCalendarMode('year');
$('mode-month').onclick = () => setCalendarMode('month');
$('mode-week').onclick = () => setCalendarMode('week');
const grip = $('calendar-grip'); let gripY = null, ignoreGripClick = false;
grip.onclick = () => { if (ignoreGripClick) { ignoreGripClick = false; return; } setCalendarMode(calendarMode === 'month' ? 'week' : 'month'); };
grip.onpointerdown = e => { gripY = e.clientY; ignoreGripClick = false; grip.setPointerCapture(e.pointerId); };
grip.onpointermove = e => { if (gripY !== null && Math.abs(e.clientY - gripY) > 8) grip.classList.add('dragging'); };
grip.onpointerup = e => {
  if (gripY !== null) { const dy = e.clientY - gripY; if (Math.abs(dy) > 23) { ignoreGripClick = true; setCalendarMode(dy < 0 ? 'week' : 'month'); } }
  gripY = null; grip.classList.remove('dragging');
};
grip.onpointercancel = () => { gripY = null; grip.classList.remove('dragging'); };
// A shared cached native pager serves month, week, and year; no full redraw on swipes.
class CalendarPager {
  constructor(mode, id, {build, shift, radius = 4, buffer = 3, max = 33}) {
    Object.assign(this, {mode, element: $(id), build, shift, radius, buffer, max});
    this.cache = new Map(); this.active = null; this.width = 0; this.reset = false; this.contact = false; this.frame = null; this.timer = null; this.token = 0; this.anchor = selected; this.scrolling = false; this.hasScrollEnd = 'onscrollend' in this.element;
    this.element.addEventListener('scroll', () => {
      if (this.reset) return; this.scrolling = true;
      if (this.frame === null) this.frame = requestAnimationFrame(() => { this.frame = null; this.commit(); });
      this.scheduleBuffer();
    }, {passive: true});
    this.element.addEventListener('scrollend', () => { this.scrolling = false; this.extend(); }, {passive: true});
    this.element.addEventListener('touchstart', () => { this.contact = true; this.anchor = selected; clearTimeout(this.timer); }, {passive: true});
    for (const type of ['touchend', 'touchcancel']) this.element.addEventListener(type, e => { this.contact = e.touches.length > 0; this.scheduleBuffer(); }, {passive: true});
  }
  make(key) {
    const panel = this.build(key); panel.classList.add('calendar-page'); panel.dataset.pageKey = key; panel.setAttribute('role', 'group'); panel.setAttribute('aria-hidden', 'true');
    panel.querySelectorAll('button').forEach(b => b.tabIndex = -1); this.cache.set(key, panel); return panel;
  }
  activate(panel) {
    const id = this.mode === 'year' ? 'year-grid' : 'dates';
    if (this.active === panel && panel.id === id) return;
    if (this.active) { this.active.removeAttribute('id'); this.active.setAttribute('aria-hidden', 'true'); this.active.querySelectorAll('button').forEach(b => b.tabIndex = -1); }
    const prior = document.getElementById(id); if (prior && prior !== panel) prior.removeAttribute('id');
    this.active = panel; panel.id = id; panel.setAttribute('aria-hidden', 'false'); panel.querySelectorAll('button').forEach(b => b.tabIndex = 0);
  }
  show(key) {
    clearTimeout(this.timer);
    if (!this.cache.has(key)) {
      this.cache.clear(); this.active = null; const batch = document.createDocumentFragment();
      for (let step = -this.radius; step <= this.radius; step++) batch.append(this.make(this.shift(key, step)));
      this.element.replaceChildren(batch);
    }
    this.activate(this.cache.get(key)); this.anchor = selected;
    const width = this.element.clientWidth; if (!width) return;
    this.width = width; const index = [...this.element.children].indexOf(this.active); this.rebase(index * width);
  }
  rebase(left) {
    const token = ++this.token; this.reset = true; this.element.style.scrollSnapType = 'none'; this.element.scrollLeft = left;
    requestAnimationFrame(() => { if (token === this.token) { this.element.style.scrollSnapType = ''; this.reset = false; } });
  }
  commit() {
    if (this.reset || calendarMode !== this.mode || $('calendar').hidden || !this.width) return;
    const panel = this.element.children[Math.round(this.element.scrollLeft / this.width)];
    if (!panel || panel === this.active) return;
    const key = panel.dataset.pageKey;
    if (this.mode === 'month') {
      const y = +key.slice(0, 4), m = +key.slice(5), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      setSelected(key + '-' + String(Math.min(+this.anchor.slice(8), last)).padStart(2, '0'));
    } else if (this.mode === 'week') setSelected(addDays(key, dateObject(this.anchor).getUTCDay()));
    else year = +key;
    picked = null;
    this.activate(panel); updateCalendarLabels();
  }
  scheduleBuffer() { clearTimeout(this.timer); this.timer = setTimeout(() => this.extend(), this.hasScrollEnd ? 100 : 180); }
  extend() {
    if (this.contact || this.reset || (this.hasScrollEnd && this.scrolling) || calendarMode !== this.mode || $('calendar').hidden) return;
    this.commit(); if (this.mode === 'month') fitViewport(); const panels = [...this.element.children], index = panels.indexOf(this.active); if (index < 0) return;
    const before = Math.max(0, this.buffer - index), after = Math.max(0, this.buffer - (panels.length - index - 1));
    if (after) { const batch = document.createDocumentFragment(), last = panels.at(-1).dataset.pageKey; for (let i = 1; i <= after; i++) batch.append(this.make(this.shift(last, i))); this.element.append(batch); }
    if (before) {
      const batch = document.createDocumentFragment(), first = panels[0].dataset.pageKey; for (let i = before; i >= 1; i--) batch.append(this.make(this.shift(first, -i)));
      const left = this.element.scrollLeft; this.element.style.scrollSnapType = 'none'; this.element.prepend(batch); this.rebase(left + before * this.width);
    }
    if (this.element.children.length > this.max) {
      const list = [...this.element.children], at = list.indexOf(this.active), keep = Math.floor((this.max - 1) / 2), n = Math.max(0, at - keep), tail = Math.max(0, list.length - at - keep - 1);
      if (n || tail) {
        const left = this.element.scrollLeft; this.element.style.scrollSnapType = 'none';
        for (const panel of [...list.slice(0, n), ...(tail ? list.slice(-tail) : [])]) { this.cache.delete(panel.dataset.pageKey); panel.remove(); }
        this.rebase(left - n * this.width);
      }
    }
  }
}
const pagers = {
  month: new CalendarPager('month', 'month-pager', {build: buildMonthPanel, shift: shiftMonthKey}),
  week: new CalendarPager('week', 'week-pager', {build: buildWeekPanel, shift: (key, step) => addDays(key, step * 7)}),
  year: new CalendarPager('year', 'year-pager', {build: buildYearPanel, shift: (key, step) => String(+key + step), radius: 2, buffer: 2, max: 9})
};
let pinchingPager = null;
const gestureSurface = $('calendar-card'); let gesture = null;
const distance = touches => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
gestureSurface.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    const x = (e.touches[0].clientX + e.touches[1].clientX) / 2, y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const mini = document.elementFromPoint(x, y)?.closest('[data-year-month]');
    pinchingPager = pagers[calendarMode].element; pinchingPager.style.overflowX = 'hidden';
    gesture = {pinch: distance(e.touches), changed: false, mode: calendarMode, month: mini ? +mini.dataset.yearMonth : null};
  } else gesture = e.touches.length === 1 ? {x: e.touches[0].clientX, y: e.touches[0].clientY, paged: !!e.target.closest('.calendar-pager')} : null;
}, {passive: true});
gestureSurface.addEventListener('touchmove', e => {
  if (!gesture) return;
  if (e.touches.length === 2 && gesture.pinch) {
    if (e.cancelable) e.preventDefault();
    if (gesture.changed) return;
    const ratio = distance(e.touches) / gesture.pinch;
    if (ratio < .78) { gesture.changed = true; setCalendarMode(gesture.mode === 'week' ? 'month' : 'year'); }
    else if (ratio > 1.22) {
      gesture.changed = true;
      if (gesture.mode === 'year' && gesture.month) openMonth(gesture.month);
      else setCalendarMode(gesture.mode === 'year' ? 'month' : 'week');
    }
  } else if (e.touches.length === 1 && gesture.x !== undefined && !gesture.paged) {
    const dx = e.touches[0].clientX - gesture.x, dy = e.touches[0].clientY - gesture.y;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3 && e.cancelable) e.preventDefault();
  }
}, {passive: false});
gestureSurface.addEventListener('touchend', e => {
  if (!gesture) return;
  if (gesture.x !== undefined && !gesture.paged && e.changedTouches.length) {
    const dx = e.changedTouches[0].clientX - gesture.x, dy = e.changedTouches[0].clientY - gesture.y;
    if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.3) { if (e.cancelable) e.preventDefault(); moveCalendar(dx < 0 ? 1 : -1); }
  }
  if (gesture.pinch && e.cancelable) e.preventDefault();
  if (pinchingPager) pinchingPager.style.overflowX = ''; pinchingPager = null; gesture = null;
}, {passive: false});
gestureSurface.addEventListener('touchcancel', () => { if (pinchingPager) pinchingPager.style.overflowX = ''; pinchingPager = null; gesture = null; }, {passive: true});
window.addEventListener('resize', () => { const pager = pagers[calendarMode], width = pager.element.clientWidth; if (width && Math.abs(width - pager.width) > .5 && current === 'calendar') renderCalendar(); });

// ---------- 调整某一天（排班 + 实际） ----------
// 排班三选一：按重复班次 / 放假 / 单独排几段班（每段选公司）。实际：每段班选「没去 / 上班 / 半天」，
// 没对上任何一段班的记录（比如只加班）列在下面，默认保留。
let dayEditDate = today, dePlan = 'repeat', deRows = [], deVals = {}, deKeep = {};
const deList = () => B.entriesOf(state, dayEditDate);
function repeatShifts(date) { const dp = {...state.dayPlans}; delete dp[date]; return B.planFor({...state, dayPlans: dp}, date).shifts; }
function withMin(r) { const span = B.spanMinutes(r.start, r.end); return {...r, minutes: span - (r.breakMinutes || 0), key: `${r.jobId}@${r.start}`}; }
function deShifts() {
  if (dePlan === 'off') return [];
  if (dePlan === 'repeat') return repeatShifts(dayEditDate);
  return deRows.filter(r => r.jobId && r.start && r.end && r.start !== r.end).map(withMin);
}
function matchIn(list, shifts, sh, taken) {
  let i = list.findIndex((e, k) => !taken.has(k) && e.status === 'work' && e.jobId === sh.jobId && e.start === sh.start);
  if (i < 0 && shifts.filter(x => x.jobId === sh.jobId).length === 1) i = list.findIndex((e, k) => !taken.has(k) && e.status === 'work' && e.jobId === sh.jobId && !e.start);
  return i;
}
function deMatches() {
  const list = deList(), shifts = deShifts(), taken = new Set(), map = new Map();
  for (const sh of shifts) { const i = matchIn(list, shifts, sh, taken); if (i >= 0) { taken.add(i); map.set(sh.key, i); } }
  return {list, shifts, map, others: list.map((e, i) => [e, i]).filter(([e, i]) => e.status !== 'rest' && !taken.has(i))};
}
function renderPlanRows() {
  const box = $('de-shift-rows'); box.hidden = dePlan !== 'shifts'; $('de-add-shift').hidden = dePlan !== 'shifts' || deRows.length >= 6;
  const tpl = dePlan === 'shifts' && deRows.length < 6 ? tplButtons(t => {
    if (deRows.some(r => r.jobId === t.jobId && r.start === t.start)) { say($('de-note'), '这段班已经在上面了。', 'error'); return; }
    const blank = deRows.length === 1 && deRows[0].name === '临时上班' && deRows[0].start === '09:00' && deRows[0].end === '18:00';
    if (blank) deRows.length = 0;
    deRows.push({...t}); say($('de-note'), ''); renderPlanRows(); renderEntryRows();
  }) : [];
  $('de-tpl').hidden = !tpl.length;
  $('de-tpl').replaceChildren(...(tpl.length ? [h('p', {class: 'form-label', text: '套用常用班次'}), h('div', {class: 'tpl-list'}, ...tpl)] : []));
  if (dePlan !== 'shifts') { box.replaceChildren(); return; }
  box.replaceChildren(...deRows.map((r, i) => {
    const sel = h('select', {onchange: e => { r.jobId = e.target.value; renderEntryRows(); }}); jobOptions(sel, r.jobId);
    const inp = (k, type, extra = {}) => h('input', {type, value: String(r[k] ?? ''), oninput: e => { r[k] = type === 'time' ? e.target.value : e.target.value; }, onchange: () => renderEntryRows(), ...extra});
    return h('div', {class: 'de-shift'},
      h('div', {class: 'de-shift-top'}, h('span', {class: 'form-label', text: `第 ${i + 1} 段`}), deRows.length > 1 ? h('button', {class: 'text-link', type: 'button', text: '删掉这段', onclick: () => { deRows.splice(i, 1); renderPlanRows(); renderEntryRows(); }}) : null),
      h('label', {class: 'field'}, h('span', {text: '哪份工作'}), sel),
      h('label', {class: 'field'}, h('span', {text: '班次名称'}), inp('name', 'text', {maxlength: '20'})),
      h('div', {class: 'time-row'}, h('label', {class: 'time-part'}, h('span', {text: '上班'}), inp('start', 'time')), h('span', {text: '—'}), h('label', {class: 'time-part'}, h('span', {text: '下班'}), inp('end', 'time'))),
      h('label', {class: 'field'}, h('span', {text: '中间休息（分钟）'}), h('input', {inputmode: 'numeric', value: String(r.breakMinutes ?? 0), oninput: e => { r.breakMinutes = Number(e.target.value || 0); }, onchange: () => renderEntryRows()})));
  }));
}
function renderEntryRows() {
  const rest = $('de-rest').checked, {list, shifts, map, others} = deMatches(), box = $('de-entry-rows');
  if (rest) { box.replaceChildren(h('p', {class: 'field-hint', text: '记了休息，这天的上班和加班记录都会去掉。'})); return; }
  const rows = shifts.map(sh => {
    if (!deVals[sh.key]) {
      const e = map.has(sh.key) ? list[map.get(sh.key)] : null;
      deVals[sh.key] = {status: e ? (e.dayUnits === 1 ? 'half' : 'work') : 'none', hours: e ? hoursText(e.minutes) : '', ot: e?.overtimeMinutes ? hoursText(e.overtimeMinutes) : '', clockIn: e?.clockIn || ''};
    }
    const v = deVals[sh.key];
    const opts = [['none', '没去'], ['work', '上班'], ...(state.settings.halfDay || v.status === 'half' ? [['half', '半天']] : [])];
    const seg = h('div', {class: 'segment'}, ...opts.map(([k, t]) => h('button', {type: 'button', 'data-v': k, 'aria-pressed': String(v.status === k), text: t, onclick: () => { v.status = k; renderEntryRows(); }})));
    const on = v.status !== 'none';
    return h('div', {class: 'de-entry'},
      h('p', {class: 'de-entry-title', text: shiftLabel(sh)}), seg,
      on && state.settings.customHours ? h('label', {class: 'field'}, h('span', {text: `正班小时（不填按 ${hoursText(v.status === 'half' ? Math.max(1, Math.round(sh.minutes / 2)) : sh.minutes)} 小时）`}), h('input', {inputmode: 'decimal', value: v.hours, oninput: e => { v.hours = e.target.value; }})) : null,
      on && (state.settings.overtime || v.ot) ? h('label', {class: 'field'}, h('span', {text: '加班小时（没有就空着）'}), h('input', {inputmode: 'decimal', value: v.ot, oninput: e => { v.ot = e.target.value; }})) : null,
      on ? h('label', {class: 'field'}, h('span', {text: '打卡时间（选填）'}), h('input', {type: 'time', value: v.clockIn, oninput: e => { v.clockIn = e.target.value; }})) : null);
  });
  if (!shifts.length) rows.push(h('p', {class: 'field-hint', text: dePlan === 'off' ? '这天放假，没有班要记。' : '这天没有班。需要临时上班，就选「单独排班」加一段。'}));
  if (others.length) {
    rows.push(h('p', {class: 'form-label', text: '其它记录（没对上上面的班）'}));
    for (const [e, i] of others) {
      if (deKeep[i] === undefined) deKeep[i] = true;
      rows.push(h('label', {class: 'switch-row'}, h('span', {}, `${jobName(e.jobId)} · ${entryText(e)}`, h('small', {text: '勾上就保留这条记录'})), h('input', {type: 'checkbox', checked: deKeep[i], onchange: ev => { deKeep[i] = ev.target.checked; }})));
    }
  }
  box.replaceChildren(...rows);
}
function deSyncPlan() {
  segSet($('de-plan-seg'), dePlan);
  const rp = repeatShifts(dayEditDate);
  $('de-repeat-hint').textContent = dePlan === 'repeat' ? (rp.length ? '按重复班次：' + rp.map(shiftLabel).join('；') : '按重复班次：这天没有排班') : dePlan === 'off' ? '这天放假，只影响这一天。' : '只给这一天排班，可以排几段、选不同公司。';
  renderPlanRows(); renderEntryRows();
}
renderers.day = () => {
  const date = dayEditDate, dp = state.dayPlans[date];
  $('dayedit-title').textContent = '调整 ' + dateLabel(date);
  dePlan = dp?.type === 'off' ? 'off' : dp?.type === 'shifts' ? 'shifts' : 'repeat';
  const rp = repeatShifts(date);
  const first = state.jobs[0]?.id || '';
  deRows = (dp?.type === 'shifts' ? dp.shifts : rp.length ? rp : [{jobId: first, name: '临时上班', start: '09:00', end: '18:00', breakMinutes: 0}]).map(x => ({jobId: x.jobId, name: x.name, start: x.start, end: x.end, breakMinutes: x.breakMinutes ?? 0}));
  deVals = {}; deKeep = {};
  $('de-rest').checked = deList()[0]?.status === 'rest';
  say($('de-note'), state.jobs.length ? '' : '还没有工作。先到「设置 › 我的工作」添加。', state.jobs.length ? '' : 'error');
  deSyncPlan();
};
$('de-plan-seg').onclick = e => { const b = e.target.closest('button'); if (!b) return; dePlan = b.dataset.v; deSyncPlan(); };
$('de-add-shift').onclick = () => { const last = deRows.at(-1); deRows.push({jobId: last?.jobId || state.jobs[0]?.id || '', name: '临时上班', start: last?.end || '18:00', end: '22:00', breakMinutes: 0}); renderPlanRows(); renderEntryRows(); };
$('de-rest').onchange = () => renderEntryRows();
$('dayedit-form').onsubmit = ev => {
  ev.preventDefault();
  const date = dayEditDate;
  act($('de-note'), `调整 ${shortDate(date)}`, s => {
    let plan = null;
    if (dePlan === 'off') plan = {type: 'off'};
    if (dePlan === 'shifts') plan = {type: 'shifts', shifts: deRows.map(r => ({jobId: r.jobId, name: r.name, start: r.start, end: r.end, breakMinutes: Number(r.breakMinutes || 0)}))};
    const n = B.setDayPlan(s, date, plan);
    if ($('de-rest').checked) return B.setEntries(n, date, [{status: 'rest'}]);
    const {shifts, others} = deMatches(), list = [];
    for (const sh of shifts) {
      const v = deVals[sh.key]; if (!v || v.status === 'none') continue;
      const half = v.status === 'half';
      let minutes = half ? Math.max(1, Math.round(sh.minutes / 2)) : sh.minutes;
      if (state.settings.customHours && v.hours.trim()) minutes = hoursToMinutes(v.hours, {allowZero: false});
      list.push({status: 'work', jobId: sh.jobId, dayUnits: half ? 1 : 2, minutes, overtimeMinutes: hoursToMinutes(v.ot), start: sh.start, end: sh.end, ...(v.clockIn ? {clockIn: v.clockIn} : {})});
    }
    for (const [e, i] of others) if (deKeep[i] !== false) list.push(e);
    let out = B.setEntries(n, date, list.length ? list : null);
    // 自动打卡开着时，到点了却选「没上班」= 这段班请假，不然会被自动记回来
    if (state.settings.autoClock) for (const sh of shifts) {
      const v = deVals[sh.key], due = date < today || (date === today && nowMin() >= toMin(sh.start));
      if (due && (!v || v.status === 'none') && (!state.autoSince || date >= state.autoSince)) out = B.skipShift(out, date, sh.key);
    }
    return out;
  }, '已保存这一天。');
};

// ---------- 我的工作 ----------
// 一份工作 = 一张卡：工资、发薪日、几点上班（班次）都在卡里。加新工作走「添加工作」，一步一步问完。
const weekText = ds => ds.length === 7 ? '每天' : ds.join(',') === '1,2,3,4,5' ? '每周一到五' : '每周' + ds.map(d => WEEK[d]).join('、');
function weekButtons(box, on = [1, 2, 3, 4, 5]) {
  box.replaceChildren(...[...WEEK].map((d, i) => h('button', {type: 'button', 'aria-label': '每周' + d, 'aria-pressed': String(on.includes(i)), 'data-wd': String(i), onclick: e => e.currentTarget.setAttribute('aria-pressed', String(e.currentTarget.getAttribute('aria-pressed') !== 'true')), text: d})));
}
const pickedDays = box => [...box.querySelectorAll('[aria-pressed=true]')].map(b => +b.dataset.wd);
const liveShifts = id => state.shiftPlans.filter(p => p.jobId === id && (!p.until || p.until >= today));
const shiftSummary = p => `${p.name} ${p.start}–${p.end} · ${weekText(p.weekdays)}`;
function jobSummary(j) {
  const r = B.ruleFor(state, today, j.id) || B.rulesOf(state, j.id).at(-1), c = cycleText(j.payCycle), sch = jobSchedules(j.id).length, sh = liveShifts(j.id);
  return {
    rate: r ? ruleText(r) : null,
    cycle: c || (sch ? `已导入 ${sch} 期发薪周期` : null),
    shift: sh.length ? sh.map(shiftSummary).join('；') : null
  };
}

let jobEditId = null, openSecs = new Set();
function openJob(id, sec) { if (id !== jobEditId) resetImport(); jobEditId = id; editingRule = null; editingPlan = null; sfOpen = false; openSecs = new Set(sec ? [sec] : []); show('job'); }
renderers.jobs = () => {
  const list = $('job-list'); list.replaceChildren();
  if (!state.jobs.length) list.append(h('p', {class: 'empty-copy', text: '还没有工作。点下面「添加工作」，一步一步填好就行。'}));
  for (const j of state.jobs) {
    const s = jobSummary(j);
    const line = (label, v, missing) => h('span', {class: 'job-line' + (v ? '' : ' warn-text')}, h('b', {text: label}), v || missing);
    list.append(h('button', {class: 'item-card job-card', type: 'button', onclick: () => openJob(j.id)},
      h('div', {class: 'item-main'}, h('strong', {text: j.name}),
        line('工资', s.rate, '还没填'), line('发薪', s.cycle, '还没设'), line('上班', s.shift, '还没排')),
      h('span', {class: 'job-go', text: '›'})));
  }
};

// 添加工作：名字 → 工资 → 发薪日 → 几点上班。2–4 步可以跳过；最后一次性保存（可以撤销）。
let njStep = 1, njSkip = {};
const NJ_STEPS = 4;
function njRule() {
  return {effective: today.slice(0, 7) + '-01', mode: njMode, rateCents: B.moneyInput($('nj-rate').value.trim()), overtimeRateCents: B.moneyInput(($('nj-ot').value || '0').trim()), defaultMinutes: hoursToMinutes($('nj-hours').value, {allowZero: false})};
}
function njShift() {
  const days = pickedDays($('nj-days')); if (!days.length) throw new Error('请选每周哪几天上班');
  return {name: $('nj-sname').value.trim() || '上班', start: $('nj-start').value, end: $('nj-end').value, breakMinutes: Number($('nj-break').value || 0), weekdays: days, from: today, until: null};
}
/** 按已经填的内容拼出新数据（不保存）。upTo：只检查到第几步。 */
function njBuild(s, upTo = NJ_STEPS) {
  const name = $('nj-name').value.trim(); if (!name) throw new Error('先给这份工作起个名字');
  let n = B.addJob(s, {name}); const id = n.jobs.at(-1).id;
  if (upTo >= 2 && !njSkip[2]) { if (!$('nj-rate').value.trim()) throw new Error('填一下工资，不知道的话点下面「先跳过」'); n = B.addRule(n, {...njRule(), jobId: id}); }
  if (upTo >= 3 && !njSkip[3]) { const c = readCycle(); if (c) n = B.setPayCycle(n, id, c); }
  if (upTo >= 4 && !njSkip[4]) n = B.addShiftPlan(n, {...njShift(), jobId: id});
  return {n, id, name};
}
let njMode = 'daily';
function njSetMode(v) { njMode = v; segSet($('nj-mode'), v); $('nj-rate-label').textContent = v === 'hourly' ? '一小时多少钱（美元）' : '一天多少钱（美元）'; }
$('nj-mode').onclick = e => { const b = e.target.closest('button'); if (b) njSetMode(b.dataset.v); };
function njShow() {
  document.querySelectorAll('#newjob [data-step]').forEach(el => { el.hidden = +el.dataset.step !== njStep; });
  $('nj-progress').textContent = `第 ${njStep} 步，共 ${NJ_STEPS} 步`;
  [...$('nj-dots').children].forEach((d, i) => d.className = i + 1 < njStep ? 'done' : i + 1 === njStep ? 'now' : '');
  $('nj-prev').hidden = njStep === 1; $('nj-skip').hidden = njStep === 1;
  $('nj-next').textContent = njStep === NJ_STEPS ? '完成' : '下一步';
  say($('nj-note'), '');
  if (njStep === 1) setTimeout(() => $('nj-name').focus({preventScroll: true}), 50);
}
function njGo(skip) {
  njSkip[njStep] = !!skip;
  if (!skip) { try { njBuild(state, njStep); } catch (e) { say($('nj-note'), e.message, 'error'); return; } }
  if (njStep < NJ_STEPS) { njStep++; njShow(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
  let built;
  try { built = njBuild(state); } catch (e) { say($('nj-note'), e.message, 'error'); return; }
  if (!act($('nj-note'), `添加工作 ${built.name}`, () => built.n, '')) return;
  jobEditId = built.id; editingRule = null; editingPlan = null; openSecs = new Set();
  show('job', null, false);
  const missing = [njSkip[2] && '工资', (njSkip[3] || !B.jobFor(state, built.id).payCycle) && '发薪日', njSkip[4] && '上班时间'].filter(Boolean);
  say($('job-note'), `已添加「${built.name}」。` + (missing.length ? `${missing.join('、')}还没填，点下面那一项就能补上。` : '日历已经排好班了。'));
}
$('nj-next').onclick = () => njGo(false);
$('nj-skip').onclick = () => njGo(true);
$('nj-prev').onclick = () => { if (njStep > 1) { njStep--; njShow(); } };
$('nj-name').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); njGo(false); } };
renderers.newjob = () => {
  if (current !== 'newjob' || njFresh) return;
  njFresh = true; jobEditId = null; njStep = 1; njSkip = {};
  for (const [id, v] of [['nj-name', ''], ['nj-rate', ''], ['nj-ot', ''], ['nj-hours', '8'], ['nj-start', '09:00'], ['nj-end', '17:00'], ['nj-break', '0'], ['nj-sname', '']]) $(id).value = v;
  njSetMode('daily'); weekButtons($('nj-days'));
  $('nj-rate-hint').textContent = `从 ${+today.slice(5, 7)}月1日 起按这个算。以后涨薪，到工作卡里加一条就行。`;
  $('nj-cycle-slot').append($('cycle-fields')); $('cycle-fields').classList.add('in-wizard');
  fillCycleForm({kind: 'monthly', startDay: 1, payMonthOffset: 1, payDay: 10, weekendRule: 'none'});
  njShow();
};
let njFresh = false;
document.querySelectorAll('[data-open=newjob]').forEach(el => el.addEventListener('click', () => { njFresh = false; renderers.newjob(); }, true));

// 班次（在工作卡里）
let editingPlan = null;
const repeat = $('repeat-days'); weekButtons(repeat);
let sfOpen = false;
function syncShiftForm() { const has = state.shiftPlans.some(p => p.jobId === jobEditId); $('shift-form').hidden = has && !sfOpen && !editingPlan; $('sf-open').hidden = !$('shift-form').hidden; }
$('sf-open').onclick = () => { sfOpen = true; $('sf-cancel').hidden = false; say($('sf-note'), ''); syncShiftForm(); $('sf-name').focus(); };
function resetShiftForm() {
  sfOpen = false; editingPlan = null; $('shift-form-title').textContent = liveShifts(jobEditId).length ? '再加一个班次' : '平时几点上班？'; $('sf-submit').textContent = '保存班次'; $('sf-cancel').hidden = true;
  $('sf-name').value = ''; $('sf-start').value = '09:00'; $('sf-end').value = '17:00'; $('sf-break').value = '0'; $('sf-from').value = today;
  weekButtons(repeat); syncShiftForm();
}
function renderJobShifts() {
  const list = $('shift-list'); list.replaceChildren();
  for (const p of state.shiftPlans.filter(x => x.jobId === jobEditId)) {
    const ended = p.until && p.until < today;
    const note = h('p', {class: 'inline-state', hidden: true});
    list.append(h('div', {class: 'item-card' + (ended ? ' muted' : '')},
      h('div', {class: 'item-main'}, h('strong', {text: `${p.name} ${p.start}–${p.end}`}), h('span', {text: `${weekText(p.weekdays)} · ${p.from.replaceAll('-', '/')} 起${p.until ? ` · 到 ${p.until.replaceAll('-', '/')}` : ''}${p.breakMinutes ? ` · 休息 ${p.breakMinutes} 分钟` : ''}`})),
      h('div', {class: 'item-actions'},
        h('button', {class: 'soft-button', type: 'button', text: '修改', onclick: () => fillShiftForm(p)}),
        ended ? null : h('button', {class: 'soft-button', type: 'button', text: '从今天起不再排', onclick: e => armed(e.currentTarget, '再点一次确认', () => act(note, `停用 ${p.name}`, s => p.from >= today ? B.removeShiftPlan(s, p.id) : B.endShiftPlan(s, p.id, B.addDays(today, -1)), '已停用，以前的排班不变。'))}),
        h('button', {class: 'soft-button', type: 'button', text: '删除', onclick: e => armed(e.currentTarget, '再点一次确认删除', () => act(note, `删除 ${p.name}`, s => B.removeShiftPlan(s, p.id), '已删除。'))})),
      note));
  }
  if (!editingPlan && !sfOpen) resetShiftForm(); else syncShiftForm();
}
function fillShiftForm(p) {
  editingPlan = p.id; $('shift-form-title').textContent = '修改这个班次'; $('sf-submit').textContent = '保存修改'; $('sf-cancel').hidden = false;
  $('sf-name').value = p.name; $('sf-start').value = p.start; $('sf-end').value = p.end; $('sf-break').value = String(p.breakMinutes); $('sf-from').value = p.from;
  weekButtons(repeat, p.weekdays); syncShiftForm();
  $('shift-form').scrollIntoView({behavior: 'smooth', block: 'start'});
}
$('sf-cancel').onclick = resetShiftForm;
$('shift-form').onsubmit = ev => {
  ev.preventDefault();
  const raw = {jobId: jobEditId, name: $('sf-name').value.trim() || '上班', start: $('sf-start').value, end: $('sf-end').value, breakMinutes: Number($('sf-break').value || 0), weekdays: pickedDays(repeat), from: $('sf-from').value, until: null};
  const id = editingPlan;
  if (act($('sf-note'), id ? `修改班次 ${raw.name}` : `新增班次 ${raw.name}`, s => id ? B.updateShiftPlan(s, id, {...raw, until: s.shiftPlans.find(p => p.id === id)?.until ?? null}) : B.addShiftPlan(s, raw), id ? '已保存修改。' : '已排上，日历会自动显示。')) resetShiftForm();
};

// 工资
let editingRule = null, rateMode = 'daily';
function setRateMode(v) { rateMode = v; segSet($('rate-mode'), v); $('rate-label').textContent = v === 'hourly' ? '一小时多少钱（美元）' : '一天多少钱（美元）'; }
$('rate-mode').onclick = e => { const b = e.target.closest('button'); if (b) setRateMode(b.dataset.v); };
function defaultEffective(jobId) {
  if (B.rulesOf(state, jobId).length) return today;
  const first = Object.keys(state.entries).filter(d => state.entries[d].some(e => e.jobId === jobId)).sort()[0], month1 = today.slice(0, 7) + '-01';
  return first && first < month1 ? first : month1;
}
function resetRateForm() {
  editingRule = null; const has = B.rulesOf(state, jobEditId).length;
  $('rate-form-title').textContent = has ? '涨薪或改工资：新加一条，从某天开始按新的算' : '填写工资'; $('rf-submit').textContent = has ? '加上这条' : '保存工资';
  $('rf-cancel').hidden = true; $('rf-rate').value = ''; $('rf-ot').value = ''; $('rf-hours').value = '8'; $('rf-effective').value = defaultEffective(jobEditId); setRateMode('daily');
}
function fillRateForm(r) {
  editingRule = r.effective; $('rate-form-title').textContent = '修改这条工资'; $('rf-submit').textContent = '保存修改'; $('rf-cancel').hidden = false; setRateMode(r.mode);
  $('rf-rate').value = (r.rateCents / 100).toFixed(2); $('rf-ot').value = (r.overtimeRateCents / 100).toFixed(2); $('rf-hours').value = hoursText(r.defaultMinutes); $('rf-effective').value = r.effective;
  $('rate-form').scrollIntoView({behavior: 'smooth', block: 'start'});
}
function renderRules() {
  const list = $('rule-list'), rules = B.rulesOf(state, jobEditId); list.replaceChildren();
  if (!rules.length) list.append(h('p', {class: 'field-hint', text: '还没填。填好后，这份工作的班就能算钱了。'}));
  for (const r of [...rules].reverse()) {
    const note = h('p', {class: 'inline-state', hidden: true});
    list.append(h('div', {class: 'item-card'},
      h('div', {class: 'item-main'}, h('strong', {text: ruleText(r)}), h('span', {text: `${r.effective.replaceAll('-', '/')} 起按这个算 · 一天正班 ${dur(r.defaultMinutes)}`})),
      h('div', {class: 'item-actions'},
        h('button', {class: 'soft-button', type: 'button', text: '修改', onclick: () => fillRateForm(r)}),
        h('button', {class: 'soft-button', type: 'button', text: '删除', onclick: e => armed(e.currentTarget, '再点一次确认删除', () => act(note, '删除一条工资', s => B.removeRule(s, jobEditId, r.effective), '已删除。'))})),
      note));
  }
  if (!editingRule) resetRateForm();
}
$('rf-cancel').onclick = resetRateForm;
$('rate-form').onsubmit = ev => {
  ev.preventDefault();
  const eff = editingRule, jobId = jobEditId;
  if (act($('rf-note'), eff ? '修改工资' : '填写工资', s => {
    const raw = {jobId, effective: $('rf-effective').value, mode: rateMode, rateCents: B.moneyInput($('rf-rate').value.trim()), overtimeRateCents: B.moneyInput(($('rf-ot').value || '0').trim()), defaultMinutes: hoursToMinutes($('rf-hours').value, {allowZero: false})};
    return eff ? B.updateRule(s, jobId, eff, raw) : B.addRule(s, raw);
  }, '已保存工资。')) resetRateForm();
};

// 发薪日：用大白话问，下面实时显示接下来三次发薪。
let cycKind = 'monthly', cfWhich = 'last';
function syncCycleForm() {
  segSet($('cycle-kind'), cycKind); segSet($('cf-which'), cfWhich);
  $('cycle-monthly').hidden = cycKind !== 'monthly'; $('cycle-weekly').hidden = cycKind !== 'weekly' && cycKind !== 'biweekly';
  $('cf-custom').hidden = cfWhich !== 'custom'; $('cf-weekend-field').hidden = cycKind === 'none';
  renderCyclePreview();
}
function intField(id, name, min, max) { const t = $(id).value.trim(); if (!/^\d+$/.test(t) || +t < min || +t > max) throw new Error(`${name}请填 ${min}–${max} 的整数`); return +t; }
function readCycle() {
  if (cycKind === 'none') return null;
  const weekendRule = $('cf-weekend').value;
  if (cycKind === 'monthly') {
    const payDay = intField('cf-payday', '发薪日', 1, 31);
    const [startDay, payMonthOffset] = cfWhich === 'last' ? [1, 1] : cfWhich === 'this' ? [1, 0] : [intField('cf-startday', '起算日', 1, 28), Number($('cf-offset').value)];
    return B.validatePayCycle({kind: 'monthly', startDay, payMonthOffset, payDay, weekendRule});
  }
  const len = cycKind === 'biweekly' ? 14 : 7, pay = $('cf-lastpay').value, end = $('cf-lastend').value;
  if (!pay || !end) throw new Error('填好上面两个日期，这里会显示接下来的发薪日');
  if (end > pay) throw new Error('发的钱应该算到发薪那天或更早');
  const off = B.daysBetween(end, pay); if (off > 60) throw new Error('发薪日离那一期结束太远了（最多 60 天）');
  return B.validatePayCycle({kind: 'weekly', lengthDays: len, anchor: B.addDays(end, 1 - len), payOffsetDays: off, weekendRule});
}
function nextCyclePeriods(c, count = 3) {
  const out = []; let p = B.cyclePeriodFor(c, B.addDays(today, -75));
  for (let i = 0; i < 40 && out.length < count; i++) { if (p.payday >= today) out.push(p); p = B.cyclePeriodFor(c, B.addDays(p.end, 1)); }
  return out;
}
function renderCyclePreview() {
  const box = $('cycle-preview'); let c;
  try { c = readCycle(); } catch (e) { box.replaceChildren(h('p', {class: 'preview-line', text: e.message})); return; }
  if (!c) { box.replaceChildren(h('p', {class: 'preview-line', text: '先不设也可以：首页会显示本月已赚，设好后才会显示「待发工资」。'})); return; }
  const lines = nextCyclePeriods(c).map(p => h('li', {}, h('strong', {text: `${shortDate(p.payday)} 周${WEEK[wdOf(p.payday)]}`}), ` 发 ${rangeLabel(p)} 的工资`));
  const sch = jobSchedules(jobEditId).length;
  box.replaceChildren(...[h('p', {class: 'preview-title', text: '按这样设，接下来是：'}), h('ul', {class: 'cycle-list'}, ...lines), sch ? h('p', {class: 'preview-line', text: `另外已导入 ${sch} 期发薪周期，那些日子以导入的为准。`}) : null].filter(Boolean));
}
function fillCycleForm(c) {
  $('cf-weekend').value = c?.weekendRule || 'none';
  if (!c) { cycKind = 'none'; cfWhich = 'last'; $('cf-payday').value = '10'; $('cf-lastpay').value = ''; $('cf-lastend').value = ''; }
  else if (c.kind === 'monthly') {
    cycKind = 'monthly'; $('cf-payday').value = String(c.payDay);
    cfWhich = c.startDay === 1 && c.payMonthOffset === 1 ? 'last' : c.startDay === 1 && c.payMonthOffset === 0 ? 'this' : 'custom';
    $('cf-startday').value = String(c.startDay); $('cf-offset').value = String(c.payMonthOffset);
  } else {
    cycKind = c.lengthDays === 14 ? 'biweekly' : 'weekly';
    let p = B.cyclePeriodFor(c, today);
    for (let i = 0; i < 20 && B.addDays(p.end, c.payOffsetDays) > today; i++) p = B.cyclePeriodFor(c, B.addDays(p.start, -1));
    $('cf-lastend').value = p.end; $('cf-lastpay').value = B.addDays(p.end, c.payOffsetDays);
  }
  syncCycleForm();
}
for (const [id, set] of [['cycle-kind', v => { cycKind = v; }], ['cf-which', v => { cfWhich = v; }]]) $(id).onclick = e => { const b = e.target.closest('button'); if (b) { set(b.dataset.v); syncCycleForm(); } };
$('cycle-fields').addEventListener('input', renderCyclePreview); $('cycle-fields').addEventListener('change', renderCyclePreview);
$('cycle-form').onsubmit = ev => {
  ev.preventDefault();
  const id = jobEditId;
  act($('cf-note'), '设置发薪日', s => B.setPayCycle(s, id, readCycle()), cycKind === 'none' ? '已保存：先不设发薪日。' : '已保存发薪日。');
};

// 导入发薪安排：PDF（发薪日历 / 工资单；扫描页用本机 OCR）、JSON、粘贴文字。识别结果先核对，确认后才写入这份工作。
// PDF 识别规则和 OCR 用的是原来识别页的同一套代码（payroll/），这里只做界面。
let pendingImport = null, pdfLib = null, importBusy = false;
const importStatus = t => say($('import-status'), t);
function resetImport() { pendingImport = null; $('import-preview').hidden = true; $('import-preview').replaceChildren(); importStatus(''); say($('import-note'), ''); }
async function loadPdfLib() { pdfLib ||= await import('./pdfimport.js?v=89b9af5a97'); return pdfLib; }
const sameSchedule = (a, b) => a.start === b.start && a.end === b.end && a.payday === b.payday;
$('import-file').onchange = async ev => {
  const file = ev.target.files[0]; ev.target.value = ''; if (!file || importBusy) return;
  resetImport();
  if (/\.json$/i.test(file.name) || file.type === 'application/json') { showJsonImport(await file.text(), file.name); return; }
  const isImage = /^image\//.test(file.type) || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(file.name);
  importBusy = true; $('import-file').disabled = true;
  try {
    const lib = await loadPdfLib();
    const r = isImage ? await lib.imageText(file, importStatus) : await lib.pdfText(file, importStatus);
    importStatus('');
    showRecognized(lib.recognize(r.text), file.name, r.emptyPages ? [`有 ${r.emptyPages} 页没读出文字，可能是很模糊的扫描页，请对照原件看看有没有漏。`] : []);
  } catch (e) { importStatus(''); say($('import-note'), '没能读出来：' + (e.message || '请检查文件，或者把文字粘贴进来。'), 'error'); }
  finally { importBusy = false; $('import-file').disabled = false; }
};
$('import-parse').onclick = async () => {
  const text = $('import-text').value; resetImport();
  if (!text.trim()) { say($('import-note'), '先把文字粘贴进来。', 'error'); return; }
  if (/^\s*[[{]/.test(text)) { showJsonImport(text, '粘贴的内容'); return; }
  try { const lib = await loadPdfLib(); showRecognized(lib.recognize(text), '粘贴的文字', []); }
  catch (e) { say($('import-note'), e.message, 'error'); }
};
function showJsonImport(text, name) {
  const box = $('import-preview');
  try {
    const pv = B.previewImport(state, text, jobEditId); pendingImport = pv;
    const lines = [];
    if (pv.paySchedules.length) lines.push(`新增发薪周期 ${pv.paySchedules.length} 期：${pv.paySchedules.slice(0, 3).map(p => `${rangeLabel(p)}（${shortDate(p.payday)} 发）`).join('、')}${pv.paySchedules.length > 3 ? ' 等' : ''}`);
    const n = Object.keys(pv.entries).length;
    if (n) lines.push(`新增出勤记录 ${n} 天：${Object.keys(pv.entries).slice(0, 4).map(shortDate).join('、')}${n > 4 ? ' 等' : ''}`);
    if (pv.skipped.length) lines.push(`已存在且完全相同、自动跳过 ${pv.skipped.length} 天`);
    if (!pv.paySchedules.length && !n) lines.push('文件里的内容都已经有了，没有需要新增的。');
    box.replaceChildren(h('p', {class: 'preview-title', text: `核对「${name}」→ 归到「${jobName(jobEditId)}」`}), ...lines.map(t => h('p', {class: 'preview-line', text: t})),
      h('div', {class: 'item-actions'},
        (pv.paySchedules.length || n) ? h('button', {class: 'primary-small', type: 'button', text: '确认导入', onclick: () => { const p = pendingImport; if (!p) return; if (act($('import-note'), `导入 ${name}`, s => B.applyImport(s, p), '已导入。')) { pendingImport = null; box.hidden = true; } }}) : null,
        h('button', {class: 'soft-button', type: 'button', text: '取消', onclick: resetImport})));
    box.hidden = false;
  } catch (e) { say($('import-note'), e.message, 'error'); }
}
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
function showRecognized(res, name, extraWarnings) {
  const box = $('import-preview'), jobId = jobEditId, warns = [...res.warnings, ...extraWarnings];
  const warnBox = warns.length ? h('div', {class: 'import-warn'}, ...warns.map(t => h('p', {text: t}))) : null;
  const cancel = h('button', {class: 'soft-button', type: 'button', text: '取消', onclick: resetImport});
  if (res.kind === 'calendar') {
    const have = jobSchedules(jobId);
    const rows = res.rows.map(r => {
      const dup = r.valid && have.some(p => sameSchedule(p, r));
      const check = h('input', {type: 'checkbox', checked: r.valid && !dup, 'aria-label': `导入第 ${r.period} 期`});
      const date = (k, label) => h('label', {class: 'ci-date'}, h('span', {text: label}), h('input', {type: 'date', value: r[k], 'data-k': k}));
      const el = h('div', {class: 'ci-row' + (dup ? ' dup' : '')},
        h('label', {class: 'ci-head'}, check, h('strong', {text: `第 ${r.period} 期`}), h('span', {class: 'ci-tag', text: dup ? '已经有了' : r.valid ? '' : '日期不全，请改一下'})),
        h('div', {class: 'ci-dates'}, date('start', '开始'), date('end', '结束'), date('payday', '发薪')));
      return {r, el, check, read: () => Object.fromEntries([...el.querySelectorAll('input[type=date]')].map(i => [i.dataset.k, i.value]))};
    });
    const go = h('button', {class: 'primary-small', type: 'button', text: `导入到「${jobName(jobId)}」`, onclick: () => {
      const picked = rows.filter(x => x.check.checked).map(x => ({type: 'calendar', period: x.r.period, ...x.read()}));
      if (!picked.length) { say($('import-note'), '请至少勾选一期。', 'error'); return; }
      const bad = picked.filter(p => !p.start || !p.end || !p.payday || p.start > p.end).map(p => p.period);
      if (bad.length) { say($('import-note'), `第 ${bad.join('、')} 期日期不全或顺序不对，请改一下或者取消勾选。`, 'error'); return; }
      const fresh = picked.filter(p => !jobSchedules(jobId).some(q => sameSchedule(q, p)));
      if (!fresh.length) { say($('import-note'), '勾选的这几期都已经导入过了。'); return; }
      if (act($('import-note'), `导入 ${fresh.length} 期发薪安排`, s => B.importSchedules(s, jobId, fresh), `已导入 ${fresh.length} 期发薪安排${picked.length > fresh.length ? `，跳过 ${picked.length - fresh.length} 期已有的` : ''}。日历上会标出发薪日。`)) { pendingImport = null; box.hidden = true; }
    }});
    fill(box, h('p', {class: 'preview-title', text: `「${name}」是发薪日历，找到 ${res.rows.length} 期`}),
      h('p', {class: 'preview-line', text: '日期按表上的「月/日/年」读出来的。打勾的会导入，日期可以直接改。原表没有金额，不会算出钱数。'}),
      warnBox, h('div', {class: 'ci-list'}, ...rows.map(x => x.el)), h('div', {class: 'item-actions'}, go, cancel));
  } else {
    const f = res.fields, found = ['start', 'end', 'payday', 'net', 'gross'].filter(k => f[k].status === 'detected').length;
    const field = (k, label, type) => h('label', {class: 'field'}, h('span', {}, label, h('small', {class: 'ci-state', text: f[k].status === 'detected' ? ' · 已识别，请核对' : f[k].status === 'conflict' ? ' · 有多个值，请填写' : ' · 没找到，可以手动填'})), h('input', {type, value: f[k].value, 'data-k': k, ...(type === 'text' ? {inputmode: 'decimal'} : {})}));
    const form = h('div', {class: 'ci-payslip'}, field('start', '计薪开始', 'date'), field('end', '计薪结束', 'date'), field('payday', '发薪日', 'date'), field('net', '实发（到手）金额', 'text'));
    const rec = h('input', {type: 'checkbox', checked: !!f.net.value});
    const go = h('button', {class: 'primary-small', type: 'button', text: '导入这一期', onclick: () => {
      const v = Object.fromEntries([...form.querySelectorAll('input')].map(i => [i.dataset.k, i.value.trim()]));
      if (!v.start || !v.end || !v.payday) { say($('import-note'), '计薪开始、结束和发薪日都要有，没识别到的请手动填上。', 'error'); return; }
      if (v.start > v.end) { say($('import-note'), '计薪开始不能晚于结束。', 'error'); return; }
      act($('import-note'), '导入工资单', s => {
        const have = jobSchedules(jobId), exists = have.some(p => sameSchedule(p, v));
        let n = s;
        if (!exists) {
          try { n = B.importSchedules(s, jobId, [{type: 'calendar', period: Math.max(0, ...have.map(p => p.period)) + 1, start: v.start, end: v.end, payday: v.payday}]); }
          catch (e) { throw new Error(/重叠/.test(e.message) ? `这一期（${shortDate(v.start)}–${shortDate(v.end)}）和「${jobName(jobId)}」已有的发薪周期日期重叠了，为了不弄乱，没有导入。请核对日期，或者导入到另一份工作。` : e.message); }
        }
        if (rec.checked && v.net) n = B.setReceipt(n, jobId, {start: v.start, end: v.end}, {amountCents: B.moneyInput(v.net.replace(/[$,\s]/g, '')), date: v.payday, note: '来自工资单'});
        return n;
      }, `已导入这一期（${shortDate(v.start)}–${shortDate(v.end)}，${shortDate(v.payday)} 发）${rec.checked && v.net ? '，实发金额记成了实际到账' : ''}。`) && (box.hidden = true);
    }});
    fill(box, h('p', {class: 'preview-title', text: `「${name}」是工资单，识别出 ${found} 项`}), warnBox, form,
      h('label', {class: 'switch-row'}, h('span', {}, '把实发金额记成这一期的实际到账', h('small', {text: '在「历史账单」里能看到和预计工资差多少'})), rec),
      f.gross.value ? h('p', {class: 'preview-line', text: `表上应发（税前）：${f.gross.value}`}) : null,
      h('div', {class: 'item-actions'}, go, cancel));
  }
  box.hidden = false;
}
// 工作卡：每一项点开才显示修改的地方。
function syncSecs() {
  document.querySelectorAll('#job .job-sec').forEach(sec => {
    const key = sec.id.slice(4), open = openSecs.has(key), head = sec.querySelector('.sec-head');
    head.setAttribute('aria-expanded', String(open)); sec.querySelector('.sec-body').hidden = !open; sec.classList.toggle('open', open);
    head.querySelector('.sec-go').textContent = open ? '收起' : '修改';
  });
}
document.querySelectorAll('#job .sec-head').forEach(b => b.onclick = () => { const k = b.dataset.sec; if (openSecs.has(k)) openSecs.delete(k); else openSecs.add(k); syncSecs(); });
renderers.job = () => {
  const j = B.jobFor(state, jobEditId);
  if (!j) { show('jobs', null, false); return; }
  if ($('cycle-fields').parentElement !== $('cycle-form')) { $('cycle-form').prepend($('cycle-fields')); $('cycle-fields').classList.remove('in-wizard'); fillCycleForm(j.payCycle); }
  $('job-title').textContent = j.name; $('jn-name').value = j.name;
  const s = jobSummary(j), sum = (id, v, missing) => { const el = $(id); el.textContent = v || missing; el.classList.toggle('warn-text', !v); };
  sum('sum-rate', s.rate, '还没填'); sum('sum-cycle', s.cycle, '还没设'); sum('sum-shift', s.shift, '还没排');
  $('sum-import').textContent = '选 PDF 或照片：发薪日历、工资单'; $('sum-name').textContent = j.name;
  renderRules(); renderJobShifts();
  if (current === 'job' && !$('cycle-form').contains(document.activeElement)) fillCycleForm(j.payCycle);
  const list = $('schedule-list'), sch = jobSchedules(j.id); list.replaceChildren();
  if (sch.length) {
    list.append(h('p', {class: 'section-title', text: `已导入的发薪周期（${sch.length} 期，优先于发薪日的设置）`}));
    for (const p of sch.slice(-6).reverse()) list.append(h('div', {class: 'item-card slim'}, h('div', {class: 'item-main'}, h('strong', {text: rangeLabel(p)}), h('span', {text: `第 ${p.period} 期 · ${shortDate(p.payday)} 发薪`}))));
  }
  for (const id of ['cf-note', 'jn-note', 'import-note']) say($(id), '');
  syncSecs();
};
$('job-name-form').onsubmit = ev => { ev.preventDefault(); const id = jobEditId, name = $('jn-name').value.trim(); act($('jn-note'), '改工作名字', s => B.updateJob(s, id, {name}), '已保存名字。'); };
$('job-delete').onclick = e => { const id = jobEditId; armed(e.currentTarget, '再点一次确认删除', () => { if (act($('jn-note'), `删除工作 ${jobName(id)}`, s => B.removeJob(s, id), '')) { trail = trail.filter(t => t.id !== 'job'); show('jobs', null, false); } }); };

// ---------- 工资 ----------
renderers.pay = () => {
  const m = today.slice(0, 7), sum = B.monthSummary(state, m);
  $('pay-import-jobs').hidden = true; $('pay-import').setAttribute('aria-expanded', 'false');
  $('pay-hero-label').textContent = `本月预计工资 · ${+m.slice(5)}月${multiJob() ? '（所有工作）' : ''}`;
  $('pay-amount').textContent = state.rules.length ? money(sum.cents) : '—';
  $('pay-hero-note').textContent = `上班 ${sum.days} 天${sum.overtimeMinutes ? ` · 加班 ${dur(sum.overtimeMinutes)}` : ''}${sum.overtimeDays ? `（其中 ${sum.overtimeDays} 天只加班）` : ''}`;
  const warn = !state.jobs.length ? '还没添加工作。点下面「我的工作」添加。' : !state.rules.length ? '还没填工资，点下面「我的工作」填一下。' : sum.unpriced ? `有 ${sum.unpriced} 条记录在那家公司开始算工资之前，没算进去。` : '';
  say($('pay-warn'), warn);
  const list = $('pay-jobs'); list.replaceChildren();
  for (const j of state.jobs) {
    const p = B.periodFor(state, j.id, today), hasRule = B.rulesOf(state, j.id).length > 0;
    const x = p ? B.periodSummary(state, j.id, p, today) : {...B.monthSummary(state, m, j.id)};
    list.append(h('button', {class: 'item-card bill job-card', type: 'button', onclick: () => openJob(j.id)},
      h('div', {class: 'item-main'},
        h('div', {class: 'bill-top'}, h('strong', {text: j.name}), h('span', {class: 'badge', text: p ? `${shortDate(p.payday)} 发` : '没设发薪日'})),
        h('span', {text: p ? `本期 ${rangeLabel(p)}` : `本月 ${+m.slice(5)}月`}),
        h('p', {class: 'bill-amount', text: hasRule ? money(x.cents) : '还没填工资'}),
        h('span', {text: `上班 ${x.days} 天${x.overtimeMinutes ? ` · 加班 ${dur(x.overtimeMinutes)}` : ''}`}))));
  }
};

// 工资页 › 识别工资单 / 发薪日历：一份工作直接进它的导入；多份工作先就地问导到哪一份
$('pay-import').onclick = () => {
  const box = $('pay-import-jobs');
  if (!state.jobs.length) { say($('pay-warn'), '先添加一份工作，识别出来的发薪安排要存到工作里。点下面「我的工作」添加。'); return; }
  if (state.jobs.length === 1) { openJob(state.jobs[0].id, 'import'); return; }
  const open = box.hidden; box.hidden = !open; $('pay-import').setAttribute('aria-expanded', String(open));
  if (open) box.replaceChildren(h('p', {class: 'field-hint', text: '是哪份工作的？'}), ...state.jobs.map(j => h('button', {class: 'soft-button', type: 'button', text: j.name, onclick: () => { box.hidden = true; openJob(j.id, 'import'); }})));
};
// ---------- 历史账单与到账 ----------
const STATUS = {received: '已到账', due: '待记到账', waiting: '等发薪', current: '进行中'};
renderers.history = () => {
  const y = B.yearSummary(state, today.slice(0, 4));
  $('year-card').replaceChildren(h('p', {class: 'year-title', text: `${y.year} 年`}), h('div', {class: 'year-nums'},
    h('div', {}, h('span', {text: '预计工资'}), h('strong', {text: state.rules.length ? money(y.total.cents) : '—'})),
    h('div', {}, h('span', {text: '已记到账'}), h('strong', {text: money(y.receivedCents)})),
    h('div', {}, h('span', {text: '上班'}), h('strong', {text: `${y.total.days} 天`}))));
  const list = $('bill-list'); list.replaceChildren();
  const bills = B.billHistory(state, today, 24);
  if (!bills.length) list.append(h('p', {class: 'empty-copy', text: state.jobs.some(j => j.payCycle) || state.schedules.length ? '还没有已经结束的一期工资。' : '给工作设好发薪日，或者导入发薪周期后，这里会按期列出账单。'}));
  for (const b of bills) list.append(billCard(b));
};
function billCard(b) {
  const note = h('p', {class: 'inline-state', hidden: true});
  const form = h('form', {class: 'receipt-form', hidden: true},
    h('label', {class: 'field'}, h('span', {text: '实际到手（美元）'}), h('input', {inputmode: 'decimal', name: 'amount', value: b.receipt ? (b.receipt.amountCents / 100).toFixed(2) : '', required: true})),
    h('label', {class: 'field'}, h('span', {text: '到账日期'}), h('input', {type: 'date', name: 'date', value: b.receipt?.date || b.period.payday, required: true})),
    h('label', {class: 'field'}, h('span', {text: '备注（选填）'}), h('input', {name: 'note', maxlength: '100', value: b.receipt?.note || ''})),
    h('button', {class: 'primary-small', type: 'submit', text: '保存到账'}));
  form.onsubmit = ev => { ev.preventDefault(); const f = form.elements; act(note, `记 ${rangeLabel(b.period)} 到账`, s => B.setReceipt(s, b.jobId, b.period, {amountCents: B.moneyInput(f.amount.value.trim()), date: f.date.value, ...(f.note.value.trim() ? {note: f.note.value.trim()} : {})}), '已记下到账。'); };
  const diff = b.differenceCents, priced = B.rulesOf(state, b.jobId).length && !(b.unpriced && b.unpriced === b.shifts + b.overtimeDays);
  return h('div', {class: 'item-card bill'},
    h('div', {class: 'item-main'},
      h('div', {class: 'bill-top'}, h('strong', {text: (multiJob() ? b.jobName + ' · ' : '') + rangeLabel(b.period)}), h('span', {class: 'badge' + (b.status === 'due' ? ' warn' : ''), text: b.status === 'waiting' && b.period.payday === today ? '今天发薪' : STATUS[b.status]})),
      h('span', {text: `发薪日 ${shortDate(b.period.payday)} · 上班 ${b.days} 天${b.overtimeMinutes ? ` · 加班 ${dur(b.overtimeMinutes)}` : ''}`}),
      h('p', {class: 'bill-amount', text: `预计 ${priced ? money(b.cents) : '—'}`}),
      b.unpriced ? h('span', {class: 'warn-text', text: `有 ${b.unpriced} 条记录在开始算工资之前，没算进预计工资`}) : null,
      b.receipt ? h('span', {text: `实际到账 ${money(b.receipt.amountCents)}（${shortDate(b.receipt.date)}）${diff === null ? '' : diff === 0 ? ' · 和预计一样' : diff > 0 ? ` · 比预计多 ${money(diff)}` : ` · 比预计少 ${money(-diff)}`}${b.receipt.note ? ` · ${b.receipt.note}` : ''}`}) : null),
    h('div', {class: 'item-actions'},
      h('button', {class: 'soft-button', type: 'button', text: b.receipt ? '修改到账' : '记到账', onclick: () => { form.hidden = !form.hidden; }}),
      b.receipt ? h('button', {class: 'soft-button', type: 'button', text: '删除到账', onclick: e => armed(e.currentTarget, '再点一次确认删除', () => act(note, '删除到账记录', s => B.setReceipt(s, b.jobId, b.period, null), '已删除到账记录。'))}) : null),
    form, note);
}

// ---------- 记录选项 ----------
renderers.options = () => { for (const k of ['halfDay', 'customHours', 'overtime', 'autoClock']) $('opt-' + k).checked = state.settings[k]; $('opt-fine').checked = fineDigits; $('opt-holidays').checked = showHolidays; say($('opt-note'), ''); };
$('opt-holidays').onchange = e => { showHolidays = e.target.checked; saveDisplay(); dayCache.clear(); for (const p of Object.values(pagers)) { p.cache.clear(); p.element.replaceChildren(); p.active = null; } };
$('opt-autoClock').onchange = e => { const on = e.target.checked; if (!act($('opt-note'), on ? '开启自动打卡' : '关闭自动打卡', s => B.setAutoClock(s, on, today), on ? '已开启：从今天起，到上班时间自动记成上班。请假到日历里点那天取消。' : '已关闭：之后要自己打卡。')) e.target.checked = !on; };
$('opt-fine').onchange = e => { fineDigits = e.target.checked; saveDisplay(); };
for (const k of ['halfDay', 'customHours', 'overtime']) $('opt-' + k).onchange = e => { const on = e.target.checked; if (!act($('opt-note'), '修改记录选项', s => ({...s, settings: {...s.settings, [k]: on}}), '已保存。')) e.target.checked = !on; };

// ---------- 备份与恢复 ----------
renderers.backup = () => { say($('backup-note'), ''); say($('restore-note'), ''); $('restore-preview').hidden = true; $('backup-out').hidden = true; syncDemoCard(); };
function showBackupText(label, text) { $('backup-out-label').textContent = label; $('backup-text').value = text; $('backup-out').hidden = false; }
$('backup-copy').onclick = () => {
  const ta = $('backup-text');
  const fallback = () => { ta.focus(); ta.select(); say($('backup-note'), '已选中备份内容，请长按或按 Ctrl+C 复制，再粘贴到备忘录或文件里保存。'); };
  try { navigator.clipboard.writeText(ta.value).then(() => say($('backup-note'), '已复制。请粘贴到备忘录、聊天或文件里保存好。'), fallback); } catch { fallback(); }
};
$('backup-export').onclick = () => {
  try {
    const text = B.backupText(B.createBackup(localStorage));
    try { download(B.backupFileName(today), text); } catch { /* 有的环境不允许下载 */ }
    showBackupText(`备份内容（${B.backupFileName(today)}）`, text);
    say($('backup-note'), '已生成备份。如果没有自动下载，点下面的「复制备份内容」，粘贴到备忘录或文件里保存。');
  } catch (e) { say($('backup-note'), e.message, 'error'); }
};
function previewRestore(text, name) {
  const box = $('restore-preview'); box.hidden = true; say($('restore-note'), '');
  try {
    const parsed = B.parseBackup(text), d = B.describeBackup(parsed);
    box.replaceChildren(h('p', {class: 'preview-title', text: `「${name}」里有：`}),
      h('p', {class: 'preview-line', text: `工作 ${d.jobs ?? 0} 份 · 出勤记录 ${d.entries} 天 · 班次 ${d.shiftPlans} 个 · 工资 ${d.rules} 条 · 发薪周期 ${d.paySchedules} 期 · 到账记录 ${d.receipts} 条`}),
      h('p', {class: 'preview-line', text: d.payslips === null ? '这是旧版备份，只含考勤；PDF 工资单保持现在的样子。' : `PDF 工资单 ${d.payslips} 份`}),
      d.exportedAt ? h('p', {class: 'preview-line', text: `备份时间：${new Date(d.exportedAt).toLocaleString('zh-CN')}`}) : null,
      h('p', {class: 'preview-line warn', text: '恢复会替换这台设备上现在的数据。恢复前的数据会放到上面的备份框里，可以复制保存。'}),
      h('div', {class: 'item-actions'},
        h('button', {class: 'primary-small', type: 'button', text: '确认恢复', onclick: () => {
          try {
            const before = B.restoreBackup(localStorage, parsed);
            const raw = JSON.stringify({format: 'banji-raw-before-restore', attendance: before.attendance, payslips: before.payslips, profile: before.profile}, null, 2);
            try { download(`banji-before-restore-${today}.json`, raw); } catch { /* 有的环境不允许下载 */ }
            showBackupText('恢复前的数据（以防万一，可以复制保存）', raw);
            box.hidden = true; $('restore-text').value = ''; reloadFromStorage(); say($('restore-note'), '已恢复。恢复前的数据放在上面的框里了。');
          } catch (e) { say($('restore-note'), e.message, 'error'); }
        }}),
        h('button', {class: 'soft-button', type: 'button', text: '取消', onclick: () => { box.hidden = true; }})));
    box.hidden = false;
  } catch (e) { say($('restore-note'), e.message, 'error'); }
}
$('restore-file').onchange = async ev => { const file = ev.target.files[0]; ev.target.value = ''; if (file) previewRestore(await file.text(), file.name); };
$('restore-paste').onclick = () => previewRestore($('restore-text').value, '粘贴的内容');

// ---------- 示例数据 ----------
// 载入前把现在的考勤数据另存一份（只存第一次的），「清除示例」时换回来；载入和清除都可以撤销。
const DEMO_KEY = 'banji.before-demo.v1';
function demoSaved() { try { return localStorage.getItem(DEMO_KEY) !== null; } catch { return false; } }
const hasOwnData = () => state.jobs.length > 0 || Object.keys(state.entries).length > 0;
function loadDemo(note, then) {
  try { if (!demoSaved()) localStorage.setItem(DEMO_KEY, JSON.stringify({savedAt: new Date().toISOString(), attendance: hasOwnData() ? state : null})); }
  catch { say(note, '这台设备存不下你现在的数据，为了不弄丢，没有载入示例。', 'error'); return; }
  if (act(note, '载入示例数据', () => B.demoState(today, nowMin()), '已载入示例数据。随时可以在「设置 › 备份与恢复」换回原来的。')) then?.();
}
function clearDemo(note) {
  let saved = null; try { saved = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch { saved = null; }
  if (act(note, '清除示例数据', () => saved?.attendance ? B.validateState(saved.attendance) : B.emptyState(), saved?.attendance ? '已换回你原来的数据。' : '示例数据已清除。')) {
    try { localStorage.removeItem(DEMO_KEY); } catch { /* 下次再清 */ }
    syncDemoCard();
  }
}
function syncDemoCard() {
  const on = demoSaved();
  $('demo-clear').hidden = !on;
  $('demo-load').textContent = on ? '重新生成示例数据' : '载入示例数据';
}
$('setup-demo').onclick = () => loadDemo($('home-note'), () => updateHome({roll: true}));
$('demo-load').onclick = e => {
  const go = () => loadDemo($('demo-note'), syncDemoCard);
  if (hasOwnData() && !demoSaved()) armed(e.currentTarget, '再点一次：先存好你的数据再载入', go); else go();
};
$('demo-clear').onclick = e => armed(e.currentTarget, '再点一次确认清除示例', () => clearDemo($('demo-note')));

// ---------- 个人资料 ----------
let draft = null, lastAnimal = {kind: 'animal', animal: 'cat', color: 'mint'}, lastImage = null;
function syncDraft() {
  renderAvatar($('pf-avatar'), draft);
  const kind = draft.avatar.kind; segSet($('pf-kind'), kind);
  $('pf-animal-fields').hidden = kind !== 'animal'; $('pf-image-fields').hidden = kind !== 'image';
  const a = draft.avatar.kind === 'animal' ? draft.avatar : lastAnimal;
  $('pf-animals').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === a.animal)));
  $('pf-colors').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === a.color)));
  $('pf-animals').querySelectorAll('.avatar').forEach(el => { el.style.background = AVATAR_BG[a.color]; });
}
for (const k of Object.keys(ANIMAL_NAMES)) $('pf-animals').append(h('button', {type: 'button', class: 'animal-pick', 'data-v': k, 'aria-label': ANIMAL_NAMES[k], onclick: () => { lastAnimal = {...lastAnimal, animal: k}; draft.avatar = {...lastAnimal}; syncDraft(); }}, Object.assign(h('span', {class: 'avatar'}), {innerHTML: avatarSVG(k)})));
for (const [k, c] of Object.entries(AVATAR_BG)) $('pf-colors').append(h('button', {type: 'button', class: 'color-pick', 'data-v': k, 'aria-label': {mint: '薄荷绿', sky: '天蓝', peach: '蜜桃', lemon: '柠檬黄', lilac: '淡紫', sand: '沙色'}[k], style: `background:${c}`, onclick: () => { lastAnimal = {...lastAnimal, color: k}; draft.avatar = {...lastAnimal}; syncDraft(); }}));
$('pf-kind').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.v === 'animal') draft.avatar = {...lastAnimal};
  else if (lastImage) draft.avatar = {kind: 'image', dataUrl: lastImage};
  else { segSet($('pf-kind'), 'image'); $('pf-animal-fields').hidden = true; $('pf-image-fields').hidden = false; return; }
  syncDraft();
};
renderers.profile = () => {
  draft = structuredClone(profile);
  if (draft.avatar.kind === 'animal') lastAnimal = {...draft.avatar}; else lastImage = draft.avatar.dataUrl;
  $('pf-nickname').value = draft.nickname;
  say($('pf-note'), profileBroken ? '原来的个人资料读不出来，保存会用新的资料替换它。' : '', profileBroken ? 'error' : '');
  syncDraft();
};
/** 把图片裁成正方形、缩到 256px，压成 JPEG，避免占太多空间。 */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) { reject(new Error('请选择一张图片')); return; }
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight), canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 256, 256);
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      URL.revokeObjectURL(url); resolve(canvas.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图片打不开，换一张试试')); };
    img.src = url;
  });
}
$('pf-file').onchange = async ev => {
  const file = ev.target.files[0]; ev.target.value = ''; if (!file) return;
  try { lastImage = await shrinkImage(file); draft.avatar = {kind: 'image', dataUrl: lastImage}; syncDraft(); say($('pf-note'), '图片已放好，记得点「保存」。'); }
  catch (e) { say($('pf-note'), e.message, 'error'); }
};
$('pf-save').onclick = () => {
  try { profile = B.saveProfile(localStorage, {...draft, nickname: $('pf-nickname').value}); profileBroken = false; updateHome(); say($('pf-note'), '已保存。'); }
  catch (e) { say($('pf-note'), e.message, 'error'); }
};

renderers.settings = () => {
  $('settings-job-note').textContent = state.jobs.length ? state.jobs.map(j => j.name).join('、') : '还没添加';
};
renderers.calendar = () => {};

// ---------- 启动 ----------
window.startBanji = () => {
  B = window.Banji; undoStack = new B.History(20);
  try { repo = new B.LocalRepository(localStorage); state = repo.load(); }
  catch (e) { repo = repo || new B.LocalRepository(localStorage); state = B.emptyState(); showStorageAlert(e.message); }
  try { ({profile, broken: profileBroken} = B.loadProfile(localStorage)); } catch { profile = B.emptyProfile(); }
  window.addEventListener('storage', e => { if (e.key === B.STORAGE_KEY || e.key === B.PAYSLIP_KEY || e.key === B.PROFILE_KEY || e.key === null) reloadFromStorage('另一个页面修改了数据，这里已经同步。'); });
  // 示例版：打开时这台设备还没有数据，就直接装好示例数据（只在示例版页面里，正式版不会这样）
  if (window.BANJI_PREVIEW && !hasOwnData()) { try { state = repo.save(B.demoState(today, nowMin())); } catch { /* 存不下就当空白 */ } }
  runAuto({render: false});
  dayCache.clear(); updateHome({roll: true}); renderCalendar(); updateUndoBar();
};
