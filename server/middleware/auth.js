/**
 * 鉴权中间件 & 用户序列化
 */
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { canViewPrice, hasGrant } = require('../permissions');
const { grantsForUser } = require('../services/user-permissions');
const { getSession } = require('../services/session');
const db = require('../db');

// 会话失效的两种情形，前端据 code 区分提示方式
const SESSION_KICKED = {
  code: 'SESSION_KICKED',
  error: '该账号已在其它终端登录，当前登录已失效',
  error_en: 'This account was signed in on another device, so this session has ended.',
};
const SESSION_REQUIRED = {
  code: 'SESSION_REQUIRED',
  error: '登录状态已更新，请重新登录',
  error_en: 'Your session is out of date, please log in again.',
};

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
    // 单终端登录：token 里的 sid 必须与库里该账号当前会话一致，否则就是被后登录的终端挤下线
    const session = getSession(u.id);
    if (!payload.sid || !session) return res.status(401).json(SESSION_REQUIRED);
    if (session.sid !== payload.sid) return res.status(401).json(SESSION_KICKED);
    req.user = u;
    req.sessionSid = payload.sid;
    // 权限按用户解析（角色默认值 + 管理员调整），后续接口统一读 req.grants
    req.grants = grantsForUser(u);
    // 价格权限按角色解析一次，后续接口统一读 req.canViewPrice，不再各自判断
    req.canViewPrice = canViewPrice(u);
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

function requirePerm(module, action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!hasGrant(req.grants, module, action)) {
      return res.status(403).json({ error: '权限不足：无该操作权限' });
    }
    next();
  };
}

// ==================== 用户信息序列化 ====================
function publicUser(u, grants) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, status: u.status,
    must_change_pwd: !!u.must_change_pwd, last_login: u.last_login || '',
    grants: grants || grantsForUser(u),
  };
}


module.exports = {
  requireAuth,
  requirePerm,
  publicUser,
};
