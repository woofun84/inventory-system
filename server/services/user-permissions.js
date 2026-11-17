/**
 * 用户级权限：默认值来自角色矩阵，管理员可在用户管理里按用户调整。
 *
 * 存储口径：user_permissions 中某用户的全部行 = 该用户的最终授权集合（完整覆盖，不做增量合并）。
 * user_perm_state 记录「该用户已初始化」，避免管理员把权限全部取消后重启又被角色默认值填回来。
 * admin 恒定拥有全部权限（不读取授权表），防止误操作把唯一管理员锁死。
 */
const db = require('../db');
const { MODULES, actionsOf, grantsOf } = require('../permissions');

// 用户管理本身不开放给非管理员，因此不在可勾选模块里
const GRANTABLE_MODULES = MODULES.filter(m => m !== 'users');

// 把前端/接口传入的授权表收敛为合法集合（未知模块/动作直接丢弃）
function normalizeGrants(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const m of GRANTABLE_MODULES) {
    const raw = input[m];
    if (!Array.isArray(raw)) continue;
    const allowed = actionsOf(m);
    const acts = [...new Set(raw.filter(a => allowed.includes(a)))];
    if (acts.length) out[m] = acts;
  }
  return out;
}

function rowsToGrants(rows) {
  const g = {};
  for (const r of rows) {
    if (!Array.isArray(g[r.module])) g[r.module] = [];
    g[r.module].push(r.action);
  }
  return g;
}

function readGrants(userId) {
  return rowsToGrants(db.prepare('SELECT module, action FROM user_permissions WHERE user_id=?').all(userId));
}

// 整表覆盖写入（与调用方的用户写入可嵌套为 savepoint）
function writeGrants(userId, grants) {
  const del = db.prepare('DELETE FROM user_permissions WHERE user_id=?');
  const ins = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, module, action) VALUES (?,?,?)');
  const mark = db.prepare("INSERT OR REPLACE INTO user_perm_state (user_id, seeded_at) VALUES (?, datetime('now'))");
  db.transaction(() => {
    del.run(userId);
    for (const [m, acts] of Object.entries(grants)) {
      for (const a of acts) ins.run(userId, m, a);
    }
    mark.run(userId);
  })();
}

// 按角色默认矩阵初始化/重置
function seedGrants(user) {
  writeGrants(user.id, grantsOf(user.role));
}

function grantsForUser(user) {
  if (!user) return {};
  if (user.role === 'admin') return grantsOf('admin');
  const rows = db.prepare('SELECT module, action FROM user_permissions WHERE user_id=?').all(user.id);
  if (rows.length) return rowsToGrants(rows);
  // 空授权：可能是从未初始化，也可能是管理员把所有权限都取消了
  if (!db.prepare('SELECT 1 FROM user_perm_state WHERE user_id=?').get(user.id)) {
    seedGrants(user);
    return readGrants(user.id);
  }
  return {};
}

module.exports = {
  GRANTABLE_MODULES,
  normalizeGrants,
  readGrants,
  writeGrants,
  seedGrants,
  grantsForUser,
};
