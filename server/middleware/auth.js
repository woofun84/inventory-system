/**
 * 鉴权中间件 & 用户序列化
 */
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { canDo, grantsOf } = require('../permissions');
const db = require('../db');

// ==================== 鉴权中间件 ====================
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: '未登录或登录已过期' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const u = db.prepare('SELECT id,username,name,role,status,must_change_pwd FROM users WHERE id=?').get(payload.id);
    if (!u) return res.status(401).json({ error: '用户不存在' });
    if (u.status !== 'active') return res.status(403).json({ error: '账号已被停用' });
    req.user = u;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

function requirePerm(module, action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!canDo(req.user.role, module, action)) {
      return res.status(403).json({ error: '权限不足：无该操作权限' });
    }
    next();
  };
}

// ==================== 用户信息序列化 ====================
function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, status: u.status,
    must_change_pwd: !!u.must_change_pwd, last_login: u.last_login || '',
    grants: grantsOf(u.role),
  };
}


module.exports = {
  requireAuth,
  requirePerm,
  publicUser,
};
