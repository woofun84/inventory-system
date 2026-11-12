/**
 * 物料档案
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const { genMaterialCode } = require('../services/stock');
const { maskRows } = require('../services/price-mask');

const router = express.Router();

// --- 物料档案 ---
router.get('/api/materials', requirePerm('materials', 'view'), (req, res) => {
  const rows = db.prepare("SELECT * FROM materials ORDER BY code").all();
  // 无价格权限：期初单价删键（库存数量、预警值等非价格字段保留）
  res.json(maskRows(req, rows, ['opening_price']));
});

// 自动生成物料编码（按类别前缀）
router.get('/api/materials/next-code', requirePerm('materials', 'view'), (req, res) => {
  const category = req.query.category;
  if (!category) return res.status(400).json({ error: '请提供类别' });
  try {
    const code = genMaterialCode(category);
    res.json({ code });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/materials', requirePerm('materials', 'create'), (req, res) => {
  const m = req.body;
  try {
    // 如果 code 为空或 'auto'，自动生成
    if (!m.code || m.code === 'auto') {
      m.code = genMaterialCode(m.category);
    }
    // 无价格权限的表单不渲染期初单价，也不会回传该字段：新建默认 0
    if (!req.canViewPrice && m.opening_price === undefined) m.opening_price = 0;
    db.prepare(`INSERT INTO materials (code,name,spec,category,unit,opening_qty,opening_price,min_stock,brand,status)
      VALUES (@code,@name,@spec,@category,@unit,@opening_qty,@opening_price,@min_stock,@brand,@status)`).run(m);
    res.json({ success: true, code: m.code });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/materials/:code', requirePerm('materials', 'edit'), (req, res) => {
  const m = req.body;
  try {
    // 无价格权限编辑时前端不提交 opening_price：沿用数据库原值，不能写成 0
    if (!req.canViewPrice && m.opening_price === undefined) {
      const cur = db.prepare('SELECT opening_price FROM materials WHERE code=?').get(req.params.code);
      if (cur) m.opening_price = cur.opening_price;
    }
    db.prepare(`UPDATE materials SET name=@name,spec=@spec,category=@category,unit=@unit,
      opening_qty=@opening_qty,opening_price=@opening_price,min_stock=@min_stock,
      brand=@brand,status=@status,updated_at=datetime('now')
      WHERE code=@code`).run({ ...m, code: req.params.code });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/materials/:code', requirePerm('materials', 'delete'), (req, res) => {
  try {
    db.prepare("DELETE FROM materials WHERE code=?").run(req.params.code);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


module.exports = router;
