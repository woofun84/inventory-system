/**
 * 物料档案
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const { genMaterialCode } = require('../services/stock');
const { maskRows } = require('../services/price-mask');
const { syncOpeningLedger, hasNonOpeningLedger } = require('../services/costing');
const units = require('../services/units');

const router = express.Router();

// ==================== 唯一性校验（类别+名称+规格+品牌） ====================
// 与 db.js 中的 uq_materials_identity 保持一致：trim + 忽略大小写，空值按空串。
const IDENTITY_FIELDS = ['category', 'name', 'spec', 'brand'];
const txt = v => (v === undefined || v === null ? '' : String(v)).trim();

function findMaterialDuplicate(m, excludeCode) {
  return db.prepare(`SELECT code, name, spec, category, brand FROM materials
    WHERE lower(trim(COALESCE(category,''))) = lower(?)
      AND lower(trim(COALESCE(name,''))) = lower(?)
      AND lower(trim(COALESCE(spec,''))) = lower(?)
      AND lower(trim(COALESCE(brand,''))) = lower(?)
      AND code <> ?
    LIMIT 1`).get(txt(m.category), txt(m.name), txt(m.spec), txt(m.brand), excludeCode || '');
}

function materialDupPayload(m, dup) {
  const v = { category: txt(m.category), name: txt(m.name), spec: txt(m.spec), brand: txt(m.brand) };
  const zh = k => v[k] || '（空）';
  const en = k => v[k] || '(empty)';
  return {
    code: 'MATERIAL_DUPLICATE',
    error: `已存在类别「${zh('category')}」、名称「${zh('name')}」、规格「${zh('spec')}」、品牌「${zh('brand')}」完全相同的物料 ${dup.code}，请调整后再保存`,
    error_en: `Material ${dup.code} already has the same category "${en('category')}", name "${en('name')}", spec "${en('spec')}" and brand "${en('brand')}". Please adjust and try again.`,
    details: {
      fields: IDENTITY_FIELDS,
      values: v,
      conflict: { code: dup.code, name: dup.name, spec: dup.spec, category: dup.category, brand: dup.brand },
    },
  };
}

function openingLockedPayload(m) {
  return {
    code: 'MATERIAL_OPENING_LOCKED',
    error: '该物料已有出入库流水，期初数量与期初单价不可修改。期初业务日期固定为 1970-01-01，必须排在成本回放最前，事后改会倒挂历史成本',
    error_en: 'This material already has stock movements, so opening quantity and price cannot be changed. The opening entry is dated 1970-01-01 and must stay first in cost replay; editing it later would distort historical cost.',
    details: { code: m.code, opening_qty: m.opening_qty, opening_price: m.opening_price },
  };
}

function codeExistsPayload(code) {
  return {
    code: 'MATERIAL_CODE_EXISTS',
    error: `物料编码 ${code} 已存在，请更换编码`,
    error_en: `Material code ${code} already exists. Please use another code.`,
    details: { field: 'code', value: code },
  };
}

// 兜底：并发写入仍可能撞上唯一索引，不再把 SQLite 原文抛给用户
function sqliteConflictPayload(e, m, excludeCode) {
  const msg = String((e && e.message) || '');
  if (/UNIQUE constraint failed: materials\.code/.test(msg)) return { status: 409, body: codeExistsPayload(m.code) };
  if (/uq_materials_identity/.test(msg)) {
    const dup = findMaterialDuplicate(m, excludeCode);
    if (dup) return { status: 409, body: materialDupPayload(m, dup) };
  }
  return null;
}

// --- 物料档案 ---
router.get('/api/materials', requirePerm('materials', 'view'), (req, res) => {
  // on_hand 供「添加明细」即时候选展示当前可用库存；与库存汇总同源（stock_balance）
  // opening_locked：已有期初以外的流水，前端据此置灰期初数量/单价
  const rows = db.prepare(`
    SELECT m.*, COALESCE((SELECT b.stock_qty FROM stock_balance b WHERE b.code = m.code), 0) AS on_hand,
      EXISTS(SELECT 1 FROM stock_ledger l WHERE l.code = m.code AND l.source_type <> 'opening') AS opening_locked
    FROM materials m ORDER BY m.code`).all();
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
  const m = { ...req.body };
  try {
    // 编码：去首尾空格后统一大写（现有编码均为大写，前缀来自类别配置）
    m.code = txt(m.code);
    if (!m.code || m.code.toLowerCase() === 'auto') m.code = genMaterialCode(m.category);
    else m.code = m.code.toUpperCase();

    if (db.prepare('SELECT 1 FROM materials WHERE code=?').get(m.code)) {
      return res.status(409).json(codeExistsPayload(m.code));
    }
    const dup = findMaterialDuplicate(m, '');
    if (dup) return res.status(409).json(materialDupPayload(m, dup));

    // 无价格权限的表单不渲染期初单价，也不会回传该字段：新建默认 0
    if (!req.canViewPrice && m.opening_price === undefined) m.opening_price = 0;
    m.opening_qty = Number(m.opening_qty) || 0;
    m.opening_price = Number(m.opening_price) || 0;
    // 物料与期初流水同事务写入：保存即入账，不会出现物料改了流水没写
    db.transaction(() => {
      db.prepare(`INSERT INTO materials (code,name,spec,category,unit,opening_qty,opening_price,min_stock,brand,status)
        VALUES (@code,@name,@spec,@category,@unit,@opening_qty,@opening_price,@min_stock,@brand,@status)`).run(m);
      syncOpeningLedger(m.code, m.opening_qty, m.opening_price);
    })();
    res.json({ success: true, code: m.code });
  } catch (e) {
    const conflict = sqliteConflictPayload(e, m, '');
    if (conflict) return res.status(conflict.status).json(conflict.body);
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/materials/:code', requirePerm('materials', 'edit'), (req, res) => {
  const m = { ...req.body };
  const code = txt(req.params.code);
  try {
    const cur = db.prepare('SELECT * FROM materials WHERE code=?').get(code);
    if (!cur) return res.status(404).json({ code: 'MATERIAL_NOT_FOUND', error: '物料不存在或已被删除', error_en: 'Material not found or already deleted' });
    // 无价格权限编辑时前端不提交 opening_price：沿用数据库原值，不能写成 0
    if (!req.canViewPrice && m.opening_price === undefined) m.opening_price = cur.opening_price;
    const openingQty = m.opening_qty === undefined ? Number(cur.opening_qty) || 0 : Number(m.opening_qty) || 0;
    const openingPrice = m.opening_price === undefined ? Number(cur.opening_price) || 0 : Number(m.opening_price) || 0;
    // 用定点整数比较，避免浮点误差把「未变更」误判成修改
    const openingChanged = units.toQtyInt(openingQty) !== units.toQtyInt(cur.opening_qty || 0)
      || units.toPriceInt(openingPrice) !== units.toPriceInt(cur.opening_price || 0);
    // 修改排除自身：只跟其它物料比较四字段
    const dup = findMaterialDuplicate(m, code);
    if (dup) return res.status(409).json(materialDupPayload(m, dup));
    const tx = db.transaction(() => {
      // 期初锁在写锁内判定：并发过账不会在读校验与保存之间插入流水
      if (openingChanged && hasNonOpeningLedger(code)) {
        const e = new Error('MATERIAL_OPENING_LOCKED');
        e.status = 409;
        e.body = openingLockedPayload({ code, opening_qty: cur.opening_qty, opening_price: cur.opening_price });
        throw e;
      }
      db.prepare(`UPDATE materials SET name=@name,spec=@spec,category=@category,unit=@unit,
        opening_qty=@opening_qty,opening_price=@opening_price,min_stock=@min_stock,
        brand=@brand,status=@status,updated_at=datetime('now')
        WHERE code=@code`).run({ ...m, code, opening_qty: openingQty, opening_price: openingPrice });
      if (openingChanged) syncOpeningLedger(code, openingQty, openingPrice);
    });
    tx.immediate();
    res.json({ success: true });
  } catch (e) {
    if (e.body) return res.status(e.status || 409).json(e.body);
    const conflict = sqliteConflictPayload(e, { ...m, code }, code);
    if (conflict) return res.status(conflict.status).json(conflict.body);
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
