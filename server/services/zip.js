/**
 * 极简 ZIP 读写（不依赖第三方库）
 *
 * 用途：备份包需要「数据库快照 + 物料图片 + manifest」放在一个文件里，
 * 而项目没有 zip 依赖。图片与 SQLite 本身已压缩，写入统一用 store（不压缩），
 * 读取则同时支持 store 与 deflate，便于用户用系统工具重新打包后仍能恢复。
 *
 * 安全约束（读取外部上传的 zip 时）：
 *  1. 只接受白名单条目（调用方传入 isAllowed），拒绝绝对路径 / .. / 反斜杠；
 *  2. 单条解压体积、总解压体积都有上限，防 zip bomb；
 *  3. 校验 CRC32 与声明体积，损坏即拒绝；
 *  4. 最多 4096 条，避免中央目录异常。
 */
const fs = require('fs');
const zlib = require('zlib');

const MAX_ENTRIES = 4096;
const MAX_ENTRY_SIZE = 64 * 1024 * 1024;      // 单个条目 64MB（DB 快照通常远小于此）
const MAX_TOTAL_SIZE = 512 * 1024 * 1024;     // 解压总量 512MB

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date: date & 0xFFFF, time: time & 0xFFFF };
}

/**
 * 生成 zip 文件（store 方式，边读边写，避免整包驻留内存）
 * entries: [{ name: 'inventory.db', filePath } | { name, data: Buffer }]
 */
function writeZip(file, entries, opts) {
  if (entries.length > MAX_ENTRIES) throw new Error('备份条目过多');
  const fd = fs.openSync(file, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const e of entries) {
      const data = e.data ? Buffer.from(e.data) : fs.readFileSync(e.filePath);
      const name = Buffer.from(String(e.name), 'utf8');
      const meta = dosDateTime(e.mtime || new Date());
      const crc = crc32(data);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);            // UTF-8 文件名
      local.writeUInt16LE(0, 8);                 // store
      local.writeUInt16LE(meta.time, 10);
      local.writeUInt16LE(meta.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      fs.writeSync(fd, local);
      fs.writeSync(fd, name);
      fs.writeSync(fd, data);

      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(20, 4);
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt16LE(0, 10);
      cen.writeUInt16LE(meta.time, 12);
      cen.writeUInt16LE(meta.date, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(data.length, 20);
      cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(name.length, 28);
      cen.writeUInt16LE(0, 30);
      cen.writeUInt16LE(0, 32);
      cen.writeUInt16LE(0, 34);
      cen.writeUInt16LE(0, 36);
      cen.writeUInt32LE(0, 38);
      cen.writeUInt32LE(offset, 42);
      central.push({ cen, name });
      offset += 30 + name.length + data.length;
    }

    const cdStart = offset;
    central.forEach(c => {
      fs.writeSync(fd, c.cen);
      fs.writeSync(fd, c.name);
      offset += 46 + c.name.length;
    });

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    fs.writeSync(fd, eocd);
  } finally {
    fs.closeSync(fd);
  }
  return opts || {};
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xFFFF);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 读取 zip：返回 [{ name, data, size }]
 * isAllowed(name) 返回 false 的条目直接拒绝（防止路径穿越/意外文件）
 */
function readZip(file, isAllowed) {
  const buf = fs.readFileSync(file);
  if (buf.length < 22) throw new Error('文件不是有效的 ZIP 包（体积过小）');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('文件不是有效的 ZIP 包（未找到目录结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('备份包条目过多，已拒绝');
  if (cdOffset + cdSize > buf.length) throw new Error('ZIP 中央目录越界，文件可能已损坏');

  const entries = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (uncompSize > MAX_ENTRY_SIZE) throw new Error(`备份包内文件过大：${name}`);
    total += uncompSize;
    if (total > MAX_TOTAL_SIZE) throw new Error('备份包解压后体积超限，已拒绝');

    const safe = !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..');
    if (!safe || (typeof isAllowed === 'function' && !isAllowed(name))) {
      throw new Error(`备份包包含不允许的文件：${name}`);
    }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP 条目损坏：${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error(`ZIP 条目越界：${name}`);
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_SIZE }); }
      catch (e) { throw new Error(`ZIP 条目解压失败：${name}`); }
    } else {
      throw new Error(`不支持的压缩方式（${method}）：${name}`);
    }
    if (data.length !== uncompSize) throw new Error(`ZIP 条目体积不符：${name}`);
    if (crc32(data) !== crc) throw new Error(`ZIP 条目校验失败（CRC32）：${name}`);
    entries.push({ name, data, size: data.length });
  }
  return entries;
}

module.exports = { writeZip, readZip, crc32 };
