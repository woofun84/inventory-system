/**
 * 系统参数（类别/单位/去向等）
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const docno = require('../services/docno');

const router = express.Router();

// --- 参数 ---
router.get('/api/params', (req, res) => {
  const currency = db.prepare("SELECT value FROM params WHERE key='currency'").get().value;
  const categories = db.prepare("SELECT * FROM categories ORDER BY id").all();
  const units = db.prepare("SELECT * FROM units ORDER BY id").all();
  const destinations = db.prepare("SELECT * FROM destinations ORDER BY id").all();
  // 单据编号规则（当前生效值 + 各类型默认值，供设置页展示与恢复默认）
  const rules = docno.getRules();
  const docNoRules = {
    prefixes: rules.prefixes,
    pad: rules.pad,
    defaults: docno.DEFAULT_PREFIXES,
    defaultPad: docno.DEFAULT_PAD,
    labels: Object.fromEntries(docno.TYPE_KEYS.map(k => [k, docno.TYPES[k].label]))
  };
  res.json({ currency, categories, units, destinations, docNoRules });
});

router.post('/api/params/:type', requirePerm('settings', 'create'), (req, res) => {
  const { name, prefix } = req.body;
  const type = req.params.type;
  const tableMap = { categories: 'categories', units: 'units', destinations: 'destinations' };
  const table = tableMap[type];
  if (!table) return res.status(400).json({ error: '无效类型' });
  try {
    if (table === 'categories') {
      db.prepare("INSERT INTO categories (name, prefix) VALUES (?, ?)").run(name, prefix || '');
    } else {
      db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/params/:type/:id', requirePerm('settings', 'delete'), (req, res) => {
  const tableMap = { categories: 'categories', units: 'units', destinations: 'destinations' };
  const table = tableMap[req.params.type];
  if (!table) return res.status(400).json({ error: '无效类型' });
  try {
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// 保存单据编号规则（前缀 + 序号位数）
router.put('/api/params/doc-no-rules', requirePerm('settings', 'edit'), (req, res) => {
  const { prefixes, pad } = req.body;
  try {
    const rules = docno.setRules(prefixes, pad);
    res.json({ success: true, docNoRules: rules });
  } catch (e) {
    res.status(e.invalid ? 400 : 500).json({ error: e.message });
  }
});


module.exports = router;
