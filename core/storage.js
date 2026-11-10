import {emptyState,validateState} from './domain.js?v=62be305706';
export const STORAGE_KEY='banji.attendance.v1';
export class LocalRepository {
  constructor(storage) { this.storage=storage; this.last=null; this.blocked=false; }
  load() {
    try { this.storage??=globalThis.localStorage; this.last=this.storage.getItem(STORAGE_KEY); return this.last===null?emptyState():validateState(JSON.parse(this.last)); }
    catch(e) { this.blocked=true; throw new Error('无法读取本地数据，已停止写入以保护原数据。请导出原始数据备查或使用备份恢复。'+e.message); }
  }
  save(state,{recovery=false}={}) {
    if(this.blocked&&!recovery) throw new Error('本地数据读取异常，请先恢复有效备份');
    const clean=validateState(state), text=JSON.stringify(clean);
    try {
      if(this.storage.getItem(STORAGE_KEY)!==this.last) throw new Error('其他标签页已修改数据，请刷新后重试');
      this.storage.setItem(STORAGE_KEY,text);
      if(this.storage.getItem(STORAGE_KEY)!==text) throw new Error('写入后校验失败');
    } catch(e) { throw new Error('保存失败，未更新页面：'+e.message); }
    this.last=text; this.blocked=false; return clean;
  }
  raw() { return this.storage.getItem(STORAGE_KEY)??''; }
}
