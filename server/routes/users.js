/**
 * 用户管理
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const { ROLE_PERMISSIONS } = require('../permissions');

const router = express.Router();

// ==================== 用户管理（仅管理员） ====================
router.get('/api/users', requirePerm('users', 'view'), (req, res) => {
  const rows = db.prepare(`SELECT id,username,name,role,status,must_change_pwd,last_login,created_at
                           FROM users ORDER BY id`).all();
  res.json(rows.map(r => ({ ...r, must_change_pwd: !!r.must_change_pwd })));
});

router.post('/api/users', requirePerm('users', 'create'), (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (!ROLE_PERMISSIONS[role]) return res.status(400).json({ error: '无效的角色' });
  try {
    const dup = db.prepare('SELECT id FROM users WHERE username=?').get(String(username).trim());
    if (dup) return res.status(400).json({ error: '用户名已存在' });
    const info = db.prepare(`INSERT INTO users (username,password_hash,name,role) VALUES (?,?,?,?)`)
      .run(String(username).trim(), bcrypt.hashSync(String(password), 10), String(name || '').trim(), role);
    const u = db.prepare('SELECT id,username,name,role,status,must_change_pwd,last_login,created_at FROM users WHERE id=?').get(info.lastInsertRowid);
    res.json({ ...u, must_change_pwd: !!u.must_change_pwd });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/users/:id', requirePerm('users', 'edit'), (req, res) => {
  const id = Number(req.params.id);
  const { name, role, status, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (role && !ROLE_PERMISSIONS[role]) return res.status(400).json({ error: '无效的角色' });
  try {
    // 防止把最后一个管理员降级或停用
    if (u.role === 'admin' && (role && role !== 'admin' || status === 'disabled')) {
      const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'").get().c;
      if (admins <= 1) return res.status(400).json({ error: '系统至少需要保留一个启用的管理员' });
    }
    if (name !== undefined) db.prepare('UPDATE users SET name=? WHERE id=?').run(String(name).trim(), id);
    if (role) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
    if (status) db.prepare('UPDATE users SET status=? WHERE id=?').run(status, id);
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
      db.prepare('UPDATE users SET password_hash=?, must_change_pwd=1 WHERE id=?')
        .run(bcrypt.hashSync(String(password), 10), id);
    }
    const out = db.prepare('SELECT id,username,name,role,status,must_change_pwd,last_login,created_at FROM users WHERE id=?').get(id);
    res.json({ ...out, must_change_pwd: !!out.must_change_pwd });
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
