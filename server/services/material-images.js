/**
 * 物料参考图片文件管理
 *
 * 约定：
 *  1. 图片存文件系统，不进数据库；目录固定为项目内 uploads/materials/
 *  2. 文件名只用物料自增 id（<id>.<ext>），不用编码 —— 编码允许修改，图片不能因此失效
 *  3. materials.image_path 只存相对路径 materials/<id>.<ext>，image_updated_at 存更新时间
 *  4. 类型按魔数判断，不信任扩展名 / Content-Type
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'uploads');
const DIR = path.join(ROOT, 'materials');
const REL_PREFIX = 'materials/';
const MAX_BYTES = 300 * 1024;
const ALLOWED_EXT = ['jpg', 'png', 'webp'];

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

// 按魔数识别图片类型；只接受 JPEG / PNG / WebP（SVG 可带脚本，直接拒绝）
function detect(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

function relOf(id, ext) {
  return REL_PREFIX + id + '.' + ext;
}

function absOf(rel) {
  const name = path.basename(String(rel || ''));
  return path.join(DIR, name);
}

// 删除某物料的全部后缀文件（替换图片时旧后缀可能不同）
function deleteImageFiles(id) {
  ensureDir();
  let removed = 0;
  ALLOWED_EXT.forEach(ext => {
    try {
      fs.rmSync(path.join(DIR, id + '.' + ext), { force: true });
      removed++;
    } catch (e) { /* 文件不存在或无权限时忽略 */ }
  });
  return removed;
}

// 保存（替换）图片：先清理旧文件，再写入新文件，返回相对路径
function saveImage(id, buf, ext) {
  ensureDir();
  ALLOWED_EXT.forEach(e => {
    if (e !== ext) fs.rmSync(path.join(DIR, id + '.' + e), { force: true });
  });
  fs.writeFileSync(path.join(DIR, id + '.' + ext), buf);
  return relOf(id, ext);
}

function readImage(rel) {
  if (!isSafeRel(rel)) return null;
  try { return fs.readFileSync(absOf(rel)); } catch (e) { return null; }
}

function isSafeRel(rel) {
  const s = String(rel || '');
  if (!s.startsWith(REL_PREFIX)) return false;
  const name = s.slice(REL_PREFIX.length);
  return /^\d+\.(jpg|png|webp)$/.test(name);
}

// 列出目录内全部物料图片（只认 <数字>.<jpg|png|webp>）
function listFiles() {
  ensureDir();
  return fs.readdirSync(DIR)
    .filter(n => /^\d+\.(jpg|png|webp)$/.test(n))
    .map(n => {
      const abs = path.join(DIR, n);
      const stat = fs.statSync(abs);
      return { name: n, rel: REL_PREFIX + n, abs, size: stat.size, mtime: stat.mtime };
    });
}

// 清空目录（旧 .db 备份恢复时使用：备份里没有图片，避免旧图错配到新数据）
function clearImages() {
  ensureDir();
  let n = 0;
  fs.readdirSync(DIR).forEach(name => {
    const abs = path.join(DIR, name);
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) { fs.rmSync(abs, { force: true }); n++; }
    } catch (e) { /* 忽略单个文件异常 */ }
  });
  return n;
}

module.exports = {
  ROOT, DIR, REL_PREFIX, MAX_BYTES, ALLOWED_EXT,
  ensureDir, detect, saveImage, deleteImageFiles, readImage, isSafeRel, listFiles, clearImages, absOf,
};
