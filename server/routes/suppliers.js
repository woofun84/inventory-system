/**
 * 供应商
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const { hasGrant } = require('../permissions');

const router = express.Router();

// 供应商下拉是采购/入库/退货共用的基础数据：任一相关模块有查看权限即可读取
function allowSupplierView(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  const ok = ['suppliers', 'purchase', 'inbound', 'returns'].some(m => hasGrant(req.grants, m, 'view'));
  if (!ok) return res.status(403).json({ error: '权限不足：无该操作权限' });
  next();
}

// --- 供应商 ---
router.get('/api/suppliers', requirePerm('suppliers', 'view'), (req, res) => {
  res.json(db.prepare("SELECT * FROM suppliers ORDER BY status = 'disabled', name").all());
});

// 下拉统一数据源：供应商档案（含停用标记）+ 历史单据里出现但档案缺失的历史值
router.get('/api/suppliers/options', allowSupplierView, (req, res) => {
  const rows = db.prepare("SELECT id,name,contact,phone,remarks,status FROM suppliers ORDER BY name").all();
  const known = new Set(rows.map(r => String(r.name || '').trim().toLowerCase()));
  const hist = db.prepare(`
    SELECT DISTINCT TRIM(supplier) AS name FROM (
      SELECT supplier FROM purchase_orders WHERE TRIM(COALESCE(supplier,'')) <> ''
      UNION SELECT supplier FROM inbound_docs WHERE TRIM(COALESCE(supplier,'')) <> ''
      UNION SELECT supplier FROM contracts WHERE TRIM(COALESCE(supplier,'')) <> ''
    ) ORDER BY name`).all()
    .map(r => String(r.name || '').trim())
    .filter(n => n && !known.has(n.toLowerCase()));
  res.json([
    ...rows.map(r => ({
      id: r.id, name: r.name, contact: r.contact || '', phone: r.phone || '',
      status: r.status || 'active', historical: false,
    })),
    ...hist.map(n => ({ id: 0, name: n, contact: '', phone: '', status: '', historical: true })),
  ]);
});

router.post('/api/suppliers', requirePerm('suppliers', 'create'), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: '供应商名称不能为空' });
  try {
    const exist = db.prepare("SELECT id,status FROM suppliers WHERE name = ?").get(name);
    if (exist) {
      if (exist.status !== 'disabled') return res.status(400).json({ error: `供应商已存在：${name}` });
      // 同名停用记录直接恢复，避免同一家单位出现两条档案
      db.prepare("UPDATE suppliers SET contact=@contact,phone=@phone,remarks=@remarks,status='active' WHERE id=@id")
        .run({ id: exist.id, contact: b.contact || '', phone: b.phone || '', remarks: b.remarks || '' });
      return res.json({ success: true, restored: true });
    }
    db.prepare("INSERT INTO suppliers (name,contact,phone,remarks,status) VALUES (@name,@contact,@phone,@remarks,'active')")
      .run({ name, contact: b.contact || '', phone: b.phone || '', remarks: b.remarks || '' });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/suppliers/:id', requirePerm('suppliers', 'edit'), (req, res) => {
  try {
    db.prepare("UPDATE suppliers SET name=@name,contact=@contact,phone=@phone,remarks=@remarks WHERE id=@id").run({ ...req.body, id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 停用（软删除）：历史单据引用不受影响，下拉里会标注「停用」
router.delete('/api/suppliers/:id', requirePerm('suppliers', 'delete'), (req, res) => {
  try {
    db.prepare("UPDATE suppliers SET status='disabled' WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/suppliers/:id/enable', requirePerm('suppliers', 'edit'), (req, res) => {
  try {
    db.prepare("UPDATE suppliers SET status='active' WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
