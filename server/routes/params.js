/**
 * 系统参数（类别/单位/去向等）
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const docno = require('../services/docno');

const router = express.Router();

// 领用去向为空时对外提供内置常用项（不写库；一旦用户自行配置即失效）
const DEFAULT_DESTINATIONS = ['生产领用', '工程领用', '维修', '报废'];
const PARAM_LABELS = { categories: '类别', units: '单位', destinations: '领用去向' };

// --- 参数 ---
router.get('/api/params', (req, res) => {
  // 全站统一人民币：库中历史值可能是文档示例里的外币代码（如 SAR），对外一律按 ¥ 返回，不写库
  const currency = '¥';
  const categories = db.prepare("SELECT * FROM categories ORDER BY id").all();
  const units = db.prepare("SELECT * FROM units ORDER BY id").all();
  let destinations = db.prepare("SELECT * FROM destinations ORDER BY id").all();
  const destinationsEmpty = destinations.length === 0;
  if (destinationsEmpty) {
    destinations = DEFAULT_DESTINATIONS.map(name => ({ id: null, name, builtin: true }));
  }
  // 单据编号规则（当前生效值 + 各类型默认值，供设置页展示与恢复默认）
  const rules = docno.getRules();
  const docNoRules = {
    prefixes: rules.prefixes,
    pad: rules.pad,
    defaults: docno.DEFAULT_PREFIXES,
    defaultPad: docno.DEFAULT_PAD,
    labels: Object.fromEntries(docno.TYPE_KEYS.map(k => [k, docno.TYPES[k].label]))
  };
  res.json({ currency, categories, units, destinations, destinationsEmpty, docNoRules });
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
    req.auditTarget = '参数：' + PARAM_LABELS[type] + (String(name || '').trim() ? '-' + String(name).trim() : '');
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
    const row = db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(req.params.id);
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
    req.auditTarget = '参数：' + PARAM_LABELS[req.params.type] + (row && row.name ? '-' + row.name : '');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// 保存单据编号规则（前缀 + 序号位数）
router.put('/api/params/doc-no-rules', requirePerm('settings', 'edit'), (req, res) => {
  const { prefixes, pad } = req.body;
  try {
    const before = docno.getRules();
    const rules = docno.setRules(prefixes, pad);
    // 审计对象写明实际改动的单据类型，而不是内部路径键 doc-no-rules
    const changed = docno.TYPE_KEYS
      .filter(k => String((prefixes || {})[k] || '').trim().toUpperCase() !== String(before.prefixes[k] || '').toUpperCase())
      .map(k => docno.TYPES[k].label);
    if (pad != null && Number(pad) !== Number(before.pad)) changed.push('序号位数');
    req.auditTarget = '参数：单号规则' + (changed.length
      ? '-' + changed.slice(0, 3).join('、') + (changed.length > 3 ? '等' : '')
      : '');
    res.json({ success: true, docNoRules: rules });
  } catch (e) {
    res.status(e.invalid ? 400 : 500).json({ error: e.message });
  }
});


// 单号规则实时预览：用「待保存的前缀/位数 + 当天」算真实下一号，便于保存前确认
// 注意：路径不能是 /api/params/:type 的子形态，否则会被上面的通用参数写入路由截获
router.post('/api/params/docno/preview', requirePerm('settings', 'view'), (req, res) => {
  // 只读预览，不产生业务变更，不写审计（避免日志里出现内部键名 preview）
  req.skipGenericAudit = true;
  const { prefixes, pad, date } = req.body || {};
  const p = Number(pad);
  if (!Number.isInteger(p) || p < 1 || p > 8) return res.status(400).json({ error: '序号位数需为 1-8 的整数' });
  try {
    const previews = {};
    docno.TYPE_KEYS.forEach(k => {
      const prefix = String((prefixes || {})[k] || '').trim().toUpperCase();
      previews[k] = prefix ? docno.previewDocNo(k, date, prefix, p) : '';
    });
    res.json({ previews });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


module.exports = router;
