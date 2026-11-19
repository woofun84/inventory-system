/**
 * 系统参数（类别/单位/去向等）
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const { hasGrant } = require('../permissions');
const docno = require('../services/docno');

const router = express.Router();

// 领用去向默认常用项：现已落库为真实记录（见 db.js 的 destinations_seeded 补种），
// 保留此常量仅为文档说明用途，接口始终读真实表，不再返回不可删除的虚拟内置项。
const PARAM_LABELS = { categories: '类别', units: '单位', destinations: '领用去向' };

// --- 参数 ---
router.get('/api/params', (req, res) => {
  // 全站统一人民币：库中历史值可能是文档示例里的外币代码（如 SAR），对外一律按 ¥ 返回，不写库
  const currency = '¥';
  const categories = db.prepare("SELECT * FROM categories ORDER BY id").all();
  const units = db.prepare("SELECT * FROM units ORDER BY id").all();
  const destinations = db.prepare("SELECT * FROM destinations ORDER BY id").all();
  const destinationsEmpty = destinations.length === 0;
  // 单据编号规则仅设置页消费，只发给有 settings.view 权限的用户；
  // 类别/单位/去向是全站基础字典，所有登录用户都需要，保持可见。
  const body = { currency, categories, units, destinations, destinationsEmpty };
  if (hasGrant(req.grants, 'settings', 'view')) {
    const rules = docno.getRules();
    body.docNoRules = {
      prefixes: rules.prefixes,
      pad: rules.pad,
      dateStyle: rules.dateStyle,
      dateStyles: docno.DATE_STYLES,
      defaults: docno.DEFAULT_PREFIXES,
      defaultPad: docno.DEFAULT_PAD,
      labels: Object.fromEntries(docno.TYPE_KEYS.map(k => [k, docno.TYPES[k].label]))
    };
  }
  res.json(body);
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

// 删除前查引用：类别/单位被物料档案按名称文本引用，去向被出库单按名称文本引用。
// 都是纯文本字段（无外键），若不拦截会留下孤儿值，筛选下拉里消失但历史数据仍在。
// 返回被引用数量，供后端拒绝并提示先转移，避免数据口径不一致。
const REF_CHECK = {
  categories: { table: 'materials', col: 'category' },
  units: { table: 'materials', col: 'unit' },
  destinations: { table: 'outbound', col: 'destination' },
};

function referenceCount(type, name) {
  const ref = REF_CHECK[type];
  if (!ref || !name) return 0;
  return db.prepare(`SELECT COUNT(*) n FROM ${ref.table} WHERE ${ref.col}=?`).get(name).n;
}

router.delete('/api/params/:type/:id', requirePerm('settings', 'delete'), (req, res) => {
  const tableMap = { categories: 'categories', units: 'units', destinations: 'destinations' };
  const table = tableMap[req.params.type];
  if (!table) return res.status(400).json({ error: '无效类型' });
  try {
    const row = db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: '该项不存在' });
    const used = referenceCount(req.params.type, row.name);
    if (used > 0) {
      return res.status(409).json({
        error: `「${row.name}」已被 ${used} 条记录使用，请先修改这些记录后再删除`,
        code: 'PARAM_IN_USE',
        refCount: used,
      });
    }
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
    req.auditTarget = '参数：' + PARAM_LABELS[req.params.type] + (row && row.name ? '-' + row.name : '');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// 保存单据编号规则（前缀 + 序号位数）
router.put('/api/params/doc-no-rules', requirePerm('settings', 'edit'), (req, res) => {
  const { prefixes, pad, dateStyle } = req.body;
  try {
    const before = docno.getRules();
    const rules = docno.setRules(prefixes, pad, dateStyle);
    // 审计对象写明实际改动的单据类型，而不是内部路径键 doc-no-rules
    const changed = docno.TYPE_KEYS
      .filter(k => String((prefixes || {})[k] || '').trim().toUpperCase() !== String(before.prefixes[k] || '').toUpperCase())
      .map(k => docno.TYPES[k].label);
    if (pad != null && Number(pad) !== Number(before.pad)) changed.push('序号位数');
    if (dateStyle && dateStyle !== before.dateStyle) changed.push('日期格式');
    req.auditTarget = '参数：单号规则' + (changed.length
      ? '-' + changed.slice(0, 3).join('、') + (changed.length > 3 ? '等' : '')
      : '');
    res.json({ success: true, docNoRules: rules });
  } catch (e) {
    if (e.invalid) return res.status(400).json({ error: e.message });
    console.error('[params] save doc-no-rules failed:', e);
    res.status(500).json({ error: '保存单号规则失败，请稍后重试' });
  }
});


// 单号规则实时预览：用「待保存的前缀/位数 + 当天」算真实下一号，便于保存前确认
// 注意：路径不能是 /api/params/:type 的子形态，否则会被上面的通用参数写入路由截获
router.post('/api/params/docno/preview', requirePerm('settings', 'view'), (req, res) => {
  // 只读预览，不产生业务变更，不写审计（避免日志里出现内部键名 preview）
  req.skipGenericAudit = true;
  const { prefixes, pad, date, dateStyle } = req.body || {};
  const p = Number(pad);
  if (!Number.isInteger(p) || p < 1 || p > 8) return res.status(400).json({ error: '序号位数需为 1-8 的整数' });
  try {
    const previews = {};
    docno.TYPE_KEYS.forEach(k => {
      const prefix = String((prefixes || {})[k] || '').trim().toUpperCase();
      previews[k] = prefix ? docno.previewDocNo(k, date, prefix, p, dateStyle) : '';
    });
    res.json({ previews });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


module.exports = router;
