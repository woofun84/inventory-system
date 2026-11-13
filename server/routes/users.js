/**
 * 用户管理
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const { ROLE_PERMISSIONS, actionsOf, grantsOf } = require('../permissions');
const { GRANTABLE_MODULES, normalizeGrants, grantsForUser, writeGrants } = require('../services/user-permissions');

const router = express.Router();

const USER_COLS = 'id,username,name,role,status,must_change_pwd,last_login,created_at';

function userOut(u) {
  return { ...u, must_change_pwd: !!u.must_change_pwd, grants: grantsForUser(u) };
}

// ==================== 用户管理（仅管理员） ====================
router.get('/api/users', requirePerm('users', 'view'), (req, res) => {
  const rows = db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY id`).all();
  res.json(rows.map(userOut));
});

// 权限矩阵元数据：模块/动作全集 + 四个角色的默认值（用户管理页勾选面板用）
router.get('/api/permissions/catalog', requirePerm('users', 'view'), (req, res) => {
  res.json({
    modules: GRANTABLE_MODULES.map(key => ({ key, actions: actionsOf(key) })),
    roles: Object.fromEntries(Object.keys(ROLE_PERMISSIONS).map(r => [r, grantsOf(r)])),
  });
});

router.post('/api/users', requirePerm('users', 'create'), (req, res) => {
  const { username, password, name, role, permissions } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (!ROLE_PERMISSIONS[role]) return res.status(400).json({ error: '无效的角色' });
  try {
    const dup = db.prepare('SELECT id FROM users WHERE username=?').get(String(username).trim());
    if (dup) return res.status(400).json({ error: '用户名已存在' });
    const id = db.transaction(() => {
      const info = db.prepare(`INSERT INTO users (username,password_hash,name,role) VALUES (?,?,?,?)`)
        .run(String(username).trim(), bcrypt.hashSync(String(password), 10), String(name || '').trim(), role);
      // 管理员恒定全量；其他角色默认按角色矩阵初始化，页面显式提交时以提交值为准
      const grants = role === 'admin' ? grantsOf('admin')
        : (permissions !== undefined ? normalizeGrants(permissions) : grantsOf(role));
      writeGrants(info.lastInsertRowid, grants);
      return info.lastInsertRowid;
    })();
    const u = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id=?`).get(id);
    res.json(userOut(u));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/users/:id', requirePerm('users', 'edit'), (req, res) => {
  const id = Number(req.params.id);
  const { name, role, status, password, permissions } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (role && !ROLE_PERMISSIONS[role]) return res.status(400).json({ error: '无效的角色' });
  if (password && String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  try {
    // 防止把最后一个管理员降级或停用
    if (u.role === 'admin' && (role && role !== 'admin' || status === 'disabled')) {
      const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'").get().c;
      if (admins <= 1) return res.status(400).json({ error: '系统至少需要保留一个启用的管理员' });
    }
    const roleChanged = !!role && role !== u.role;
    const effectiveRole = role || u.role;
    db.transaction(() => {
      if (name !== undefined) db.prepare('UPDATE users SET name=? WHERE id=?').run(String(name).trim(), id);
      if (role) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
      if (status) db.prepare('UPDATE users SET status=? WHERE id=?').run(status, id);
      if (password) {
        db.prepare('UPDATE users SET password_hash=?, must_change_pwd=1 WHERE id=?')
          .run(bcrypt.hashSync(String(password), 10), id);
      }
      if (effectiveRole === 'admin') {
        // 管理员恒定全量：不落库也无妨，但顺手重置，避免以后降级时残留旧授权
        if (roleChanged) writeGrants(id, grantsOf('admin'));
      } else if (permissions !== undefined) {
        writeGrants(id, normalizeGrants(permissions));
      } else if (roleChanged) {
        // 角色变更未显式提交权限时，按新角色默认值重置，避免保留旧角色的权限
        writeGrants(id, grantsOf(effectiveRole));
      }
    })();
    const out = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id=?`).get(id);
    res.json(userOut(out));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/users/:id', requirePerm('users', 'delete'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除当前登录的账号' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'").get().c;
    if (admins <= 1) return res.status(400).json({ error: '系统至少需要保留一个启用的管理员' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ success: true });
});



module.exports = router;
