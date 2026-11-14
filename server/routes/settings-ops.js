/**
 * 设置页运维接口 —— 数据备份 / 恢复 / 清库
 *
 * 接口：
 *   GET  /api/settings/backup/download        生成一致性快照（含图片）并下载 .zip
 *   POST /api/settings/backup/restore         上传 .zip（新）或 .db（旧）备份并恢复
 *   GET  /api/settings/backup/auto            读取自动覆盖式备份的设置与最近状态
 *   PUT  /api/settings/backup/auto            保存自动备份设置（每小时 / 每天 / 每周）
 *   POST /api/settings/backup/auto/run        立即执行一次自动备份（覆盖同一份文件）
 *   POST /api/settings/data/clear-business    只清业务数据（保留基础档案）
 *   POST /api/settings/data/reset             全清并重建默认管理员
 *
 * 安全约定：
 *  1. 以上接口都要求管理员角色，非管理员一律 403（不仅靠前端隐藏按钮）
 *  2. 清库与恢复必须带固定确认短语，短语不符直接拒绝
 *  3. 清库与恢复前先把当前库快照到 backups/，响应返回备份文件名
 *  4. 审计：本文件路由自行写审计（含备份文件名），middleware/audit.js 跳过 /api/settings/*
 *     清库会清掉 audit_logs，所以采用「清空/恢复完成后再写入一条审计记录」的方式，
 *     备份文件名写进 detail，日志在系统日志页仍然可见。
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db');
const audit = require('../services/audit');
const costing = require('../services/costing');
const autoBackupSvc = require('../services/auto-backup');
const backupPackage = require('../services/backup-package');
const materialImages = require('../services/material-images');
const { seedGrants } = require('../services/user-permissions');
const { INITIAL_ADMIN_USERNAME, INITIAL_ADMIN_PASSWORD } = require('../config');

const router = express.Router();

// 备份目录默认在项目根目录 backups/（已加入 .gitignore）；BACKUP_DIR 可用于部署/测试时改路径
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');

// 只清业务数据要清空的表（保留物料/供应商/用户/参数/类别/单位/去向词库）
// 库存流水/结存/重算日志属于业务数据，必须一起清，否则会残留「幽灵库存」
const BUSINESS_TABLES = [
  'order_lines', 'stocktake_lines', 'stocktake_logs', 'stock_adjustments',
  'inbound', 'outbound', 'inbound_doc_logs', 'outbound_doc_logs',
  'inbound_docs', 'outbound_docs', 'purchase_orders', 'stocktakes', 'contracts',
  'inventory_recalc_logs', 'stock_ledger', 'stock_balance', 'cost_variances',
  'audit_logs',
];
// 全清时额外删除的业务档案
// 用户级权限（user_permissions / user_perm_state）以 users 为父表，这里显式先删，
// 不依赖 ON DELETE CASCADE：即使某次连接上 foreign_keys 被临时关掉，也不会留下
// 指向已删除用户的孤儿授权行（否则重建用户后可能继承上一个用户的权限）。
const ARCHIVE_TABLES = ['materials', 'suppliers', 'users'];
const USER_PERM_TABLES = ['user_permissions', 'user_perm_state'];
// 登录会话（单终端登录）是运行时状态，同样以 users 为父表，先于 users 删除
const SESSION_TABLES = ['user_sessions'];

// 判断「是不是本系统的库」的关键表（含成本重构后的流水/余额表）
const CORE_TABLES = [
  'params', 'materials', 'suppliers', 'users', 'inbound', 'outbound',
  'inbound_docs', 'outbound_docs', 'purchase_orders', 'order_lines', 'audit_logs',
  'stock_ledger', 'stock_balance', 'inventory_recalc_logs',
];

const CONFIRM_PHRASES = {
  restore: '恢复',
  clearBusiness: '清空',
  reset: '全部清空',
};

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(withSeconds) {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
    + (withSeconds ? pad(d.getSeconds()) : '');
}

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// 危险操作前自动备份当前库（含物料图片），返回文件名（展示给用户）
// 同一秒内可能连续触发两次（例如连续恢复），文件名按秒生成会撞车，这里顺延编号避免失败。
function autoBackup(prefix) {
  ensureBackupDir();
  const base = `${prefix}-${stamp(true)}`;
  let name = `${base}.zip`;
  for (let i = 1; fs.existsSync(path.join(BACKUP_DIR, name)); i++) name = `${base}-${i}.zip`;
  backupPackage.createPackage(path.join(BACKUP_DIR, name));
  return name;
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可执行该操作', code: 'FORBIDDEN' });
  }
  next();
}

function recordOp(req, action, detail) {
  const u = req.user || {};
  audit.record({
    user_id: u.id || null,
    username: u.username || '',
    name: u.name || '',
    role: u.role || '',
    module: 'settings',
    action,
    target: '',
    method: req.method,
    path: req.originalUrl.split('?')[0],
    ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
    status: 200,
    detail,
  });
}

function confirmMismatch(res) {
  return res.status(400).json({
    error: '确认短语不正确，操作未执行',
    error_en: 'The confirmation phrase is incorrect; nothing was executed',
    code: 'CONFIRM_MISMATCH',
  });
}

// 表名/列名统一用双引号包裹，避免关键字问题
function q(identifier) {
  return '"' + String(identifier).replace(/"/g, '""') + '"';
}

function tablesOf(schema) {
  return db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all().map(r => r.name);
}

function columnsOf(schema, table) {
  return db.prepare(`PRAGMA ${schema}.table_xinfo(${q(table)})`).all();
}

// 「结构一致」的判定标准（三项全过才允许恢复）：
//   1. 表集合完全相同：备份里不能少表，也不能多出当前版本没有的表；
//   2. 每张表的列名集合完全相同（含生成列，生成列 hidden=2/3 也算列）；
//   3. 每张表对应列的声明类型完全相同（成本重构把数值列从 REAL 改成 INTEGER，
//      仅比列名会把旧备份误判为合法）。
// 列的非空/默认值不参与判定——它们不影响数据语义，且历史备份可能由不同 SQLite 版本导出。
// 返回 { zh, en } 描述差异（中英双语一起给出，前端按当前语言展示），一致时返回 null。
// 旧备份兼容：materials 的图片字段是后加的，旧 .db 里没有这两列，
// 恢复时按「无图」处理（列取默认空值、图片目录清空），其余表/列仍严格比对。
const LEGACY_OPTIONAL_COLUMNS = { materials: ['image_path', 'image_updated_at'] };

function compareSchema(curTables, bakTables) {
  // 会话表是运行时状态，不参与结构比对：旧备份没有它时按「空会话」恢复（恢复后需重新登录）
  const skip = t => t === 'user_sessions';
  const missing = curTables.filter(t => !skip(t) && !bakTables.includes(t));
  const extra = bakTables.filter(t => !skip(t) && !curTables.includes(t));
  if (missing.length || extra.length) {
    const zh = [];
    const en = [];
    if (missing.length) { zh.push('缺少表：' + missing.join('、')); en.push('missing tables: ' + missing.join(', ')); }
    if (extra.length) { zh.push('多余表：' + extra.join('、')); en.push('unexpected tables: ' + extra.join(', ')); }
    return { zh: zh.join('；'), en: en.join('; ') };
  }
  for (const t of curTables) {
    if (skip(t)) continue;
    const curCols = columnsOf('main', t);
    const bakCols = columnsOf('bak', t);
    const curNames = new Set(curCols.map(c => c.name));
    const bakNames = new Set(bakCols.map(c => c.name));
    const optional = new Set(LEGACY_OPTIONAL_COLUMNS[t] || []);
    const missingCols = curCols.filter(c => !bakNames.has(c.name) && !optional.has(c.name));
    const extraCols = bakCols.filter(c => !curNames.has(c.name));
    if (missingCols.length || extraCols.length) {
      return { zh: `表「${t}」的列与当前版本不一致`, en: `columns of table "${t}" differ from the current version` };
    }
    const curTypes = curCols.filter(c => bakNames.has(c.name))
      .map(c => `${c.name}:${String(c.type || '').toUpperCase()}`).sort().join(',');
    const bakTypes = bakCols.map(c => `${c.name}:${String(c.type || '').toUpperCase()}`).sort().join(',');
    if (curTypes !== bakTypes) {
      return { zh: `表「${t}」的列类型与当前版本不一致`, en: `column types of table "${t}" differ from the current version` };
    }
  }
  return null;
}

// ==================== 1) 备份下载 ====================
// 产物是 .zip：inventory.db + uploads/materials/* + manifest.json，
// 这样恢复时能连同物料图片一起还原。
router.get('/api/settings/backup/download', requireAdmin, (req, res) => {
  let tmp = '';
  try {
    tmp = path.join(os.tmpdir(), `inventory-backup-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
    const r = backupPackage.createPackage(tmp);
    const name = `inventory-backup-${stamp(false)}.zip`;
    recordOp(req, 'backup', { key: 'audit_detail_backup', params: { file: name, images: r.imageCount } });
    res.download(tmp, name, err => {
      fs.unlink(tmp, () => {});
      if (err && !res.headersSent) res.status(500).json({ error: '备份下载失败：' + err.message });
    });
  } catch (e) {
    if (tmp) fs.unlink(tmp, () => {});
    res.status(500).json({ error: '生成备份失败：' + e.message });
  }
});

// ==================== 2) 导入备份恢复 ====================
// 前端以 application/octet-stream 直传文件内容；短语放 query（请求头不能带中文）
// 兼容两种输入：
//   .zip（新格式）：数据库快照 + 物料图片 + manifest，图片与记录一起还原；
//   .db（旧格式）：只有数据库。旧库没有图片字段，恢复后图片为空并在界面明确提示。
router.post('/api/settings/backup/restore', requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: '512mb' }),
  (req, res) => {
    if (String(req.query.confirm || '') !== CONFIRM_PHRASES.restore) return confirmMismatch(res);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({
        error: '请选择要恢复的备份文件',
        error_en: 'Please choose a backup file to restore',
        code: 'INVALID_BACKUP',
      });
    }

    const isZip = backupPackage.isZipBuffer(req.body);
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tmpInput = path.join(os.tmpdir(), `inventory-restore-${token}.${isZip ? 'zip' : 'db'}`);
    const workDir = path.join(os.tmpdir(), `inventory-restore-${token}-x`);
    let attached = false;
    let backupName = '';
    let dbFile = '';
    let legacyNoImages = false;
    let imageFiles = null;          // Map<relPath, 临时文件>
    let referencedImages = [];      // 备份库中实际引用的 image_path
    let imgDir = '';
    let oldImgDir = '';
    let newImgDir = '';
    let imagesSwapped = false;

    try {
      fs.writeFileSync(tmpInput, req.body);
      dbFile = tmpInput;

      if (isZip) {
        fs.mkdirSync(workDir, { recursive: true });
        try {
          const pkg = backupPackage.readPackage(tmpInput, workDir);
          dbFile = pkg.dbFile;
          imageFiles = new Map(pkg.images.map(i => [i.rel, i.file]));
        } catch (e) {
          return res.status(400).json({
            error: '备份包校验失败：' + e.message,
            error_en: 'Backup package validation failed: ' + e.message,
            code: 'INVALID_BACKUP',
          });
        }
      }

      // 文件置为只读：ATTACH 后无法被误写（better-sqlite3 未启用 URI 文件名，用文件只读替代 mode=ro）
      try { fs.chmodSync(dbFile, 0o444); } catch (e) { /* Windows 下可能不支持，忽略 */ }

      try {
        db.prepare('ATTACH DATABASE ? AS bak').run(dbFile);
        attached = true;
      } catch (e) {
        return res.status(400).json({
          error: '无法打开该文件，不是有效的 SQLite 数据库',
          error_en: 'Cannot open this file; it is not a valid SQLite database',
          code: 'INVALID_BACKUP',
        });
      }

      const curTables = tablesOf('main');
      const bakTables = tablesOf('bak');
      const missingCore = CORE_TABLES.filter(t => !bakTables.includes(t));
      if (missingCore.length) {
        return res.status(400).json({
          error: '不是本系统的数据库备份（缺少表：' + missingCore.join('、') + '）',
          error_en: 'This is not a backup of this system (missing tables: ' + missingCore.join(', ') + ')',
          code: 'INVALID_BACKUP',
        });
      }
      const diff = compareSchema(curTables, bakTables);
      if (diff) {
        return res.status(400).json({
          error: '备份结构与当前系统不一致，已拒绝恢复（' + diff.zh + '）。旧版本的备份不支持直接恢复，请用该备份对应版本导出数据，或重建库后再导入。',
          error_en: 'The backup structure does not match the current version, restore rejected (' + diff.en + '). Backups from older versions cannot be restored directly; export the data with the matching version, or rebuild the database first.',
          code: 'BACKUP_SCHEMA_MISMATCH',
        });
      }

      const bakMaterialCols = columnsOf('bak', 'materials').map(c => c.name);
      legacyNoImages = !bakMaterialCols.includes('image_path');
      if (!legacyNoImages) {
        referencedImages = db.prepare("SELECT image_path FROM bak.materials WHERE COALESCE(image_path,'') <> ''")
          .all().map(r => String(r.image_path));
      }
      if (referencedImages.length && !imageFiles) {
        return res.status(400).json({
          error: '该 .db 备份引用了物料图片，但文件里不含图片。请改用本系统生成的 .zip 备份恢复，避免「记录在、图片丢了」',
          error_en: 'This .db backup references material images but does not contain them. Restore from a .zip backup created by this system instead, so records and images stay consistent.',
          code: 'BACKUP_IMAGES_NOT_INCLUDED',
        });
      }
      if (imageFiles) {
        const missingImages = referencedImages.filter(p => !imageFiles.has(p));
        if (missingImages.length) {
          return res.status(400).json({
            error: '备份包缺少物料图片：' + missingImages.slice(0, 5).join('、')
              + (missingImages.length > 5 ? ` 等 ${missingImages.length} 个` : '') + '。已拒绝恢复',
            error_en: 'The backup package is missing material images: ' + missingImages.slice(0, 5).join(', ')
              + (missingImages.length > 5 ? ` and ${missingImages.length} in total` : '') + '. Restore rejected.',
            code: 'BACKUP_IMAGE_MISSING',
          });
        }
      }

      // 校验通过后才动现库：先自动备份（同样含图片），再准备图片目录切换
      backupName = autoBackup('inventory-before-restore');

      // 图片目录先放到临时新目录，随后整体替换；DB 事务失败时能原样换回
      imgDir = materialImages.DIR;
      materialImages.ensureDir();
      oldImgDir = imgDir + '.old-' + token;
      newImgDir = imgDir + '.new-' + token;
      fs.mkdirSync(newImgDir, { recursive: true });
      if (imageFiles) {
        // 只放回数据库实际引用的文件，避免把包里的孤儿文件也带进目录
        referencedImages.forEach(rel => {
          fs.copyFileSync(imageFiles.get(rel), path.join(newImgDir, path.basename(rel)));
        });
      }
      fs.renameSync(imgDir, oldImgDir);
      try {
        fs.renameSync(newImgDir, imgDir);
      } catch (e) {
        fs.renameSync(oldImgDir, imgDir);
        throw e;
      }
      imagesSwapped = true;

      const copyTables = curTables.filter(t => t !== 'sqlite_sequence');
      db.pragma('foreign_keys = OFF');
      try {
        const tx = db.transaction(() => {
          copyTables.forEach(t => db.exec(`DELETE FROM main.${q(t)}`));
          copyTables.forEach(t => {
            // 旧备份没有会话表：跳过复制，会话已在上面清空，恢复后需重新登录
            if (!bakTables.includes(t)) return;
            // hidden 非 0 的列是生成列（如 amount / cost_amount），必须跳过
            const cols = columnsOf('bak', t).filter(c => c.hidden === 0).map(c => c.name);
            if (!cols.length) return;
            const list = cols.map(q).join(',');
            db.exec(`INSERT INTO main.${q(t)} (${list}) SELECT ${list} FROM bak.${q(t)}`);
          });
          // 自增序列一并还原，保证后续新建 id 不冲突
          try {
            db.exec('DELETE FROM main.sqlite_sequence');
            db.exec('INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM bak.sqlite_sequence');
          } catch (e) { /* 备份库没有 sqlite_sequence 时忽略 */ }

          const broken = db.pragma('foreign_key_check');
          if (broken.length) throw new Error('外键校验失败：' + JSON.stringify(broken.slice(0, 3)));
        });
        tx();
      } catch (e) {
        // 数据库复制失败：把图片目录换回恢复前的状态，保证「记录与图片」同时回滚
        try {
          fs.renameSync(imgDir, newImgDir);
          fs.renameSync(oldImgDir, imgDir);
          imagesSwapped = false;
        } catch (_) { /* 回滚失败时保留现场，交由运维处理 */ }
        throw e;
      } finally {
        db.pragma('foreign_keys = ON');
      }

      // 事务成功后才删除旧图片目录
      try { fs.rmSync(oldImgDir, { recursive: true, force: true }); } catch (e) {}
      imagesSwapped = false;

      const restoredImages = referencedImages.length;
      recordOp(req, 'restore', { key: 'audit_detail_restore', params: { file: backupName, images: restoredImages } });
      res.json({
        success: true,
        backupFile: backupName,
        tables: copyTables.length,
        images: restoredImages,
        legacy: legacyNoImages,        // true：旧 .db 备份，恢复后图片为空
        packageType: imageFiles ? 'zip' : 'db',
      });
    } catch (e) {
      // 事务失败/图片切换失败都会回滚；备份结构一致但数据不合法（唯一约束）也走这里
      const isUnique = /UNIQUE constraint failed/i.test(String(e.message || ''));
      res.status(500).json({
        error: '恢复失败，已回滚，当前数据未受影响：' + e.message
          + (isUnique ? '（备份中存在违反唯一约束的记录，请先在来源库中合并重复数据）' : ''),
        error_en: 'Restore failed and was rolled back; the current data is unchanged: ' + e.message
          + (isUnique ? ' (the backup contains records that violate a unique constraint; merge the duplicates in the source database first)' : ''),
        code: 'RESTORE_FAILED',
      });
    } finally {
      if (attached) { try { db.prepare('DETACH DATABASE bak').run(); } catch (e) {} }
      if (imagesSwapped) {
        try {
          fs.renameSync(imgDir, newImgDir);
          fs.renameSync(oldImgDir, imgDir);
        } catch (e) { /* 尽力回滚 */ }
      }
      try { fs.rmSync(newImgDir, { recursive: true, force: true }); } catch (e) {}
      try { fs.chmodSync(tmpInput, 0o644); } catch (e) {}
      if (dbFile && dbFile !== tmpInput) { try { fs.chmodSync(dbFile, 0o644); } catch (e) {} }
      fs.unlink(tmpInput, () => {});
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

// ==================== 2.2) 自动覆盖式备份 ====================
// 频率：hourly / daily / weekly；每次覆盖 backups/auto-backup-latest.db，只保留最新一份。
// 设置存 params 表（key=auto_backup），由 server.js 启动的定时任务按设置执行。
router.get('/api/settings/backup/auto', requireAdmin, (req, res) => {
  res.json(autoBackupSvc.status());
});

router.put('/api/settings/backup/auto', requireAdmin, (req, res) => {
  try {
    autoBackupSvc.save(req.body || {});
    const st = autoBackupSvc.status();
    recordOp(req, 'auto-backup-settings', { key: 'audit_detail_auto_backup_settings', params: {} });
    res.json(st);
  } catch (e) {
    res.status(e.invalid ? 400 : 500).json({
      error: '保存自动备份设置失败：' + e.message,
      error_en: 'Failed to save automatic backup settings: ' + (e.en || e.message),
      code: 'AUTO_BACKUP_SETTINGS_FAILED',
    });
  }
});

router.post('/api/settings/backup/auto/run', requireAdmin, (req, res) => {
  try {
    const r = autoBackupSvc.runNow();
    recordOp(req, 'auto-backup', { key: 'audit_detail_auto_backup', params: { file: r.file } });
    res.json({ success: true, ...autoBackupSvc.status(), ranAt: r.at });
  } catch (e) {
    res.status(500).json({
      error: '自动备份失败：' + e.message,
      error_en: 'Automatic backup failed: ' + e.message,
      code: 'AUTO_BACKUP_FAILED',
    });
  }
});

// ==================== 2.5) 成本差异结转 ====================
// 期末一次结转：只把「未结转」差异标记为已结转，不动库存数量 / 金额 / 均价。
// 结转后看板的「累计成本差异」自然归零；之后再产生的新差异从零重新累计。
router.post('/api/settings/cost-variance/settle', requireAdmin, (req, res) => {
  // 别名与金额列同名，scaled-db 会把「分」换算成「元」
  const agg = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
    FROM cost_variances WHERE status='open'`).get();
  const count = Number(agg.count);
  const total = Math.round(Number(agg.amount) * 100) / 100;
  if (!count) {
    return res.json({ success: true, settled_count: 0, settled_total: 0, batch_no: '' });
  }

  const batchNo = `CV-${stamp(true)}`;
  try {
    const tx = db.transaction(() => {
      db.prepare(`UPDATE cost_variances
        SET status='settled', settle_batch=?, settled_at=datetime('now'), updated_at=datetime('now')
        WHERE status='open'`).run(batchNo);
      recordOp(req, 'cost-variance-settle', {
        key: 'audit_detail_cv_settle',
        params: { n: count, total: total.toFixed(2), batch: batchNo },
      });
    });
    tx();
    res.json({ success: true, settled_count: count, settled_total: total, batch_no: batchNo });
  } catch (e) {
    res.status(500).json({ error: '结转失败：' + e.message });
  }
});

// ==================== 3) 只清业务数据 ====================
// 用户、用户级权限（user_permissions / user_perm_state）、参数（含自动备份设置）都不在清单里，
// 因此清完仍可用原账号登录，权限矩阵也不会被重置。
router.post('/api/settings/data/clear-business', requireAdmin, (req, res) => {
  if ((req.body || {}).confirm !== CONFIRM_PHRASES.clearBusiness) return confirmMismatch(res);
  let backupName = '';
  try {
    backupName = autoBackup('inventory-before-clear');
    const tx = db.transaction(() => {
      BUSINESS_TABLES.forEach(t => db.exec(`DELETE FROM ${q(t)}`));
      // 物料档案保留时，期初数量仍属于档案属性：清完业务后按档案重出「期初结存」流水，
      // 让 stock_balance 继续由流水推导（期初为 0 的物料不会产生任何流水与余额行）。
      costing.ensureOpeningBalances();
      // 审计表刚被清空，重新写一条，保证清库动作本身可追溯
      recordOp(req, 'clear-business', { key: 'audit_detail_clear_business', params: { file: backupName } });
    });
    tx();
    res.json({ success: true, backupFile: backupName });
  } catch (e) {
    res.status(500).json({ error: '清空失败：' + e.message });
  }
});

// ==================== 4) 全清（重置） ====================
router.post('/api/settings/data/reset', requireAdmin, (req, res) => {
  if ((req.body || {}).confirm !== CONFIRM_PHRASES.reset) return confirmMismatch(res);
  let backupName = '';
  try {
    backupName = autoBackup('inventory-before-reset');
    const tx = db.transaction(() => {
      // 先删子表（用户级权限、登录会话）再删 users，避免留下孤儿授权行
      USER_PERM_TABLES.concat(SESSION_TABLES).forEach(t => db.exec(`DELETE FROM ${q(t)}`));
      BUSINESS_TABLES.concat(ARCHIVE_TABLES).forEach(t => db.exec(`DELETE FROM ${q(t)}`));
      // 自增序列归零：id 与单号都从干净状态开始（放在重建管理员之前，默认管理员才能拿到 id=1）
      try { db.exec('DELETE FROM sqlite_sequence'); } catch (e) { /* 无自增表时忽略 */ }
      // 与首次启动口径一致：默认管理员 + 首次登录强制改密
      const info = db.prepare(`INSERT INTO users (username, password_hash, name, role, must_change_pwd)
                  VALUES (?,?,?,?,1)`)
        .run(INITIAL_ADMIN_USERNAME, bcrypt.hashSync(INITIAL_ADMIN_PASSWORD, 10), '系统管理员', 'admin');
      // 显式按 admin 角色矩阵写入授权并标记已初始化，与首次启动后的状态完全一致，
      // 不依赖「启动时补种」；admin 本身恒定全量权限，不会因为授权表为空被锁死
      seedGrants({ id: info.lastInsertRowid, role: 'admin' });
      recordOp(req, 'reset', { key: 'audit_detail_reset', params: { file: backupName } });
    });
    tx();
    // 物料档案已被清空，参考图片一并清理，避免孤儿文件
    materialImages.clearImages();
    try { db.exec('VACUUM'); } catch (e) { console.error('重置后 VACUUM 失败:', e.message); }
    res.json({
      success: true,
      backupFile: backupName,
      username: INITIAL_ADMIN_USERNAME,
      password: INITIAL_ADMIN_PASSWORD,
    });
  } catch (e) {
    res.status(500).json({ error: '重置失败：' + e.message });
  }
});

module.exports = router;
