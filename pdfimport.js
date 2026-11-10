// 把原来「工资单与发薪日历识别」页的读取流程接到 App 里。识别规则（payroll/parser.mjs）和本机 OCR（payroll/ocr.mjs）原样复用；
// 这里只负责：读 PDF → 每页取文字（扫描页自动 OCR）→ 判断是发薪日历还是单份工资单 → 交给界面核对。文件不会上传。
import {textFromItems, parsePayslip, parsePayrollCalendar} from './payroll/parser.mjs?v=62be305706';
import {recognizePage, removeTableRules} from './payroll/ocr.mjs?v=62be305706';
import {englishPayslip} from './payslip-en.js?v=62be305706';

let pdfModule = null;

// 网页托管不能直接提供 .bcmap/.pfb/.gz 文件，所以打包成 JSON（tools/make_packs.py），在内存里交给 pdf.js 和 Tesseract。
const packs = {};
function pack(name) {
  packs[name] ||= fetch(new URL(`./payroll/packs/${name}.json`, import.meta.url)).then(r => { if (!r.ok) throw new Error('识别组件加载失败，请检查网络后重试。'); return r.json(); }).catch(e => { delete packs[name]; throw e; });
  return packs[name];
}
const bytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
/** pdf.js 读中文等字体映射时调用（接口与 pdf.js 自带的一样：fetch({name}) → {cMapData, isCompressed}）。 */
class PackedCMapReaderFactory {
  async fetch({name}) {
    const all = await pack('cmaps');
    if (!all[name]) throw new Error(`Unable to load CMap ${name}`);
    return {cMapData: bytes(all[name]), isCompressed: true};
  }
}
/** pdf.js 需要标准字体时调用（fetch({filename}) → Uint8Array）。 */
class PackedStandardFontDataFactory {
  async fetch({filename}) {
    const all = await pack('fonts');
    if (!all[filename]) throw new Error(`Unable to load font data ${filename}`);
    return bytes(all[filename]);
  }
}
/** 本机 OCR：设置和原识别页的 createLocalOCR 一样；只是后台线程先经过 ocr-worker-shim.js，语言包从打包的 JSON 里取。 */
let ocrScript = null;
async function createOCR(report) {
  ocrScript ||= new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = new URL('./payroll/vendor/tesseract.min.js', import.meta.url).href;
    s.onload = resolve; s.onerror = () => { ocrScript = null; reject(new Error('OCR 组件加载失败，请检查网络后重试。')); }; document.head.append(s);
  });
  await ocrScript;
  const worker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: new URL('./payroll/ocr-worker-shim.js', import.meta.url).href,
    corePath: new URL('./payroll/vendor/tesseract-core-lstm.wasm.js', import.meta.url).href,
    langPath: new URL('./payroll/packs/', import.meta.url).href,
    workerBlobURL: false, cacheMethod: 'none',
    logger: m => { if (m.status === 'recognizing text') report(`识别图片文字 ${Math.round(m.progress * 100)}%`); }
  });
  await worker.setParameters({tessedit_pageseg_mode: '6', preserve_interword_spaces: '1'});
  return worker;
}

/** 读一个 PDF，返回全部文字。report(message) 用来显示进度。步骤与原识别页相同：最多 30 页，扫描页最多 5 页。 */
export async function pdfText(file, report = () => {}) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('请选择 PDF 文件');
  if (file.size > 20 * 1024 * 1024) throw new Error('PDF 不能超过 20 MB');
  const buffer = await file.arrayBuffer();
  if (!new TextDecoder().decode(buffer.slice(0, 1024)).includes('%PDF-')) throw new Error('文件内容不是有效 PDF，请重新导出。');
  report('正在读取 PDF，文件不会上传……');
  pdfModule ||= await import('./payroll/vendor/pdf.mjs');
  pdfModule.GlobalWorkerOptions.workerSrc = new URL('./payroll/vendor/pdf.worker.mjs', import.meta.url).href;
  let doc, ocr, ocrPages = 0, emptyPages = 0;
  try {
    doc = await pdfModule.getDocument({data: new Uint8Array(buffer), cMapUrl: new URL('./payroll/packs/', import.meta.url).href, cMapPacked: true, standardFontDataUrl: new URL('./payroll/packs/', import.meta.url).href, CMapReaderFactory: PackedCMapReaderFactory, StandardFontDataFactory: PackedStandardFontDataFactory, isEvalSupported: false, enableXfa: false}).promise;
    if (doc.numPages > 30) throw new Error('文件超过 30 页，请只导出需要的那几页后再试。');
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      report(`正在读取第 ${n} / ${doc.numPages} 页……`);
      const page = await doc.getPage(n), content = await page.getTextContent();
      let text = textFromItems(content.items);
      if (text.replace(/\s/g, '').length < 10) {
        if (++ocrPages > 5) throw new Error('扫描页超过 5 页，请拆开后再上传。');
        report(`第 ${n} 页是图片，正在用本机识别文字（第一次可能要几十秒，请别关页面）……`);
        ocr ||= await createOCR(m => report(`第 ${n} 页：${m}`));
        text = await recognizePage(page, ocr);
        if (text.replace(/\s/g, '').length < 10) emptyPages++;
      }
      pages.push(text); page.cleanup();
    }
    const all = pages.join('\n\n');
    if (!all.trim() || emptyPages === doc.numPages) throw new Error('没有识别出足够的文字。请换一个更清晰的 PDF，或者把文字粘贴进来。扫描图片目前只认英文和数字。');
    return {text: all, emptyPages, pages: doc.numPages};
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error('这是加密 PDF，请先在手机或电脑上去掉密码再上传。');
    throw e;
  } finally {
    try { await ocr?.terminate(); await doc?.destroy(); } catch { /* 忽略清理错误 */ }
  }
}

/** 读一张照片或截图（发薪日历、工资单），用同一个本机 OCR 取出文字。只认英文和数字。 */
export async function imageText(file, report = () => {}) {
  if (file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB');
  report('正在读取图片，文件不会上传……');
  let bmp, ocr; const canvas = document.createElement('canvas');
  try {
    try { bmp = await createImageBitmap(file); } catch { throw new Error('这张图片打不开。请换成 JPG 或 PNG（苹果手机的 HEIC 照片可以先截个图再选）。'); }
    // 太小的放大、太大的缩小，让字的大小落在 OCR 认得清的范围
    const scale = Math.min(Math.sqrt(12000000 / (bmp.width * bmp.height)), Math.max(1, 1800 / Math.max(bmp.width, bmp.height)));
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d', {willReadFrequently: true}); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    removeTableRules(canvas);
    report('正在用本机识别图片上的文字（第一次可能要几十秒，请别关页面）……');
    ocr = await createOCR(report);
    const {data} = await ocr.recognize(canvas);
    if (data.text.replace(/\s/g, '').length < 10) throw new Error('没有从图片里认出足够的文字。请拍正、拍清楚一点再试，或者把文字粘贴进来。图片目前只认英文和数字。');
    return {text: data.text, emptyPages: 0, pages: 1};
  } finally { bmp?.close?.(); canvas.width = canvas.height = 0; try { await ocr?.terminate(); } catch { /* 忽略 */ } }
}

/** 识别一段文字：发薪日历（多期）或单份工资单。 */
export function recognize(text) {
  const calendar = parsePayrollCalendar(text);
  if (calendar) return {kind: 'calendar', ...calendar};
  const r = parsePayslip(text);
  // 中文字段没找到的，再按英文工资单的写法找一遍（Pay Period / Pay Date / Net Pay / Gross Pay）
  if (!r.multi) { const en = englishPayslip(text); for (const k of Object.keys(en)) if (r.fields[k]?.status === 'missing') r.fields[k] = en[k]; }
  return {kind: 'payslip', fields: r.fields, warnings: r.warnings, multi: r.multi};
}
