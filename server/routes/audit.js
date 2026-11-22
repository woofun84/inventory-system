/**
 * 系统日志（审计）接口
 *
 * 查询 / 完整性校验 / CSV 导出 / 清空。
 * 清空需 audit:delete + admin 角色 + 输入确认短语；清空前把链尾与条数写入独立留痕文件。
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const audit = require('../services/audit');
const { clientIp } = require('../utils/client-ip');

const router = express.Router();

const CLEAR_PHRASE = '清空日志';
const EXPORT_LIMIT = 5000;

function actor(req, extra = {}) {
  const u = req.user || {};
  return {
    user_id: u.id || null,
    username: u.username || '',
    name: u.name || '',
    role: u.role || '',
    method: req.method,
    path: req.originalUrl.split('?')[0],
    ip: clientIp(req),
    ...extra,
  };
}

// 审计日志查询（服务端分页 + 条件过滤）
router.get('/api/audit-logs', requirePerm('audit', 'view'), (req, res) => {
  try {
    res.json(audit.list(req.query, { canViewPrice: req.canViewPrice }));
  } catch (e) {
    console.error('[audit] list failed:', e);
    res.status(500).json({ error: '查询日志失败，请稍后重试' });
  }
});

// 前端运行异常采样上报（无需登录；只收错误类型+消息，不收请求体/令牌）
// 限流：同一 IP 每分钟最多 20 条，避免噪音与滥用。
const clientErrorHits = new Map();
function allowClientError(ip) {
  const now = Date.now();
  const hit = clientErrorHits.get(ip);
  if (!hit || now - hit.t > 60000) { clientErrorHits.set(ip, { t: now, n: 1 }); return true; }
  if (hit.n >= 20) return false;
  hit.n++;
  return true;
}
router.post('/api/client-errors', express.json({ limit: '4kb' }), (req, res) => {
  const ip = clientIp(req);
  if (!allowClientError(ip)) return res.status(429).json({ error: 'too many reports' });
  const body = req.body || {};
  const type = String(body.type || 'error').slice(0, 40);
  const msg = String(body.message || '').slice(0, 300);
  if (!msg) return res.status(400).json({ error: 'empty message' });
  audit.record({
    ...actor(req), module: 'system', action: 'client-error', target: type, status: 200,
    level: 'error', source: 'client',
    detail: { key: 'audit_detail_client_error', params: { type, msg } },
  });
  res.json({ ok: true });
});

// 完整性校验：返回哈希链是否连续、是否存在断点
router.get('/api/audit-logs/verify', requirePerm('audit', 'view'), (req, res) => {
  try {
    const result = audit.verifyChain();
    // GET 不被通用埋点记录，显式写一条校验审计（可追溯"谁在何时校验过完整性"）
    audit.record({ ...actor(req), module: 'audit', action: 'verify', target: '', status: result.ok ? 200 : 500,
      level: result.ok ? 'info' : 'error',
      detail: { key: result.ok ? 'audit_detail_verify_ok' : 'audit_detail_verify_bad', params: { n: result.checked, id: result.brokenId || 0 } } });
    res.json(result);
  } catch (e) {
    console.error('[audit] verify failed:', e);
    res.status(500).json({ error: '校验日志完整性失败，请稍后重试' });
  }
});

// CSV 导出：复用查询口径，最多 5000 条，按查看者价格权限打码
// GET 不被通用埋点记录，这里显式写一条 export 审计
router.get('/api/audit-logs/export', requirePerm('audit', 'view'), (req, res) => {
  try {
    const all = [];
    const pageSize = 200;
    for (let page = 1; page * pageSize <= EXPORT_LIMIT + pageSize; page++) {
      const batch = audit.list({ ...req.query, page, pageSize }, { canViewPrice: req.canViewPrice });
      all.push(...batch.rows);
      if (all.length >= batch.total || all.length >= EXPORT_LIMIT) break;
    }
    const rows = all.slice(0, EXPORT_LIMIT);
    const cell = v => {
      const s = v == null ? '' : String(v);
      const safe = !Number.isFinite(Number(s)) && /^[\s]*[=+\-@]/.test(s) ? "'" + s : s;
      return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
    };
    const head = ['时间(UTC)', '用户', '姓名', '角色', '模块', '动作', '对象', '结果', 'IP', '详情', '级别', '来源'];
    const lines = [head.map(cell).join(',')];
    rows.forEach(r => lines.push([
      r.created_at, r.username, r.name, r.role, r.module, r.action, r.target,
      r.status, r.ip, String(r.detail || '') + (r.detail_json ? ' ' + r.detail_json : ''),
      r.level || 'info', r.source || 'user',
    ].map(cell).join(',')));
    audit.record({ ...actor(req), module: 'audit', action: 'export', target: '', status: 200,
      detail: { key: 'audit_detail_export', params: { n: rows.length } } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    res.send('\ufeff' + lines.join('\r\n'));
  } catch (e) {
    console.error('[audit] export failed:', e);
    res.status(500).json({ error: '导出日志失败，请稍后重试' });
  }
});

// 清空全部日志（破坏性操作：audit:delete + admin 角色 + 确认短语；默认只给管理员）
// 事务内先把链尾与条数写入独立留痕，再清空，最后补写一条本次操作记录。
router.delete('/api/audit-logs', requirePerm('audit', 'delete'), (req, res) => {
  if (req.user && req.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可清空系统日志', error_en: 'Only administrators can clear system logs.' });
  }
  if (String((req.body && req.body.confirm) || '') !== CLEAR_PHRASE) {
    return res.status(400).json({
      error: '请输入确认短语「清空日志」后重试',
      error_en: 'Type the confirmation phrase "清空日志" to continue.',
    });
  }
  try {
    const deleted = db.transaction(() => {
      const head = audit.chainHead();
      const count = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c;
      // 独立只追加留痕（在清库前写，清库不会抹掉它）
      audit.appendEvidence({
        event: 'clear-audit-logs',
        actor: req.user ? req.user.username : '',
        ip: clientIp(req),
        deleted: count,
        head_id: head.id,
        head_hash: head.hash,
      });
      const info = db.prepare('DELETE FROM audit_logs').run();
      audit.record({
        ...actor(req), module: 'audit', action: 'delete', target: '', status: 200,
        detail: { key: 'audit_detail_clear_logs', params: { n: info.changes } },
      });
      return info.changes;
    })();
    res.json({ success: true, deleted });
  } catch (e) {
    console.error('[audit] clear failed:', e);
    res.status(500).json({ error: '清空失败，请稍后重试', error_en: 'Failed to clear logs. Please retry.' });
  }
});

module.exports = router;
