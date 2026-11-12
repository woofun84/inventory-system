/**
 * 设置页运维接口 —— 数据备份 / 恢复 / 清库
 *
 * 四个接口：
 *   GET  /api/settings/backup/download        生成一致性快照并下载（文件名带时间戳）
 *   POST /api/settings/backup/restore         上传 .db 备份并恢复（先校验、先自动备份）
 *   POST /api/settings/data/clear-business    只清业务数据（保留基础档案）
 *   POST /api/settings/data/reset             全清并重建默认管理员
 *
 * 安全约定：
 *  1. 四个接口都要求管理员角色，非管理员一律 403（不仅靠前端隐藏按钮）
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
const ARCHIVE_TABLES = ['materials', 'suppliers', 'users'];

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

// WAL 模式下的一致性快照：VACUUM INTO 会带上尚未 checkpoint 的已提交数据
function snapshotTo(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db.prepare('VACUUM INTO ?').run(file);
}

// 危险操作前自动备份当前库，返回文件名（展示给用户）
// 同一秒内可能连续触发两次（例如连续恢复），文件名按秒生成会撞车，
// 而 VACUUM INTO 要求目标文件不存在，这里顺延编号避免失败。
function autoBackup(prefix) {
  ensureBackupDir();
  const base = `${prefix}-${stamp(true)}`;
  let name = `${base}.db`;
  for (let i = 1; fs.existsSync(path.join(BACKUP_DIR, name)); i++) name = `${base}-${i}.db`;
  snapshotTo(path.join(BACKUP_DIR, name));
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
  return res.status(400).json({ error: '确认短语不正确，操作未执行', code: 'CONFIRM_MISMATCH' });
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
function compareSchema(curTables, bakTables) {
  const missing = curTables.filter(t => !bakTables.includes(t));
  const extra = bakTables.filter(t => !curTables.includes(t));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push('缺少表：' + missing.join('、'));
    if (extra.length) parts.push('多余表：' + extra.join('、'));
    return parts.join('；');
  }
  for (const t of curTables) {
    const curCols = columnsOf('main', t);
    const bakCols = columnsOf('bak', t);
    const curNames = new Set(curCols.map(c => c.name));
    const bakNames = new Set(bakCols.map(c => c.name));
    if (curCols.some(c => !bakNames.has(c.name)) || bakCols.some(c => !curNames.has(c.name))) {
      return `表「${t}」的列与当前版本不一致`;
    }
    const curTypes = curCols.map(c => `${c.name}:${String(c.type || '').toUpperCase()}`).sort().join(',');
    const bakTypes = bakCols.map(c => `${c.name}:${String(c.type || '').toUpperCase()}`).sort().join(',');
    if (curTypes !== bakTypes) return `表「${t}」的列类型与当前版本不一致`;
  }
  return null;
}

// ==================== 1) 备份下载 ====================
router.get('/api/settings/backup/download', requireAdmin, (req, res) => {
  let tmp = '';
  try {
    tmp = path.join(os.tmpdir(), `inventory-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    snapshotTo(tmp);
    const name = `inventory-backup-${stamp(false)}.db`;
    recordOp(req, 'backup', { key: 'audit_detail_backup', params: { file: name } });
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
router.post('/api/settings/backup/restore', requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: '300mb' }),
  (req, res) => {
    if (String(req.query.confirm || '') !== CONFIRM_PHRASES.restore) return confirmMismatch(res);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: '请选择要恢复的备份文件', code: 'INVALID_BACKUP' });
    }

    const tmp = path.join(os.tmpdir(), `inventory-restore-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    let attached = false;
    let backupName = '';
    try {
      fs.writeFileSync(tmp, req.body);
      // 文件置为只读：ATTACH 后无法被误写（better-sqlite3 未启用 URI 文件名，用文件只读替代 mode=ro）
      try { fs.chmodSync(tmp, 0o444); } catch (e) { /* Windows 下可能不支持，忽略 */ }

      try {
        db.prepare('ATTACH DATABASE ? AS bak').run(tmp);
        attached = true;
      } catch (e) {
        return res.status(400).json({ error: '无法打开该文件，不是有效的 SQLite 数据库', code: 'INVALID_BACKUP' });
      }

      const curTables = tablesOf('main');
      const bakTables = tablesOf('bak');
      const missingCore = CORE_TABLES.filter(t => !bakTables.includes(t));
      if (missingCore.length) {
        return res.status(400).json({
          error: '不是本系统的数据库备份（缺少表：' + missingCore.join('、') + '）',
          code: 'INVALID_BACKUP',
        });
      }
      const diff = compareSchema(curTables, bakTables);
      if (diff) {
        return res.status(400).json({
          error: '备份结构与当前系统不一致，已拒绝恢复（' + diff + '）',
          code: 'BACKUP_SCHEMA_MISMATCH',
        });
      }

      // 校验通过后才动现库：先自动备份，再在同一事务里清空并按表复制
      backupName = autoBackup('inventory-before-restore');

      const copyTables = curTables.filter(t => t !== 'sqlite_sequence');
      db.pragma('foreign_keys = OFF');
      try {
        const tx = db.transaction(() => {
          copyTables.forEach(t => db.exec(`DELETE FROM main.${q(t)}`));
          copyTables.forEach(t => {
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
      } finally {
        db.pragma('foreign_keys = ON');
      }

      recordOp(req, 'restore', { key: 'audit_detail_restore', params: { file: backupName } });
      res.json({ success: true, backupFile: backupName, tables: copyTables.length });
    } catch (e) {
      res.status(500).json({ error: '恢复失败，已回滚，当前数据未受影响：' + e.message, code: 'RESTORE_FAILED' });
    } finally {
      if (attached) { try { db.prepare('DETACH DATABASE bak').run(); } catch (e) {} }
      try { fs.chmodSync(tmp, 0o644); } catch (e) {}
      fs.unlink(tmp, () => {});
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
      BUSINESS_TABLES.concat(ARCHIVE_TABLES).forEach(t => db.exec(`DELETE FROM ${q(t)}`));
      // 与首次启动口径一致：默认管理员 + 首次登录强制改密
      db.prepare(`INSERT INTO users (username, password_hash, name, role, must_change_pwd)
                  VALUES (?,?,?,?,1)`)
        .run(INITIAL_ADMIN_USERNAME, bcrypt.hashSync(INITIAL_ADMIN_PASSWORD, 10), '系统管理员', 'admin');
      // 自增序列归零：id 与单号都从干净状态开始
      try { db.exec('DELETE FROM sqlite_sequence'); } catch (e) { /* 无自增表时忽略 */ }
      recordOp(req, 'reset', { key: 'audit_detail_reset', params: { file: backupName } });
    });
    tx();
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
