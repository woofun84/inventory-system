/**
 * 认证接口
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET, JWT_EXPIRES } = require('../config');
const { publicUser } = require('../middleware/auth');
const { issueSession, getSession, touchSession, revokeSession } = require('../services/session');

const router = express.Router();

router.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  try {
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim());
    if (!u) return res.status(401).json({ error: '用户名或密码错误' });
    if (!bcrypt.compareSync(String(password), u.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (u.status !== 'active') return res.status(403).json({ error: '账号已被停用，请联系管理员' });
    db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(u.id);
    // 单终端登录：新会话的 sid 覆盖旧会话，先前那台终端的 token 立刻失效
    const sid = issueSession(u, req);
    const token = jwt.sign({ id: u.id, username: u.username, role: u.role, sid }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ token, user: publicUser(u) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


router.get('/api/auth/me', (req, res) => {
  res.json(publicUser(req.user, req.grants));
});

// 会话心跳：前端定时调用，用于「被挤下线」的及时提示；顺带刷新 last_seen
router.get('/api/auth/session', (req, res) => {
  touchSession(req.user.id);
  const s = getSession(req.user.id);
  res.json({
    ok: true,
    user: publicUser(req.user, req.grants),
    session: s ? { login_at: s.login_at, last_seen: s.last_seen, ip: s.ip, terminal: s.terminal } : null,
  });
});

// 主动退出：只撤销当前 sid 的会话，旧标签页不会误删新会话
router.post('/api/auth/logout', (req, res) => {
  revokeSession(req.user.id, req.sessionSid);
  res.json({ ok: true });
});

// 修改自己的密码
router.post('/api/auth/change-password', (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写原密码和新密码' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  try {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!bcrypt.compareSync(String(oldPassword), u.password_hash)) {
      return res.status(400).json({ error: '原密码不正确' });
    }
    db.prepare('UPDATE users SET password_hash=?, must_change_pwd=0 WHERE id=?')
      .run(bcrypt.hashSync(String(newPassword), 10), req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;
