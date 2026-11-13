/**
 * 系统日志（审计）接口
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const audit = require('../services/audit');

const router = express.Router();

// 审计日志查询（服务端分页 + 条件过滤）
router.get('/api/audit-logs', requirePerm('audit', 'view'), (req, res) => {
  try {
    res.json(audit.list(req.query));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: '仅管理员可清空系统日志',
      error_en: 'Only administrators can clear system logs',
      code: 'FORBIDDEN',
    });
  }
  next();
}

// 清空全部日志（破坏性操作，仅管理员；前端隐藏按钮不能作为唯一防线）
// 审计：同一事务内先清空、再补写本次操作记录，否则记录会被本次清空一起删掉。
// 保留这一条是为了让「谁在何时清空了日志」可追溯，与设置页清库的口径一致。
router.delete('/api/audit-logs', requireAdmin, (req, res) => {
  try {
    const deleted = db.transaction(() => {
      const info = db.prepare('DELETE FROM audit_logs').run();
      const u = req.user || {};
      audit.record({
        user_id: u.id || null,
        username: u.username || '',
        name: u.name || '',
        role: u.role || '',
        module: 'audit',
        action: 'delete',
        target: '',
        method: req.method,
        path: req.originalUrl.split('?')[0],
        ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
        status: 200,
        detail: { key: 'audit_detail_clear_logs', params: { n: info.changes } },
      });
      return info.changes;
    })();
    res.json({ success: true, deleted });
  } catch (e) {
    res.status(500).json({ error: '清空失败：' + e.message, error_en: 'Failed to clear logs: ' + e.message });
  }
});

module.exports = router;
