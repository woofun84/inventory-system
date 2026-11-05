/**
 * 系统日志（审计）接口
 */
const express = require('express');
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

module.exports = router;
