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
const audit = require('../services/audit');
const materialImages = require('../services/material-images');

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

// ==================== 删除前的引用检查 ====================
// materials.code 被 7 张表外键引用（inbound / outbound / order_lines / stock_adjustments /
// stocktake_lines / stock_ledger / stock_balance）。直接 DELETE 一旦撞上引用就抛
// "FOREIGN KEY constraint failed"，以前统一包成 400 且原文是英文，用户看不出还剩什么。
// 这里先算清引用，能删的连自身期初流水与结存快照一起清掉，不能删的返回 409 + 具体原因。
const REF_TABLES = [
  { table: 'inbound', key: 'inbound', label: '入库明细', label_en: 'inbound line(s)', docCol: 'grn_no' },
  { table: 'outbound', key: 'outbound', label: '出库明细', label_en: 'outbound line(s)', docCol: 'gin_no' },
  { table: 'order_lines', key: 'order_lines', label: '采购订单明细', label_en: 'purchase order line(s)', docCol: 'po_no' },
  { table: 'stocktake_lines', key: 'stocktake_lines', label: '盘点明细', label_en: 'stocktake line(s)', docCol: 'stocktake_no' },
  { table: 'stock_adjustments', key: 'stock_adjustments', label: '库存调整记录', label_en: 'stock adjustment(s)', docCol: 'stocktake_no' },
];
const tableExists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
// 改编码时必须级联更新的引用表（全部以 materials.code 为外键）
const CODE_REF_TABLES = [...REF_TABLES.map(t => t.table), 'stock_ledger', 'stock_balance'];

function materialDeleteBlockers(material) {
  const code = material.code;
  const blockers = [];
  const ledger = db.prepare("SELECT COUNT(*) AS n FROM stock_ledger WHERE code=? AND source_type<>'opening'").get(code).n;
  if (ledger) {
    const samples = db.prepare(`SELECT DISTINCT source_doc_id AS d FROM stock_ledger
      WHERE code=? AND source_type<>'opening' AND source_doc_id<>'' LIMIT 3`).all(code).map(r => r.d);
    blockers.push({ key: 'ledger', count: ledger, label: '库存流水', label_en: 'stock movement(s)', samples });
  }
  for (const t of REF_TABLES) {
    if (!tableExists(t.table)) continue;
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t.table} WHERE code=?`).get(code).n;
    if (!n) continue;
    const samples = t.docCol ? db.prepare(`SELECT DISTINCT ${t.docCol} AS d FROM ${t.table}
      WHERE code=? AND COALESCE(${t.docCol},'')<>'' LIMIT 3`).all(code).map(r => r.d) : [];
    blockers.push({ key: t.key, count: n, label: t.label, label_en: t.label_en, samples });
  }
  // 库存与期初都按「数量」判断：非零说明还没清零，先清零再删
  const bal = db.prepare('SELECT stock_qty FROM stock_balance WHERE code=?').get(code);
  const stockQty = Number(bal && bal.stock_qty) || 0;
  if (stockQty !== 0) {
    // stock_balance.stock_qty 与 materials.opening_qty 同为录入口径数量，直接展示
    blockers.push({ key: 'balance', count: stockQty, label: '库存结存数量', label_en: 'stock on hand', samples: [] });
  }
  const openingQty = Number(material.opening_qty) || 0;
  if (openingQty !== 0) {
    // materials.opening_qty 是录入口径的数量（与 stock_ledger 的定点整数不同），直接展示
    blockers.push({ key: 'opening', count: openingQty, label: '期初数量', label_en: 'opening qty', samples: [] });
  }
  return blockers;
}

function materialInUsePayload(material, blockers) {
  const zhParts = blockers.map(b => (b.key === 'balance' || b.key === 'opening')
    ? `${b.label} ${b.count}`
    : `${b.label} ${b.count} 条`).join('、');
  const enParts = blockers.map(b => `${b.count} ${b.label_en}`).join(', ');
  const samples = blockers.filter(b => b.samples && b.samples.length)
    .map(b => b.samples.join('、')).join('；');
  return {
    code: 'MATERIAL_IN_USE',
    error: `物料 ${material.code} 不能删除：还有 ${zhParts}${samples ? `（相关单号：${samples}）` : ''}。请先作废或更正相关单据，并把库存、期初数量清零后再删除；若这些记录需要保留，请把物料状态改为「停用」`,
    error_en: `Material ${material.code} cannot be deleted: still referenced by ${enParts}. Please void or correct the related documents and clear stock/opening quantity first; if this history must be kept, set the material to Inactive instead.`,
    details: { code: material.code, blockers },
  };
}

// ==================== 批量新增（批量弹窗 / CSV 导入共用） ====================
// 单条新增与批量新增必须完全同源：编码归一、四字段唯一、期初流水同步都走下面两个函数。
const BATCH_LIMIT = 500;
// 与 uq_materials_identity 同口径：trim + 仅折叠 ASCII 大小写（SQLite lower() 只处理 ASCII）
const identityKey = m => IDENTITY_FIELDS
  .map(f => txt(m[f]).replace(/[A-Z]/g, c => c.toLowerCase()))
  .join('\u0001');

const FIELD_LABELS = {
  code: ['编码', 'Code'], category: ['类别', 'Category'], name: ['名称', 'Name'],
  spec: ['规格', 'Specification'], brand: ['品牌', 'Brand'], unit: ['单位', 'Unit'],
  opening_qty: ['期初数量', 'Opening Qty'], opening_price: ['期初单价', 'Opening Price'],
  min_stock: ['安全库存', 'Min Stock'],
};

// 编码留空按类别前缀自动生成；同一批内已占用的编码继续往后推，避免批内撞号
function nextFreeCode(category, used) {
  let code = genMaterialCode(category);
  let guard = 0;
  while ((used.has(code) || db.prepare('SELECT 1 FROM materials WHERE code=?').get(code)) && guard++ < 10000) {
    const mm = /^(.*?)(\d+)$/.exec(code);
    if (!mm) break;
    code = mm[1] + String(Number(mm[2]) + 1).padStart(mm[2].length, '0');
  }
  return code;
}

// 单条新增原有的归一化，原样抽出来给批量复用
function normalizeMaterial(raw, req) {
  const m = { ...(raw || {}) };
  m.code = txt(m.code);
  if (!m.code || m.code.toLowerCase() === 'auto') m.code = '';
  else m.code = m.code.toUpperCase();
  // 无价格权限的表单不渲染期初单价，也不会回传该字段：新建默认 0
  if (!req.canViewPrice && m.opening_price === undefined) m.opening_price = 0;
  m.opening_qty = Number(m.opening_qty) || 0;
  m.opening_price = Number(m.opening_price) || 0;
  m.min_stock = Number(m.min_stock) || 0;
  if (m.status === undefined) m.status = '';
  return m;
}

// 物料与期初流水同事务写入：保存即入账，不会出现物料改了流水没写
function insertMaterial(m) {
  db.prepare(`INSERT INTO materials (code,name,spec,category,unit,opening_qty,opening_price,min_stock,brand,status)
    VALUES (@code,@name,@spec,@category,@unit,@opening_qty,@opening_price,@min_stock,@brand,@status)`).run({
    code: m.code, name: m.name || '', spec: m.spec || '', category: m.category || '',
    unit: m.unit || '', opening_qty: m.opening_qty, opening_price: m.opening_price,
    min_stock: m.min_stock, brand: m.brand || '', status: m.status || '',
  });
  syncOpeningLedger(m.code, m.opening_qty, m.opening_price);
}

// 批量接口由路由逐条写审计，形态与单条新增保持一致（一条物料一条 create）
function auditCreated(req, m) {
  const u = req.user || {};
  audit.record({
    user_id: u.id || null, username: u.username || '', name: u.name || '', role: u.role || '',
    module: 'materials', action: 'create', target: m.code,
    method: req.method, path: req.originalUrl.split('?')[0],
    ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
    status: 200, detail: audit.summarize(m),
  });
}

function auditImage(req, action, code) {
  const u = req.user || {};
  audit.record({
    user_id: u.id || null, username: u.username || '', name: u.name || '', role: u.role || '',
    module: 'materials', action, target: code,
    method: req.method, path: req.originalUrl.split('?')[0],
    ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
    status: 200,
    detail: { key: 'audit_detail_material_image', params: { action: action === 'image-upload' ? 'upload' : 'delete' } },
  });
}

function rowErr(field, zh, en) {
  return { field, message: zh, message_en: en };
}

function batchRowPayload(rows) {
  return {
    code: 'MATERIAL_BATCH_INVALID',
    error: `共 ${rows.length} 行校验未通过，整批未写入`,
    error_en: `${rows.length} row(s) failed validation; nothing was saved.`,
    details: { rows },
    rows,
  };
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
  const m = normalizeMaterial(req.body, req);
  try {
    if (!m.code) m.code = genMaterialCode(m.category);
    if (db.prepare('SELECT 1 FROM materials WHERE code=?').get(m.code)) {
      return res.status(409).json(codeExistsPayload(m.code));
    }
    const dup = findMaterialDuplicate(m, '');
    if (dup) return res.status(409).json(materialDupPayload(m, dup));

    db.transaction(() => insertMaterial(m))();
    res.json({ success: true, code: m.code });
  } catch (e) {
    const conflict = sqliteConflictPayload(e, m, '');
    if (conflict) return res.status(conflict.status).json(conflict.body);
    res.status(400).json({ error: e.message });
  }
});

// 批量新增：先整批校验，任一行不通过不写库；通过后单事务逐条插入，失败整批回滚
router.post('/api/materials/batch', requirePerm('materials', 'create'), (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body) ? body : body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ code: 'MATERIAL_BATCH_EMPTY', error: '无数据', error_en: 'No data' });
  }
  if (items.length > BATCH_LIMIT) {
    return res.status(400).json({
      code: 'MATERIAL_BATCH_TOO_LARGE',
      error: `单次最多 ${BATCH_LIMIT} 行，请分批提交`,
      error_en: `At most ${BATCH_LIMIT} rows per batch; please split the request.`,
    });
  }

  const cats = new Set(db.prepare('SELECT name FROM categories').all().map(r => r.name));
  const unitSet = new Set(db.prepare('SELECT name FROM units').all().map(r => r.name));
  const existingCodes = new Set(db.prepare('SELECT code FROM materials').all().map(r => String(r.code).toUpperCase()));
  const usedCodes = new Set();
  const identityFirst = new Map();
  const prepared = [];
  const badRows = [];

  items.forEach((raw, i) => {
    const row = i + 1;
    const line = Number(raw && raw.line) || row;
    const m = normalizeMaterial(raw, req);
    const errs = [];
    const label = f => FIELD_LABELS[f];
    const required = f => {
      if (!txt(m[f])) errs.push(rowErr(f, `${label(f)[0]}不能为空`, `${label(f)[1]} is required`));
    };

    required('category');
    required('name');
    required('unit');
    if (txt(m.category) && !cats.has(txt(m.category))) {
      errs.push(rowErr('category', `类别「${txt(m.category)}」不在参数设置中`,
        `Category "${txt(m.category)}" is not in settings`));
    }
    if (txt(m.unit) && !unitSet.has(txt(m.unit))) {
      errs.push(rowErr('unit', `单位「${txt(m.unit)}」不在参数设置中`,
        `Unit "${txt(m.unit)}" is not in settings`));
    }
    ['opening_qty', 'opening_price', 'min_stock'].forEach(f => {
      const v = raw && raw[f];
      if (v !== undefined && v !== null && String(v).trim() !== '' && isNaN(Number(v))) {
        errs.push(rowErr(f, `${label(f)[0]}必须是数字`, `${label(f)[1]} must be a number`));
      }
    });

    // 编码：留空按类别前缀生成；显式编码查批内与库内重复
    if (!m.code) {
      if (cats.has(txt(m.category))) m.code = nextFreeCode(txt(m.category), usedCodes);
    } else {
      if (usedCodes.has(m.code)) {
        errs.push(rowErr('code', `编码 ${m.code} 在本批次内重复`, `Code ${m.code} is duplicated in this batch`));
      } else if (existingCodes.has(m.code)) {
        errs.push(rowErr('code', `编码 ${m.code} 已存在`, `${m.code} already exists`));
      }
    }
    if (m.code) usedCodes.add(m.code);

    // 四字段：先查本批，再查库（与 uq_materials_identity 完全同口径）
    if (txt(m.name)) {
      const key = identityKey(m);
      if (identityFirst.has(key)) {
        const first = identityFirst.get(key);
        errs.push(rowErr('name', `与第 ${first} 行重复（类别+名称+规格+品牌）`,
          `Duplicate of row ${first} (category+name+spec+brand)`));
      } else {
        const dup = findMaterialDuplicate(m, '');
        if (dup) {
          errs.push(rowErr('name', `与已有物料 ${dup.code} 重复（类别+名称+规格+品牌）`,
            `Duplicate of existing material ${dup.code} (category+name+spec+brand)`));
        } else {
          identityFirst.set(key, row);
        }
      }
    }

    if (errs.length) badRows.push({ row, line, code: m.code, errors: errs });
    else prepared.push({ row, line, m });
  });

  if (badRows.length) {
    // 失败也留痕，便于审计追溯
    audit.record({
      user_id: (req.user || {}).id || null, username: (req.user || {}).username || '',
      name: (req.user || {}).name || '', role: (req.user || {}).role || '',
      module: 'materials', action: 'create', target: '',
      method: req.method, path: req.originalUrl.split('?')[0],
      ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
      status: 400, detail: audit.summarize({ failed: badRows.length, lines: badRows.map(r => r.line) }),
    });
    return res.status(400).json(batchRowPayload(badRows));
  }

  try {
    db.transaction(() => {
      prepared.forEach(p => {
        try {
          insertMaterial(p.m);
        } catch (e) {
          const conflict = sqliteConflictPayload(e, p.m, '');
          const errors = conflict
            ? [rowErr((conflict.body.details || {}).field || 'code', conflict.body.error, conflict.body.error_en)]
            : [rowErr('', e.message, e.message)];
          const err = new Error('MATERIAL_BATCH_ROW_FAILED');
          err.failRow = { row: p.row, line: p.line, code: p.m.code, errors };
          throw err;
        }
      });
    }).immediate();
  } catch (e) {
    if (e.failRow) {
      return res.status(400).json({
        code: 'MATERIAL_BATCH_FAILED',
        error: '批量写入失败，整批已回滚',
        error_en: 'Batch insert failed; the whole batch was rolled back.',
        details: { rows: [e.failRow] },
        rows: [e.failRow],
      });
    }
    return res.status(400).json({ error: e.message });
  }

  prepared.forEach(p => auditCreated(req, {
    code: p.m.code, name: p.m.name || '', spec: p.m.spec || '', category: p.m.category || '',
    unit: p.m.unit || '', opening_qty: p.m.opening_qty, opening_price: p.m.opening_price,
    min_stock: p.m.min_stock, brand: p.m.brand || '', status: p.m.status || '',
  }));

  res.json({
    success: true,
    count: prepared.length,
    created: prepared.map(p => ({ row: p.row, line: p.line, code: p.m.code })),
  });
});

// CSV 导入模板：表头 + 一行示例 + 一行 # 说明，UTF-8 BOM 保证 Excel 直接打开不乱码
const TEMPLATE_TEXT = {
  zh: {
    headers: ['编码', '类别', '名称', '规格', '品牌', '单位', '期初数量', '期初单价', '安全库存'],
    example: ['', '{category}', 'A4 打印纸', '70g 500张/包', '得力', '{unit}', '10', '25.50', '5'],
    note: '# 说明：编码留空则按类别前缀自动生成；类别/单位须与参数设置一致；数量/单价/安全库存留空按 0；空行与 # 开头的行会被忽略',
  },
  en: {
    headers: ['Code', 'Category', 'Name', 'Specification', 'Brand', 'Unit', 'Opening Qty', 'Opening Price', 'Min Stock'],
    example: ['', '{category}', 'A4 Copy Paper', '70g 500 sheets/pack', 'Deli', '{unit}', '10', '25.50', '5'],
    note: '# Notes: leave code blank to auto-generate; category/unit must match settings; blank qty/price/min stock default to 0; blank lines and lines starting with # are ignored',
  },
};

router.get('/api/materials/import-template', requirePerm('materials', 'view'), (req, res) => {
  const tpl = TEMPLATE_TEXT[req.query.lang === 'en' ? 'en' : 'zh'];
  const cat = db.prepare('SELECT name FROM categories ORDER BY id LIMIT 1').get();
  const unit = db.prepare('SELECT name FROM units ORDER BY id LIMIT 1').get();
  const example = tpl.example.map(v => v
    .replace('{category}', cat ? cat.name : (req.query.lang === 'en' ? 'Office' : '办公用品'))
    .replace('{unit}', unit ? unit.name : (req.query.lang === 'en' ? 'pcs' : '个')));
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [tpl.headers, example, [tpl.note]]
    .map(r => r.map(cell).join(','))
    .join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="materials-import-template.csv"');
  res.send('\ufeff' + csv);
});

// 单条详情：不存在一律 404，供前端/外部调用方明确区分「没有这条」与「参数不合法」
router.get('/api/materials/:code', requirePerm('materials', 'view'), (req, res) => {
  const code = txt(req.params.code);
  const row = db.prepare(`
    SELECT m.*, COALESCE((SELECT b.stock_qty FROM stock_balance b WHERE b.code = m.code), 0) AS on_hand,
      EXISTS(SELECT 1 FROM stock_ledger l WHERE l.code = m.code AND l.source_type <> 'opening') AS opening_locked
    FROM materials m WHERE m.code = ?`).get(code);
  if (!row) return res.status(404).json({ code: 'MATERIAL_NOT_FOUND', error: '物料不存在或已被删除', error_en: 'Material not found or already deleted' });
  res.json(maskRows(req, [row], ['opening_price'])[0]);
});

router.put('/api/materials/:code', requirePerm('materials', 'edit'), (req, res) => {
  const oldCode = txt(req.params.code);
  const m = { ...req.body };
  // 编码与新增同口径：trim 后统一大写；空值或 'auto' 视为「不改编码」
  const entered = txt(m.code);
  const newCode = (!entered || entered.toLowerCase() === 'auto') ? oldCode : entered.toUpperCase();
  try {
    const cur = db.prepare('SELECT * FROM materials WHERE code=?').get(oldCode);
    if (!cur) return res.status(404).json({ code: 'MATERIAL_NOT_FOUND', error: '物料不存在或已被删除', error_en: 'Material not found or already deleted' });
    const codeChanged = newCode !== oldCode;
    // 唯一性口径与新增一致：忽略首尾空格与大小写；编辑时排除自身
    if (codeChanged) {
      const hit = db.prepare('SELECT code FROM materials WHERE lower(trim(code)) = lower(?) AND code <> ? LIMIT 1')
        .get(newCode, oldCode);
      if (hit) return res.status(409).json(codeExistsPayload(hit.code));
    }
    // 无价格权限编辑时前端不提交 opening_price：沿用数据库原值，不能写成 0
    if (!req.canViewPrice && m.opening_price === undefined) m.opening_price = cur.opening_price;
    const openingQty = m.opening_qty === undefined ? Number(cur.opening_qty) || 0 : Number(m.opening_qty) || 0;
    const openingPrice = m.opening_price === undefined ? Number(cur.opening_price) || 0 : Number(m.opening_price) || 0;
    // 用定点整数比较，避免浮点误差把「未变更」误判成修改
    const openingChanged = units.toQtyInt(openingQty) !== units.toQtyInt(cur.opening_qty || 0)
      || units.toPriceInt(openingPrice) !== units.toPriceInt(cur.opening_price || 0);
    // 修改排除自身：只跟其它物料比较四字段
    const dup = findMaterialDuplicate(m, oldCode);
    if (dup) return res.status(409).json(materialDupPayload(m, dup));
    const tx = db.transaction(() => {
      // 改编码要在同一事务里级联更新所有引用表；SQLite 外键默认立即校验，
      // 先延迟到提交时统一校验，避免「父档已改、子表还没改」或反过来的中间态报错
      if (codeChanged) db.pragma('defer_foreign_keys = ON');
      // 期初锁在写锁内判定：并发过账不会在读校验与保存之间插入流水
      if (openingChanged && hasNonOpeningLedger(oldCode)) {
        const e = new Error('MATERIAL_OPENING_LOCKED');
        e.status = 409;
        e.body = openingLockedPayload({ code: oldCode, opening_qty: cur.opening_qty, opening_price: cur.opening_price });
        throw e;
      }
      if (codeChanged) {
        for (const table of CODE_REF_TABLES) {
          if (!tableExists(table)) continue;
          db.prepare(`UPDATE ${table} SET code=? WHERE code=?`).run(newCode, oldCode);
        }
      }
      db.prepare(`UPDATE materials SET code=@code,name=@name,spec=@spec,category=@category,unit=@unit,
        opening_qty=@opening_qty,opening_price=@opening_price,min_stock=@min_stock,
        brand=@brand,status=@status,updated_at=datetime('now')
        WHERE code=@oldCode`).run({ ...m, code: newCode, oldCode, opening_qty: openingQty, opening_price: openingPrice, status: m.status === undefined ? cur.status : m.status });
      if (openingChanged) syncOpeningLedger(newCode, openingQty, openingPrice);
    });
    tx.immediate();
    // 编码变更单独留一条审计（旧码 → 新码），并跳过中间件的通用 update 记录避免重复
    if (codeChanged) {
      req.skipGenericAudit = true;
      const u = req.user || {};
      audit.record({
        user_id: u.id || null,
        username: u.username || '',
        name: u.name || '',
        role: u.role || '',
        module: 'materials',
        action: 'update',
        target: newCode,
        method: 'PUT',
        path: req.originalUrl.split('?')[0],
        ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
        status: 200,
        detail: JSON.stringify({ code: newCode, old_code: oldCode }),
      });
    }
    res.json({ success: true, code: newCode });
  } catch (e) {
    if (e.body) return res.status(e.status || 409).json(e.body);
    const msg = String((e && e.message) || '');
    // 盘点明细对 (盘点单, 编码) 有唯一约束：新编码已出现在同一张盘点单里时给出可操作提示
    if (/UNIQUE constraint failed: stocktake_lines\./.test(msg)) {
      return res.status(409).json({
        code: 'MATERIAL_CODE_CONFLICT_STOCKTAKE',
        error: `编码 ${newCode} 与盘点单中已有明细冲突（同一盘点单不能出现两条相同编码），请先处理盘点记录后再改编码`,
        error_en: `Code ${newCode} conflicts with an existing stocktake line (the same code cannot appear twice in one stocktake). Please resolve that stocktake first.`,
      });
    }
    const conflict = sqliteConflictPayload(e, { ...m, code: newCode }, newCode);
    if (conflict) return res.status(conflict.status).json(conflict.body);
    res.status(500).json({ code: 'MATERIAL_UPDATE_FAILED', error: `保存物料失败：${msg}`, error_en: `Failed to save material: ${msg}` });
  }
});

// ==================== 参考图片 ====================
// 前端在浏览器里压缩到长边 800px / 300KB 内，这里再按魔数校验类型与体积。
// 文件名固定为 <物料 id>.<ext>，因此改编码不会影响图片。
router.post('/api/materials/:code/image', requirePerm('materials', 'edit'),
  express.raw({ type: 'application/octet-stream', limit: '8mb' }),
  (req, res) => {
    const code = txt(req.params.code);
    const m = db.prepare('SELECT id, code FROM materials WHERE code=?').get(code);
    if (!m) return res.status(404).json({ code: 'MATERIAL_NOT_FOUND', error: '物料不存在或已被删除', error_en: 'Material not found or already deleted' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) {
      return res.status(400).json({ code: 'IMAGE_EMPTY', error: '请选择要上传的图片', error_en: 'Please choose an image to upload' });
    }
    const info = materialImages.detect(buf);
    if (!info) {
      return res.status(400).json({
        code: 'IMAGE_TYPE_INVALID',
        error: '仅支持 JPG / PNG / WebP 图片（服务端按文件内容识别，不看扩展名）',
        error_en: 'Only JPG / PNG / WebP images are supported (detected by file content, not extension)',
      });
    }
    if (buf.length > materialImages.MAX_BYTES) {
      return res.status(413).json({
        code: 'IMAGE_TOO_LARGE',
        error: '图片超过 300KB，请重新选择（前端压缩失败时会出现）',
        error_en: 'Image exceeds 300KB, please choose another one (this happens when browser compression fails)',
      });
    }
    try {
      const rel = materialImages.saveImage(m.id, buf, info.ext);
      db.prepare("UPDATE materials SET image_path=?, image_updated_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
        .run(rel, m.id);
      const row = db.prepare('SELECT image_path, image_updated_at FROM materials WHERE id=?').get(m.id);
      req.skipGenericAudit = true;
      auditImage(req, 'image-upload', code);
      res.json({ success: true, image_path: row.image_path, image_updated_at: row.image_updated_at });
    } catch (e) {
      res.status(500).json({
        code: 'IMAGE_SAVE_FAILED',
        error: `保存图片失败：${e.message}`,
        error_en: `Failed to save image: ${e.message}`,
      });
    }
  });

router.delete('/api/materials/:code/image', requirePerm('materials', 'edit'), (req, res) => {
  const code = txt(req.params.code);
  const m = db.prepare('SELECT id, code, image_path FROM materials WHERE code=?').get(code);
  if (!m) return res.status(404).json({ code: 'MATERIAL_NOT_FOUND', error: '物料不存在或已被删除', error_en: 'Material not found or already deleted' });
  try {
    materialImages.deleteImageFiles(m.id);
    db.prepare("UPDATE materials SET image_path='', image_updated_at='', updated_at=datetime('now') WHERE id=?").run(m.id);
    req.skipGenericAudit = true;
    auditImage(req, 'image-delete', code);
    res.json({ success: true, image_path: '', image_updated_at: '' });
  } catch (e) {
    res.status(500).json({
      code: 'IMAGE_DELETE_FAILED',
      error: `删除图片失败：${e.message}`,
      error_en: `Failed to delete image: ${e.message}`,
    });
  }
});

router.delete('/api/materials/:code', requirePerm('materials', 'delete'), (req, res) => {
  const code = txt(req.params.code);
  try {
    const cur = db.prepare('SELECT * FROM materials WHERE code=?').get(code);
    if (!cur) return res.status(404).json({ code: 'MATERIAL_NOT_FOUND', error: '物料不存在或已被删除', error_en: 'Material not found or already deleted' });
    const blockers = materialDeleteBlockers(cur);
    if (blockers.length) return res.status(409).json(materialInUsePayload(cur, blockers));
    const tx = db.transaction(() => {
      // 走到这里说明没有任何业务引用，只剩物料自身的期初流水与结存快照（也是 FK 引用），一并清掉再删主档
      db.prepare("DELETE FROM stock_ledger WHERE code=? AND source_type='opening'").run(code);
      db.prepare('DELETE FROM stock_balance WHERE code=?').run(code);
      db.prepare('DELETE FROM materials WHERE code=?').run(code);
    });
    tx.immediate();
    // 物料已删除，图片文件按 id 一并清理，避免留下孤儿文件
    materialImages.deleteImageFiles(cur.id);
    res.json({ success: true });
  } catch (e) {
    // 校验与删除之间可能有并发写入；FK 失败按业务冲突返回，不再用 400 含糊过去
    if (/FOREIGN KEY constraint failed/i.test(String(e.message))) {
      return res.status(409).json({
        code: 'MATERIAL_IN_USE',
        error: `物料 ${code} 正在被其他单据或流水引用，删除失败。请刷新列表后确认还剩哪些记录`,
        error_en: `Material ${code} is still referenced by other documents or movements, so it cannot be deleted. Refresh the list to see what remains.`,
        details: { code },
      });
    }
    res.status(500).json({
      code: 'MATERIAL_DELETE_FAILED',
      error: `删除物料失败：${e.message}`,
      error_en: `Failed to delete material: ${e.message}`,
    });
  }
});


module.exports = router;
