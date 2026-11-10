// Tesseract 后台线程的小垫片：网页托管不能直接提供 eng.traineddata.gz，
// 所以当识别引擎要这个文件时，改从打包好的 payroll/packs/eng-traineddata.json 取出同样的字节给它。
// 其它请求照常；识别引擎（vendor/worker.min.js）本身不改。
const realFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (/\/eng\.traineddata(\.gz)?$/.test(url.split('?')[0])) {
    const r = await realFetch(new URL('./packs/eng-traineddata.json', self.location.href).href);
    if (!r.ok) return r;
    const {gz} = await r.json();
    return new Response(Uint8Array.from(atob(gz), c => c.charCodeAt(0)), {status: 200, headers: {'Content-Type': 'application/octet-stream'}});
  }
  return realFetch(input, init);
};
importScripts(new URL('./vendor/worker.min.js', self.location.href).href);
