// 把底层模块交给界面脚本（app.js 是普通脚本，函数是全局的，方便日历回归测试检查）。
import * as domain from './core/domain.js?v=62be305706';
import * as views from './core/views.js?v=62be305706'; import {validatePayCycle} from './core/periods.js?v=62be305706'; import {holidayOn, holidaysOfYear} from './core/holidays.js?v=62be305706'; import {demoState} from './core/demo.js?v=62be305706';
import {History} from './core/history.js?v=62be305706'; import * as auto from './core/auto.js?v=62be305706';
import * as backup from './core/backup.js?v=62be305706';
import * as importer from './core/import.js?v=62be305706';
import * as profileMod from './core/profile.js?v=62be305706';
import {LocalRepository, STORAGE_KEY} from './core/storage.js?v=62be305706';
import {spanMinutes, addDays, daysBetween, weekdayOf} from './core/dates.js?v=62be305706';

window.Banji = Object.freeze({...domain, ...auto, ...views, History, ...backup, ...importer, ...profileMod, LocalRepository, STORAGE_KEY, validatePayCycle, holidayOn, holidaysOfYear, demoState, spanMinutes, addDays, daysBetween, weekdayOf});
window.startBanji();
