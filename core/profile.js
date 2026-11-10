// 个人资料：昵称、头像。和考勤数据分开存（banji.profile.v1），只在这台设备的浏览器里。
//   avatar 二选一：
//     { kind:'animal', animal:'cat', color:'mint' }       自己拼的卡通小动物
//     { kind:'image', dataUrl:'data:image/jpeg;base64,…' } 用户上传的图片（界面先压缩到 256px）

export const PROFILE_KEY = 'banji.profile.v1';
export const ANIMALS = ['cat', 'dog', 'rabbit', 'bear', 'panda', 'fox', 'frog', 'chick'];
export const AVATAR_COLORS = ['mint', 'sky', 'peach', 'lemon', 'lilac', 'sand'];
const MAX_IMAGE = 400 * 1024;
const fail = m => { throw new Error(m); };

export const emptyProfile = () => ({version: 1, nickname: '', workplace: '', avatar: {kind: 'animal', animal: 'cat', color: 'mint'}});

export function validateProfile(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== 1) fail('个人资料格式不支持');
  const text = (v, max, what) => { if (v === undefined) return ''; if (typeof v !== 'string' || v.trim().length > max) fail(`${what}最多 ${max} 个字`); return v.trim(); };
  const a = raw.avatar;
  let avatar;
  if (a?.kind === 'animal') {
    if (!ANIMALS.includes(a.animal) || !AVATAR_COLORS.includes(a.color)) fail('头像设置无效');
    avatar = {kind: 'animal', animal: a.animal, color: a.color};
  } else if (a?.kind === 'image') {
    if (typeof a.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(a.dataUrl) || a.dataUrl.length > MAX_IMAGE) fail('头像图片无效或太大');
    avatar = {kind: 'image', dataUrl: a.dataUrl};
  } else fail('头像设置无效');
  return {version: 1, nickname: text(raw.nickname, 20, '昵称'), workplace: text(raw.workplace, 30, '工作单位'), avatar};
}

/** 读取资料；没有或损坏时返回默认资料并标记 broken，不覆盖原数据。 */
export function loadProfile(storage) {
  try {
    const raw = storage.getItem(PROFILE_KEY);
    return raw === null ? {profile: emptyProfile(), broken: false} : {profile: validateProfile(JSON.parse(raw)), broken: false};
  } catch { return {profile: emptyProfile(), broken: true}; }
}

export function saveProfile(storage, profile) {
  const clean = validateProfile(profile), text = JSON.stringify(clean);
  try { storage.setItem(PROFILE_KEY, text); if (storage.getItem(PROFILE_KEY) !== text) throw new Error('写入后校验失败'); }
  catch (e) { fail('保存失败：' + e.message + '（图片太大时可以换一张小一点的）'); }
  return clean;
}
