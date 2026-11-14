/**
 * 备份包（.zip）：数据库一致性快照 + 物料图片 + manifest
 *
 * 包内结构：
 *   inventory.db                  VACUUM INTO 生成的一致性快照
 *   uploads/materials/<id>.<ext>  物料参考图片
 *   manifest.json                 { format, version, created_at, db:{size,sha256}, images:[{path,size,sha256}] }
 *
 * 兼容性策略（有意收窄）：
 *  - 只保证读回本系统写出的包；manifest 是必需项，缺失或格式不符直接拒绝；
 *  - ZIP 解压本身支持 store / deflate（zlib），但条目白名单固定为上述三类。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { writeZip, readZip } = require('./zip');
const images = require('./material-images');

const FORMAT = 'warehouse-backup';
const VERSION = 1;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isZipBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B
    && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

function imageEntryName(fileName) {
  return 'uploads/materials/' + fileName;
}

/**
 * 生成备份包
 * @param {string} dest 目标 .zip 路径（不存在）
 * @returns {{ file: string, dbSize: number, imageCount: number }}
 */
function createPackage(dest) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whbak-'));
  const dbTmp = path.join(tmpDir, 'inventory.db');
  try {
    db.prepare('VACUUM INTO ?').run(dbTmp);
    const dbBuf = fs.readFileSync(dbTmp);
    const files = images.listFiles();
    const manifest = {
      format: FORMAT,
      version: VERSION,
      created_at: new Date().toISOString(),
      db: { path: 'inventory.db', size: dbBuf.length, sha256: sha256(dbBuf) },
      images: files.map(f => ({
        path: imageEntryName(f.name),
        size: f.size,
        sha256: sha256(fs.readFileSync(f.abs)),
      })),
    };
    const entries = [
      { name: 'inventory.db', data: dbBuf },
      ...files.map(f => ({ name: imageEntryName(f.name), filePath: f.abs, mtime: f.mtime })),
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    ];
    writeZip(dest, entries);
    return { file: dest, dbSize: dbBuf.length, imageCount: files.length };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 解包到临时目录并做完整性校验
 * @param {string} file 上传的 .zip 路径
 * @param {string} workDir 解包目录（调用方负责清理）
 * @returns {{ dbFile: string, images: Array<{name,file,size}>, manifest: object }}
 */
function readPackage(file, workDir) {
  const allowed = name => name === 'inventory.db' || name === 'manifest.json'
    || /^uploads\/materials\/\d+\.(jpg|png|webp)$/.test(name);
  let entries;
  try { entries = readZip(file, allowed); }
  catch (e) {
    const err = new Error(e.message);
    err.code = 'INVALID_BACKUP';
    throw err;
  }

  const manifestEntry = entries.find(e => e.name === 'manifest.json');
  if (!manifestEntry) {
    const err = new Error('备份包缺少 manifest.json，无法确认是本系统的备份');
    err.code = 'INVALID_BACKUP';
    throw err;
  }
  let manifest;
  try { manifest = JSON.parse(manifestEntry.data.toString('utf8')); }
  catch (e) {
    const err = new Error('备份包 manifest.json 损坏');
    err.code = 'INVALID_BACKUP';
    throw err;
  }
  if (!manifest || manifest.format !== FORMAT || Number(manifest.version) !== VERSION) {
    const err = new Error('备份包格式或版本不受支持');
    err.code = 'INVALID_BACKUP';
    throw err;
  }

  const dbEntry = entries.find(e => e.name === 'inventory.db');
  if (!dbEntry) {
    const err = new Error('备份包缺少 inventory.db');
    err.code = 'INVALID_BACKUP';
    throw err;
  }
  if (!manifest.db || manifest.db.sha256 !== sha256(dbEntry.data)) {
    const err = new Error('备份包中的数据库校验失败（sha256 不匹配），文件可能已损坏');
    err.code = 'INVALID_BACKUP';
    throw err;
  }

  fs.mkdirSync(path.join(workDir, 'materials'), { recursive: true });
  const dbFile = path.join(workDir, 'inventory.db');
  fs.writeFileSync(dbFile, dbEntry.data);

  const out = [];
  const byPath = new Map((manifest.images || []).map(i => [i.path, i]));
  entries.filter(e => e.name.startsWith('uploads/materials/')).forEach(e => {
    const meta = byPath.get(e.name);
    if (!meta) return; // manifest 未声明的条目忽略
    if (sha256(e.data) !== meta.sha256) {
      const err = new Error(`图片校验失败（sha256 不匹配）：${e.name}`);
      err.code = 'INVALID_BACKUP';
      throw err;
    }
    const info = images.detect(e.data);
    if (!info) {
      const err = new Error(`备份包内图片类型非法：${e.name}`);
      err.code = 'INVALID_BACKUP';
      throw err;
    }
    if (e.data.length > images.MAX_BYTES) {
      const err = new Error(`备份包内图片超过 300KB：${e.name}`);
      err.code = 'INVALID_BACKUP';
      throw err;
    }
    const name = path.basename(e.name);
    const abs = path.join(workDir, 'materials', name);
    fs.writeFileSync(abs, e.data);
    out.push({ name, rel: images.REL_PREFIX + name, file: abs, size: e.data.length });
  });

  return { dbFile, images: out, manifest };
}

module.exports = { FORMAT, VERSION, createPackage, readPackage, isZipBuffer, sha256 };
