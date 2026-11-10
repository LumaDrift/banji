// Remove long table rules so the OCR engine can read dates rather than grid lines.
export function removeTableRules(canvas){
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const {width:w,height:h}=canvas,im=ctx.getImageData(0,0,w,h),d=im.data;
  const rows=new Uint32Array(h),cols=new Uint32Array(w);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const p=(y*w+x)*4;
    if((d[p]+d[p+1]+d[p+2])/3<180){rows[y]++;cols[x]++;}
  }
  ctx.fillStyle='white';
  for(let y=0;y<h;y++)if(rows[y]>w*.55)ctx.fillRect(0,Math.max(0,y-2),w,5);
  for(let x=0;x<w;x++)if(cols[x]>h*.4)ctx.fillRect(Math.max(0,x-2),0,5,h);
  return canvas;
}
let scriptPromise;
function loadOCR(){
  scriptPromise ||= new Promise((resolve,reject)=>{
    const s=document.createElement('script');s.src=new URL('./vendor/tesseract.min.js',import.meta.url).href;
    s.onload=resolve;s.onerror=()=>{scriptPromise=null;reject(Error('OCR 组件加载失败，请检查网络后重试。'));};document.head.append(s);
  });return scriptPromise;
}
export async function createLocalOCR(report){
  await loadOCR();
  const worker=await window.Tesseract.createWorker('eng',1,{
    workerPath:new URL('./vendor/worker.min.js',import.meta.url).href,
    corePath:new URL('./vendor/tesseract-core-lstm.wasm.js',import.meta.url).href,
    langPath:new URL('./vendor/',import.meta.url).href,
    workerBlobURL:false,cacheMethod:'none',
    logger:m=>{if(m.status==='recognizing text')report(`识别图片文字 ${Math.round(m.progress*100)}%`);}
  });
  await worker.setParameters({tessedit_pageseg_mode:'6',preserve_interword_spaces:'1'});
  return worker;
}
export async function recognizePage(page,worker){
  const initial=page.getViewport({scale:2});
  const scale=Math.min(2,Math.sqrt(12000000/(initial.width*initial.height))*2);
  const viewport=page.getViewport({scale});const canvas=document.createElement('canvas');
  canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  try{
    await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    removeTableRules(canvas);
    const {data}=await worker.recognize(canvas);return data.text;
  }finally{canvas.width=canvas.height=0;}
}
