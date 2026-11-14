/**
 * 自动覆盖式备份
 *
 * 设计要点：
 *  1. 频率由管理员在「参数设置」里选择：每小时 / 每天 / 每周（每天、每周可指定具体时刻，每周可指定星期）。
 *  2. 每次执行都覆盖同一份文件 backups/auto-backup-latest.zip，只保留最新一份，
 *     不产生历史备份堆积；危险操作（清库 / 恢复）前的临时备份仍走 settings-ops.js 的时间戳命名。
 *  3. 设置存在 params 表（key = auto_backup），重启后仍然生效；
 *     同时记录 last_run_at（毫秒时间戳），重启后若发现已过期会立即补一次。
 *  4. 备份包与手动下载一致：数据库快照 + 物料图片 + manifest，先写 .tmp 再改名替换，
 *     避免写入中途留下半个文件。旧版本留下的 auto-backup-latest.db 不会被自动删除。
 *  5. 定时任务由 server.js 启动时调用 start() 注册，进程内单实例。
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const audit = require('./audit');
const backupPackage = require('./backup-package');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const FILE_NAME = 'auto-backup-latest.zip';
const PARAM_KEY = 'auto_backup';
const TICK_MS = 30 * 1000;

const MODES = ['hourly', 'daily', 'weekly'];
// 一周从周日开始，与前端下拉顺序一致
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

const DEFAULTS = {
  enabled: false,
  mode: 'daily',
  hour: 2,
  minute: 0,
  weekday: 1,
  last_run_at: 0,
  last_error: '',
};

function targetFile() {
  return path.join(BACKUP_DIR, FILE_NAME);
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

// 读取设置：任何字段非法都回落默认值，配置损坏不影响系统启动
function read() {
  let saved = {};
  try {
    const row = db.prepare('SELECT value FROM params WHERE key=?').get(PARAM_KEY);
    if (row && row.value) saved = JSON.parse(row.value) || {};
  } catch (e) { /* 配置损坏时用默认值 */ }
  return {
    enabled: !!saved.enabled,
    mode: MODES.includes(saved.mode) ? saved.mode : DEFAULTS.mode,
    hour: clampInt(saved.hour, 0, 23, DEFAULTS.hour),
    minute: clampInt(saved.minute, 0, 59, DEFAULTS.minute),
    weekday: WEEKDAYS.includes(Number(saved.weekday)) ? Number(saved.weekday) : DEFAULTS.weekday,
    last_run_at: clampInt(saved.last_run_at, 0, Number.MAX_SAFE_INTEGER, 0),
    last_error: typeof saved.last_error === 'string' ? saved.last_error : '',
  };
}

function write(next) {
  const s = { ...read(), ...next };
  db.prepare(`INSERT INTO params (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(PARAM_KEY, JSON.stringify(s));
  return s;
}

// 由前端提交的字段更新设置（只接受白名单字段）
function save(input) {
  const patch = {};
  if (input.enabled !== undefined) patch.enabled = !!input.enabled;
  if (input.mode !== undefined) {
    if (!MODES.includes(input.mode)) {
      const e = new Error('备份频率无效'); e.en = 'Invalid backup frequency'; e.invalid = true; throw e;
    }
    patch.mode = input.mode;
  }
  if (input.hour !== undefined) patch.hour = clampInt(input.hour, 0, 23, DEFAULTS.hour);
  if (input.minute !== undefined) patch.minute = clampInt(input.minute, 0, 59, DEFAULTS.minute);
  if (input.weekday !== undefined) {
    const wd = Number(input.weekday);
    if (!WEEKDAYS.includes(wd)) {
      const e = new Error('星期取值无效'); e.en = 'Invalid day of week'; e.invalid = true; throw e;
    }
    patch.weekday = wd;
  }
  return write(patch);
}

// 下一次应执行的时刻（毫秒）；未启用时返回 0
function nextRunAt(s, from) {
  if (!s.enabled) return 0;
  const base = from || Date.now();
  if (s.mode === 'hourly') {
    const anchor = s.last_run_at || base;
    return anchor + 3600 * 1000 > base ? anchor + 3600 * 1000 : base;
  }
  // daily / weekly：按「本地时刻」匹配
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const d = new Date(base);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(s.hour, s.minute, 0, 0);
    if (d.getTime() <= base) continue;
    if (s.mode === 'weekly' && d.getDay() !== s.weekday) continue;
    return d.getTime();
  }
  return 0;
}

// 是否到了执行时刻：
//  - hourly：距上次执行满 1 小时（没执行过则立即执行）
//  - daily：今天的 HH:MM 已过，且上次执行早于今天的 HH:MM
//  - weekly：今天是选定星期且满足上面同一条
function isDue(s, now) {
  if (!s.enabled) return false;
  const t = now || Date.now();
  if (s.mode === 'hourly') return !s.last_run_at || t - s.last_run_at >= 3600 * 1000;
  const target = new Date(t);
  target.setHours(s.hour, s.minute, 0, 0);
  if (s.mode === 'weekly' && target.getDay() !== s.weekday) return false;
  if (t < target.getTime()) return false;
  return !s.last_run_at || s.last_run_at < target.getTime();
}

// 执行一次覆盖式备份，返回 { file, size, at }
function runNow() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = targetFile();
  const tmp = dest + '.tmp';
  try {
    fs.rmSync(tmp, { force: true });
    // 与手动备份同一打包器：DB 快照 + 物料图片 + manifest
    backupPackage.createPackage(tmp);
    fs.renameSync(tmp, dest);
    const stat = fs.statSync(dest);
    const at = Date.now();
    write({ last_run_at: at, last_error: '' });
    return { file: FILE_NAME, size: stat.size, at };
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    write({ last_error: String(e.message || e) });
    throw e;
  }
}

// 供设置页展示的状态
function status() {
  const s = read();
  let exists = false; let size = 0; let mtime = 0;
  try {
    const stat = fs.statSync(targetFile());
    exists = true; size = stat.size; mtime = stat.mtimeMs;
  } catch (e) { /* 尚未生成 */ }
  return {
    enabled: s.enabled,
    mode: s.mode,
    hour: s.hour,
    minute: s.minute,
    weekday: s.weekday,
    lastRunAt: s.last_run_at || 0,
    lastError: s.last_error || '',
    file: FILE_NAME,
    exists,
    size,
    mtime,
    nextRunAt: nextRunAt(s),
  };
}

let timer = null;
let running = false;

function tick() {
  if (running) return;
  let s;
  try { s = read(); } catch (e) { return; }
  if (!isDue(s)) return;
  running = true;
  try {
    const r = runNow();
    audit.record({
      username: 'system', name: 'system', role: 'system', module: 'settings', action: 'auto-backup',
      target: r.file, method: 'AUTO', path: '/api/settings/backup/auto',
      status: 200, detail: { key: 'audit_detail_auto_backup', params: { file: r.file } },
    });
    console.log(`自动备份完成: ${r.file} (${r.size} bytes)`);
  } catch (e) {
    console.error('自动备份失败:', e.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  // 启动后先判一次：停机期间错过的周期立即补上
  setTimeout(tick, 3 * 1000);
}

module.exports = { read, save, runNow, status, nextRunAt, isDue, start };
