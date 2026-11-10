// 撤销上一步：每次保存成功前把旧状态记下来，撤销时取回上一份。
// 只保存在当前页面的内存里（刷新后清空），不写存储。
// 用法：
//   const history = new History();
//   history.record(oldState, '记上班');      // 修改前调用
//   repo.save(newState);
//   ...
//   const last = history.undo();             // { state, label } 或 null
//   if (last) repo.save(last.state);         // 撤销本身也走正常保存与校验

export class History {
  constructor(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('撤销步数无效');
    this.limit = limit;
    this.items = [];
  }
  record(previousState, label) {
    if (typeof label !== 'string' || !label) throw new Error('请写明这一步做了什么');
    this.items.push({state: structuredClone(previousState), label});
    if (this.items.length > this.limit) this.items.shift();
  }
  get canUndo() { return this.items.length > 0; }
  /** 下一次撤销会撤回什么，例如「记上班」；没有可撤销的返回 null。 */
  get nextLabel() { return this.items.at(-1)?.label ?? null; }
  undo() { return this.items.pop() ?? null; }
  /** 撤销后保存失败时，把这一步放回去。 */
  restore(item) { if (item) this.items.push(item); }
  clear() { this.items = []; }
}
