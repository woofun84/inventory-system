/**
 * 登录会话（单终端登录）
 *
 * 规则：每个账号在 user_sessions 里最多一条记录。登录即覆盖 sid，
 * 于是先前签发的 token 因 sid 不匹配而立即失效——这就是「后登录挤下线先登录」。
 *
 * 终端（terminal）：前端 localStorage 中的稳定随机标识，同一浏览器的多个标签页共享同一个值。
 * 同一终端再次登录（例如刷新登录页、在另一个标签页重新登录）沿用原 sid，不互相挤下线；
 * 只有来自其它终端（其它浏览器/电脑/手机）的登录才会顶掉旧会话。
 */
const crypto = require('crypto');
const db = require('../db');

function newSid() {
  return crypto.randomBytes(24).toString('hex');
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '')
    .split(',')[0].trim().slice(0, 64);
}

function clientUa(req) {
  return String(req.headers['user-agent'] || '').slice(0, 200);
}

function getSession(userId) {
  return db.prepare(`SELECT user_id, sid, terminal, login_at, last_seen, ip, user_agent
    FROM user_sessions WHERE user_id=?`).get(userId) || null;
}

// 登录成功后签发/沿用会话，返回写入 token 的 sid
function issueSession(user, req) {
  const terminal = String((req.body && req.body.terminal) || '').slice(0, 64);
  const ip = clientIp(req);
  const ua = clientUa(req);
  const existing = getSession(user.id);

  if (existing && terminal && existing.terminal === terminal) {
    db.prepare(`UPDATE user_sessions
      SET login_at=datetime('now'), last_seen=datetime('now'), ip=?, user_agent=?
      WHERE user_id=?`).run(ip, ua, user.id);
    return existing.sid;
  }

  const sid = newSid();
  db.prepare(`INSERT INTO user_sessions (user_id, sid, terminal, login_at, last_seen, ip, user_agent)
    VALUES (?,?,?,datetime('now'),datetime('now'),?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      sid=excluded.sid, terminal=excluded.terminal, login_at=excluded.login_at,
      last_seen=excluded.last_seen, ip=excluded.ip, user_agent=excluded.user_agent`)
    .run(user.id, sid, terminal, ip, ua);
  return sid;
}

// 心跳：只更新时间戳，顺带证明服务器仍在（60 秒内的重复心跳不写库，避免无谓的写锁）
function touchSession(userId) {
  db.prepare(`UPDATE user_sessions SET last_seen=datetime('now')
    WHERE user_id=? AND last_seen < datetime('now','-60 seconds')`).run(userId);
}

// 主动退出：仅当 sid 仍是当前会话时才删除，避免旧标签页把新会话踢掉
function revokeSession(userId, sid) {
  if (!sid) return;
  db.prepare('DELETE FROM user_sessions WHERE user_id=? AND sid=?').run(userId, sid);
}

module.exports = { issueSession, getSession, touchSession, revokeSession };
