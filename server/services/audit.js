/**
 * 系统审计日志
 *
 * 记录"谁在什么时间做了什么"：登录、新增、修改、删除、确认、作废、冲销等。
 * 时间统一以 UTC 存储（datetime('now')），前端按浏览器本地时区渲染。
 */
const db = require('../db');

// 动作码全集（前端据此展示下拉与文案）
const ACTIONS = ['login', 'create', 'update', 'delete', 'confirm', 'cancel', 'reverse', 'load', 'change-password'];

// 敏感字段（请求摘要中打码）
const SENSITIVE = /pass|pwd|secret|token/i;

// 把请求体压缩成一行摘要："改了啥 / 删了啥" 的原始素材
function summarize(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const out = {};
  Object.keys(body).forEach(k => {
    if (SENSITIVE.test(k)) { out[k] = '***'; return; }
    const v = body[k];
    if (Array.isArray(v)) out[k] = `[${v.length} 项]`;
    else if (v && typeof v === 'object') out[k] = '{…}';
    else out[k] = (typeof v === 'string' && v.length > 100) ? v.slice(0, 100) + '…' : v;
  });
  const s = JSON.stringify(out);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

function record(entry) {
  try {
    db.prepare(`INSERT INTO audit_logs
      (created_at,user_id,username,name,role,module,action,target,method,path,ip,status,detail)
      VALUES (datetime('now'),@user_id,@username,@name,@role,@module,@action,@target,@method,@path,@ip,@status,@detail)`)
      .run({
        user_id: null, username: '', name: '', role: '', module: '', action: '',
        target: '', method: '', path: '', ip: '', status: 200, detail: '',
        ...entry,
      });
  } catch (e) {
    // 审计失败不能影响主流程
    console.error('审计日志写入失败:', e.message);
  }
}

// 查询（服务端分页）
// q: { module, action, keyword, fromUtc, toUtc, page, pageSize }
// fromUtc / toUtc 由前端按其本地时区换算出的 UTC 边界（YYYY-MM-DD HH:MM:SS）
function list(q = {}) {
  const where = [];
  const args = {};
  if (q.module) { where.push('module=@module'); args.module = q.module; }
  if (q.action) { where.push('action=@action'); args.action = q.action; }
  if (q.keyword) {
    where.push('(username LIKE @kw OR name LIKE @kw OR target LIKE @kw OR detail LIKE @kw OR path LIKE @kw)');
    args.kw = `%${q.keyword}%`;
  }
  if (q.fromUtc) { where.push('created_at >= @fromUtc'); args.fromUtc = q.fromUtc; }
  if (q.toUtc) { where.push('created_at <= @toUtc'); args.toUtc = q.toUtc; }

  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) c FROM audit_logs' + w).get(args).c;
  const page = Math.max(1, parseInt(q.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize) || 50));
  const rows = db.prepare(
    `SELECT * FROM audit_logs${w} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
  ).all(args);
  return { rows, total, page, pageSize };
}

module.exports = { ACTIONS, record, list, summarize };
