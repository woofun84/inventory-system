/**
 * 入库相关接口（单据列表、明细、草稿/确认/作废、冲销）
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const {
  getAvailableStock,
  validateInboundReturnStock,
  genGrnNo,
  resolveOrderLineId,
  loadPurchaseReturnOrigin,
  loadPurchaseReturnScope,
  getPurchaseReturnOriginLines,
  getPurchaseReturnScopeLines,
  validatePurchaseReturnLines,
} = require('../services/stock');
const docno = require('../services/docno');
const time = require('../services/time');
const sign = require('../services/sign');

// ==================== 采购退货三档（2026-11 第五批） ====================
// 档 1 inbound  关联原入库单；档 2 po/contract 关联采购单/合同；
// 档 3 none 无原单（仅 admin/manager，供应商/单价/原因必填）。
const RETURN_TIERS = ['inbound', 'po', 'contract', 'none'];
const NO_ORIGIN_ROLES = ['admin', 'manager'];

function isPurchaseReturnDoc(docLike) {
  return docLike && docLike.txn_type === '采购退货';
}

function normalizeReturnTier(raw) {
  const v = String(raw || '').trim();
  return RETURN_TIERS.includes(v) ? v : '';
}

function routeFail(code, message) {
  const e = new Error(message);
  e.code = code;
  e.status = 400;
  return e;
}

// 校验单据头的档位字段是否完整、互斥、权限合规
function validateReturnTierHeader(docLike, user) {
  if (!isPurchaseReturnDoc(docLike)) return '';
  const tier = normalizeReturnTier(docLike.return_tier);
  if (!tier) throw routeFail('RETURN_TIER_REQUIRED', '采购退货必须选择关联档位（原入库单/采购单/合同/无原单）');
  if (tier === 'inbound') {
    if (!String(docLike.origin_doc_no || '').trim()) {
      throw routeFail('ORIGIN_DOC_REQUIRED', '关联入库单档必须选择原入库单');
    }
  } else if (tier === 'po' || tier === 'contract') {
    if (!String(docLike.return_ref_no || '').trim()) {
      throw routeFail('RETURN_REF_REQUIRED', '关联采购单/合同档必须选择原采购单号或合同号');
    }
  } else {
    if (!NO_ORIGIN_ROLES.includes(user?.role)) {
      const e = routeFail('RETURN_TIER_FORBIDDEN', '无原单退货仅管理员或主管可用');
      e.status = 403;
      throw e;
    }
    if (!String(docLike.supplier || '').trim()) {
      throw routeFail('SUPPLIER_REQUIRED', '无原单退货必须填写供应商');
    }
    if (!String(docLike.return_reason || '').trim()) {
      throw routeFail('RETURN_REASON_REQUIRED', '无原单退货必须填写原因');
    }
  }
  return tier;
}

// 创建时整理采购退货单头：校验档位、继承供应商/采购单/合同
function prepareReturnHeader(body, txnType, user) {
  if (!isPurchaseReturnDoc({ txn_type: txnType })) {
    return {
      return_tier: '', origin_doc_no: '', return_ref_no: '', return_reason: '',
      supplier: body.supplier || '', po_no: body.po_no || '', contract_no: body.contract_no || ''
    };
  }
  const header = {
    return_tier: normalizeReturnTier(body.return_tier),
    origin_doc_no: String(body.origin_doc_no || '').trim(),
    return_ref_no: String(body.return_ref_no || '').trim(),
    return_reason: String(body.return_reason || '').trim(),
    supplier: String(body.supplier || '').trim(),
  };
  validateReturnTierHeader({ txn_type: '采购退货', ...header }, user);
  let supplier = header.supplier;
  let poNo = body.po_no || '';
  let contractNo = body.contract_no || '';
  if (header.return_tier === 'inbound') {
    const origin = loadPurchaseReturnOrigin(header.origin_doc_no);
    if (!supplier) supplier = origin.supplier || '';
  } else if (header.return_tier === 'po') {
    const po = loadPurchaseReturnScope('po', header.return_ref_no);
    if (!supplier) supplier = po.supplier || '';
    if (!poNo) poNo = header.return_ref_no;
  } else if (header.return_tier === 'contract') {
    const ct = loadPurchaseReturnScope('contract', header.return_ref_no);
    if (!supplier) supplier = ct.supplier || '';
    if (!contractNo) contractNo = header.return_ref_no;
  }
  return { ...header, supplier, po_no: poNo, contract_no: contractNo };
}

// 解析一条采购退货明细：关联档取原入库行单价与来源，无原单档才允许手填单价
function resolveReturnLine(docLike, l, sources, defaults) {
  const srcId = Number(l.origin_line_id) || 0;
  const src = sources && srcId ? sources.get(String(srcId)) : null;
  if (docLike.return_tier === 'none') {
    return {
      origin_line_id: 0,
      price: sign.normalizePrice(l.price),
      po_no: l.po_no !== undefined ? String(l.po_no || '') : (defaults.po_no || ''),
      contract_no: l.contract_no !== undefined ? String(l.contract_no || '') : (defaults.contract_no || ''),
      order_line_id: resolveOrderLineId(
        l.po_no !== undefined ? l.po_no : defaults.po_no,
        l.code,
        l.contract_no !== undefined ? l.contract_no : defaults.contract_no
      ),
    };
  }
  // 关联档：单价/采购单/合同/核销行全部继承原入库行，前端只允许改数量与备注
  const poNo = src ? (src.po_no || '') : (defaults.po_no || '');
  const contractNo = src ? (src.contract_no || '') : (defaults.contract_no || '');
  return {
    origin_line_id: src ? src.id : 0,
    price: src ? src.price : sign.normalizePrice(l.price),
    po_no: poNo,
    contract_no: contractNo,
    order_line_id: src
      ? (src.order_line_id || resolveOrderLineId(poNo, l.code, contractNo))
      : resolveOrderLineId(poNo, l.code, contractNo),
  };
}

const router = express.Router();

// --- 入库单据列表（按 grn_no 分组聚合） ---
router.get('/api/inbound/docs', requirePerm('inbound', 'view'), (req, res) => {
  const { dateFrom, dateTo, keyword, txnType, supplier, handler } = req.query;
  // 关键字含物料名/编码时，先查含该物料的单号再聚合
  let docNoFilter = '';
  const params = [];
  if (keyword) {
    const kw = '%' + keyword + '%';
    const matchedDocs = db.prepare(`SELECT DISTINCT grn_no FROM inbound i
      LEFT JOIN materials m ON i.code = m.code
      WHERE i.grn_no LIKE ? OR i.code LIKE ? OR i.supplier LIKE ? OR i.handler LIKE ? OR i.po_no LIKE ? OR i.contract_no LIKE ?
        OR m.name LIKE ? OR m.spec LIKE ? OR m.brand LIKE ?`)
      .all(kw, kw, kw, kw, kw, kw, kw, kw, kw);
    docNoFilter = matchedDocs.map(d => d.grn_no).join(',');
  }
  let sql = `SELECT
      i.grn_no AS doc_no,
      MIN(i.date) AS date,
      i.txn_type,
      MAX(i.supplier) AS party,
      MAX(i.handler) AS handler,
      MAX(i.po_no) AS po_no,
      MAX(i.contract_no) AS contract_no,
      COUNT(*) AS line_count,
      SUM(i.qty) AS total_qty,
      SUM(i.qty * i.price) AS total_amount,
      MAX(i.remarks) AS remarks
    FROM inbound i
    WHERE 1=1`;
  if (dateFrom) { sql += " AND i.date>=?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND i.date<?"; params.push(dateTo + ' 23:59:59'); }
  if (txnType) { sql += " AND i.txn_type=?"; params.push(txnType); }
  if (supplier) { sql += " AND i.supplier LIKE ?"; params.push('%' + supplier + '%'); }
  if (handler) { sql += " AND i.handler LIKE ?"; params.push('%' + handler + '%'); }
  if (keyword && docNoFilter) {
    sql += ` AND i.grn_no IN (${docNoFilter.split(',').map(() => '?').join(',')})`;
    docNoFilter.split(',').forEach(d => params.push(d));
  } else if (keyword && !docNoFilter) {
    // 关键字未匹配到任何单号 → 返回空
    return res.json([]);
  }
  sql += " GROUP BY i.grn_no ORDER BY MIN(i.date) DESC, MAX(i.id) DESC";
  res.json(db.prepare(sql).all(...params));
});

// --- 入库单据明细（按单号查全部明细行） ---
router.get('/api/inbound/docs/:docNo', requirePerm('inbound', 'view'), (req, res) => {
  const docNo = req.params.docNo;
  const sql = `SELECT i.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM inbound i LEFT JOIN materials m ON i.code = m.code
    WHERE i.grn_no=? ORDER BY i.id ASC`;
  res.json(db.prepare(sql).all(docNo));
});

// --- 删除整单入库（删除该 grn_no 下全部明细行） ---
router.delete('/api/inbound/docs/:docNo', requirePerm('inbound', 'delete'), (req, res) => {
  try {
    const docNo = req.params.docNo;
    const info = db.prepare("DELETE FROM inbound WHERE grn_no=?").run(docNo);
    res.json({ success: true, deleted: info.changes });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 入库记录 ---
router.get('/api/inbound', requirePerm('inbound', 'view'), (req, res) => {
  const { code, startDate, endDate, supplier, handler, poNo, contractNo, keyword, txnType } = req.query;
  let sql = `SELECT i.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM inbound i LEFT JOIN materials m ON i.code = m.code WHERE 1=1`;
  const params = [];
  if (code) { sql += " AND i.code=?"; params.push(code); }
  if (startDate) { sql += " AND i.date>=?"; params.push(startDate); }
  if (endDate) { sql += " AND i.date<?"; params.push(endDate + ' 23:59:59'); }
  if (supplier) { sql += " AND i.supplier LIKE ?"; params.push('%' + supplier + '%'); }
  if (handler) { sql += " AND i.handler LIKE ?"; params.push('%' + handler + '%'); }
  if (poNo) { sql += " AND i.po_no=?"; params.push(poNo); }
  if (contractNo) { sql += " AND i.contract_no=?"; params.push(contractNo); }
  if (txnType) { sql += " AND i.txn_type=?"; params.push(txnType); }
  if (keyword) {
    sql += " AND (i.code LIKE ? OR m.name LIKE ? OR m.spec LIKE ? OR m.brand LIKE ?)";
    params.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
  }
  sql += " ORDER BY i.date DESC, i.id DESC";
  res.json(db.prepare(sql).all(...params));
});

// 批量入库：支持一次提交多行
router.post('/api/inbound', requirePerm('inbound', 'create'), (req, res) => {
  const body = req.body;
  // 兼容：单行（有 code 字段）或多行（items 数组）
  const raw = Array.isArray(body.items) ? body.items : [body];
  if (raw.length === 0) return res.status(400).json({ error: '无数据' });
  // 管理员/主管可强制放行超量退货
  const forceAllow = body.force_allow === true && ['admin', 'manager'].includes(req.user?.role);
  try {
    const stmt = db.prepare(`INSERT INTO inbound (date,grn_no,code,qty,price,supplier,handler,remarks,po_no,contract_no,txn_type,order_line_id)
      VALUES (@date,@grn_no,@code,@qty,@price,@supplier,@handler,@remarks,@po_no,@contract_no,@txn_type,@order_line_id)`);
    // 先规整出「有效行」：date 缺失时回退到顶层 body.date（单条提交的形态）
    // 只按物料筛选，数量缺失交给 sign.normalizeQty 显式报错，避免 0/空行被静默丢弃
    const items = raw
      .filter(r => r && r.code)
      .map(r => ({ ...r, date: r.date || body.date || '' }))
      .filter(r => r.date);
    if (items.length === 0) return res.status(400).json({ error: '没有有效的入库行（缺少物料或日期）' });

    // 统一规范化符号
    const firstItem = items[0];
    if (!firstItem.txn_type) firstItem.txn_type = '采购入库';
    const sharedGrnNo = genGrnNo(firstItem.date, firstItem.txn_type);
    items.forEach(r => {
      if (!r.grn_no) r.grn_no = sharedGrnNo;
      if (!r.txn_type) r.txn_type = '采购入库';
      r.qty = sign.normalizeQty(r.txn_type, r.qty);
      r.price = sign.normalizePrice(r.price);
      if (!r.supplier) r.supplier = '';
      if (!r.handler) r.handler = '';
      if (!r.remarks) r.remarks = '';
      if (!r.po_no) r.po_no = '';
      if (!r.contract_no) r.contract_no = '';
      if (r.price == null || r.price === '') r.price = 0;
      // 到货核销到具体采购明细（找不到记 0）
      r.order_line_id = resolveOrderLineId(r.po_no, r.code, r.contract_no);
    });

    const tx = db.transaction(() => {
      // 采购退货库存校验（事务内，保证原子性）
      if (!forceAllow) {
        validateInboundReturnStock(items);
      }
      const results = [];
      items.forEach(r => {
        const info = stmt.run(r);
        results.push({ id: Number(info.lastInsertRowid), grn_no: r.grn_no });
      });
      return results;
    });

    const results = tx();
    res.json({ success: true, count: results.length, results, forced: forceAllow });
  } catch (e) {
    if (e.stockError) {
      return res.status(400).json({
        error: `库存不足：${e.details.map(d => `${d.code} 需 ${d.requested}，可用 ${d.available}`).join('；')}`,
        code: 'INSUFFICIENT_STOCK',
        details: e.details
      });
    }
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/inbound/:id', requirePerm('inbound', 'edit'), (req, res) => {
  const body = req.body;
  const forceAllow = body.force_allow === true && ['admin', 'manager'].includes(req.user?.role);
  try {
    // 读取原记录：缺失的可选字段回退到原值，避免 SQL 参数缺失导致整个编辑失败
    const old = db.prepare('SELECT * FROM inbound WHERE id=?').get(req.params.id);
    if (!old) return res.status(404).json({ error: '入库记录不存在' });
    const oldType = old.txn_type || '采购入库';
    const txnType = body.txn_type || oldType;
    // 数量/单价缺失时回退原值；若单据类型变更，则按新类型重新推导符号
    const qty = body.qty !== undefined && body.qty !== ''
      ? sign.normalizeQty(txnType, body.qty)
      : (txnType === oldType ? old.qty : sign.normalizeQty(txnType, sign.absQty(old.qty)));
    const price = body.price !== undefined && body.price !== ''
      ? sign.normalizePrice(body.price)
      : sign.storedAbs(old.price);
    const r = {
      date: body.date || old.date,
      grn_no: body.grn_no !== undefined ? body.grn_no : old.grn_no,
      code: body.code || old.code,
      qty,
      price,
      supplier: body.supplier !== undefined ? body.supplier : old.supplier,
      handler: body.handler !== undefined ? body.handler : old.handler,
      remarks: body.remarks !== undefined ? body.remarks : old.remarks,
      po_no: body.po_no !== undefined ? body.po_no : old.po_no,
      contract_no: body.contract_no !== undefined ? body.contract_no : old.contract_no,
      txn_type: txnType
    };

    if (!forceAllow) {
      validateInboundReturnStock([r], req.params.id);
    }

    db.prepare(`UPDATE inbound SET date=@date,grn_no=@grn_no,code=@code,qty=@qty,price=@price,
      supplier=@supplier,handler=@handler,remarks=@remarks,po_no=@po_no,contract_no=@contract_no,txn_type=@txn_type WHERE id=@id`).run({ ...r, id: req.params.id });
    res.json({ success: true, id: Number(req.params.id), forced: forceAllow });
  } catch (e) {
    if (e.stockError) {
      return res.status(400).json({
        error: `库存不足：${e.details.map(d => `${d.code} 需 ${d.requested}，可用 ${d.available}`).join('；')}`,
        code: 'INSUFFICIENT_STOCK',
        details: e.details
      });
    }
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/inbound/:id', requirePerm('inbound', 'delete'), (req, res) => {
  try {
    db.prepare("DELETE FROM inbound WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== 入库单据（草稿/确认/作废 状态流转） ====================
// 设计要点：
//  1. inbound_docs 是单据头，inbound 明细行通过 doc_no 关联
//  2. 草稿态明细行 status='draft'，不计入库存；确认后 status='posted'，纳入库存
//  3. 已过账单据不可直接修改，应通过红字冲销/退库处理
//  4. 权限：inbound 模块的 view/create/edit/delete + confirm 动作

// 生成入库单据号（采购入库 GRN / 采购退货 RET，规则见 services/docno.js，前缀可在参数设置中修改）
function genInboundDocNo(date, txnType) {
  return docno.genDocNo(txnType === '采购退货' ? 'ret' : 'grn', date);
}

// 记录单据操作日志
function logInboundDoc(docNo, action, operator, detail) {
  db.prepare("INSERT INTO inbound_doc_logs (doc_no, action, operator, detail) VALUES (?, ?, ?, ?)")
    .run(docNo, action, operator || '', detail || '');
}

// 获取入库单据列表（支持按状态/关键字/日期筛选）
router.get('/api/inbound-docs', requirePerm('inbound', 'view'), (req, res) => {
  const { status, keyword, dateFrom, dateTo, txnType, excludeType } = req.query;
  let sql = `SELECT d.*,
    (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no) as line_count,
    (SELECT COALESCE(SUM(qty),0) FROM inbound i WHERE i.doc_no = d.doc_no) as total_qty,
    (SELECT COALESCE(SUM(amount),0) FROM inbound i WHERE i.doc_no = d.doc_no) as total_amount
    FROM inbound_docs d WHERE 1=1`;
  const params = [];
  if (status) { sql += " AND d.status=?"; params.push(status); }
  if (txnType) { sql += " AND d.txn_type=?"; params.push(txnType); }
  // 排除指定类型（入库列表“全部”不展示已迁出到退货模块的采购退货）
  if (excludeType) {
    const types = String(excludeType).split(',').map(s => s.trim()).filter(Boolean);
    if (types.length) {
      sql += ' AND d.txn_type NOT IN (' + types.map(() => '?').join(',') + ')';
      params.push(...types);
    }
  }
  if (dateFrom) { sql += " AND d.date>=?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND d.date<?"; params.push(dateTo + ' 23:59:59'); }
  if (keyword) {
    sql += " AND (d.doc_no LIKE ? OR d.supplier LIKE ? OR d.handler LIKE ? OR d.po_no LIKE ? OR d.contract_no LIKE ? OR d.remarks LIKE ?)";
    const kw = '%' + keyword + '%';
    params.push(kw, kw, kw, kw, kw, kw);
  }
  sql += " ORDER BY d.date DESC, d.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

// 获取下一个入库单据号
router.get('/api/inbound-docs/next-no', requirePerm('inbound', 'view'), (req, res) => {
  const date = req.query.date || time.todayLocal();
  const txnType = req.query.txnType || '采购入库';
  res.json({ doc_no: genInboundDocNo(date, txnType) });
});

// 创建入库单据（草稿态）
router.post('/api/inbound-docs', requirePerm('inbound', 'create'), (req, res) => {
  const body = req.body;
  const date = body.date || time.todayLocal();
  const txnType = body.txn_type || '采购入库';
  if (!['采购入库', '采购退货', '零星入库'].includes(txnType)) {
    return res.status(400).json({ error: '入库类型不合法', code: 'INVALID_TXN_TYPE' });
  }
  const docNo = body.doc_no || genInboundDocNo(date, txnType);
  try {
    const exist = db.prepare("SELECT doc_no FROM inbound_docs WHERE doc_no=?").get(docNo);
    if (exist) return res.status(400).json({ error: '单据号已存在: ' + docNo });

    // 采购退货：先校验三档单头并继承供应商/原单号
    const hdr = prepareReturnHeader(body, txnType, req.user);

    // 单头 + 明细同一事务：明细校验失败时回滚单头，避免留下空草稿
    const createdTx = db.transaction(() => {
    db.prepare(`INSERT INTO inbound_docs (doc_no, date, txn_type, supplier, handler, po_no, contract_no, status, remarks, created_by,
        return_tier, origin_doc_no, return_ref_no, return_reason)
      VALUES (@doc_no, @date, @txn_type, @supplier, @handler, @po_no, @contract_no, 'draft', @remarks, @created_by,
        @return_tier, @origin_doc_no, @return_ref_no, @return_reason)`)
      .run({
        doc_no: docNo, date, txn_type: txnType,
        supplier: hdr.supplier, handler: body.handler || '',
        po_no: hdr.po_no, contract_no: hdr.contract_no,
        remarks: body.remarks || '', created_by: req.user?.name || req.user?.username || '',
        return_tier: hdr.return_tier, origin_doc_no: hdr.origin_doc_no,
        return_ref_no: hdr.return_ref_no, return_reason: hdr.return_reason
      });

    // 如果带了明细行，一并创建
    if (Array.isArray(body.lines) && body.lines.length > 0) {
      const stmt = db.prepare(`INSERT INTO inbound (date, grn_no, doc_no, code, qty, price, supplier, handler, remarks, po_no, contract_no, txn_type, status, order_line_id, origin_line_id)
        VALUES (@date, @grn_no, @doc_no, @code, @qty, @price, @supplier, @handler, @remarks, @po_no, @contract_no, @txn_type, 'draft', @order_line_id, @origin_line_id)`);
      const docLike = {
        txn_type: txnType,
        return_tier: hdr.return_tier,
        origin_doc_no: hdr.origin_doc_no,
        return_ref_no: hdr.return_ref_no,
      };
      const validLines = body.lines.filter(l => l.code);
      // 关联档：校验收货行归属与可退量；无原单档返回空 Map
      const sources = validatePurchaseReturnLines(docLike, validLines);
      validLines.forEach(l => {
        const qty = sign.normalizeQty(txnType, l.qty);
        const resolved = resolveReturnLine(docLike, l, sources, { po_no: hdr.po_no, contract_no: hdr.contract_no });
        // 把到货精确核销到具体采购明细行；关联档直接继承原入库行的核销号
        stmt.run({
          date, grn_no: docNo, doc_no: docNo, code: l.code, qty, price: resolved.price,
          supplier: hdr.supplier, handler: body.handler || '',
          remarks: l.remarks || '', po_no: resolved.po_no,
          contract_no: resolved.contract_no, txn_type: txnType,
          order_line_id: resolved.order_line_id, origin_line_id: resolved.origin_line_id
        });
      });
    }
    });
    createdTx();

    logInboundDoc(docNo, 'create', req.user?.name || req.user?.username, '创建入库单据');
    res.json({ success: true, doc_no: docNo });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code || 'INBOUND_DOC_CREATE_FAILED' });
  }
});

// 获取入库单据详情（含明细行 + 操作日志 + 冲销关联信息）
router.get('/api/inbound-docs/:docNo', requirePerm('inbound', 'view'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });

  const lines = db.prepare(`SELECT i.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM inbound i LEFT JOIN materials m ON i.code = m.code
    WHERE i.doc_no=? ORDER BY i.id ASC`).all(docNo);

  const logs = db.prepare("SELECT * FROM inbound_doc_logs WHERE doc_no=? ORDER BY id ASC").all(docNo);

  // 冲销关联信息
  const reversals = [];
  if (doc.reversal_of) {
    // 这是冲销单 → 查关联的原单
    reversals.push({ type: 'original', doc_no: doc.reversal_of });
  } else {
    // 这是原单 → 查关联的冲销单
    const revDocs = db.prepare(`
      SELECT doc_no, status, date,
        (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no) as line_count,
        (SELECT COALESCE(SUM(ABS(qty)),0) FROM inbound i WHERE i.doc_no = d.doc_no) as total_qty
      FROM inbound_docs d WHERE d.reversal_of=? ORDER BY d.created_at DESC
    `).all(docNo);
    revDocs.forEach(r => reversals.push({ type: 'reversal', ...r }));
  }

  // 汇总
  const summary = {
    line_count: lines.length,
    total_qty: lines.reduce((s, l) => s + Number(l.qty || 0), 0),
    total_amount: lines.reduce((s, l) => s + Number(l.amount || l.qty * l.price || 0), 0)
  };

  res.json({ ...doc, lines, logs, summary, reversals });
});

// 保存入库单据明细行（草稿态可操作）
// 整体替换：前端传完整明细行数组，后端先删旧行再插新行
router.put('/api/inbound-docs/:docNo/lines', requirePerm('inbound', 'edit'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '已过账/作废的单据不能修改明细', code: 'DOC_NOT_DRAFT' });

  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  try {
    // 采购退货：先校验档位、权限、原因，再按范围校验可退量（草稿不占额度）
    const effHeader = {
      ...doc,
      supplier: req.body.supplier !== undefined ? req.body.supplier : doc.supplier,
      return_reason: req.body.return_reason !== undefined ? req.body.return_reason : doc.return_reason,
    };
    validateReturnTierHeader(effHeader, req.user);
    const validLines = lines.filter(l => l.code);
    const sources = validatePurchaseReturnLines(effHeader, validLines);

    const tx = db.transaction(() => {
      // 先删旧行
      db.prepare("DELETE FROM inbound WHERE doc_no=?").run(docNo);
      // 再插新行
      const stmt = db.prepare(`INSERT INTO inbound (date, grn_no, doc_no, code, qty, price, supplier, handler, remarks, po_no, contract_no, txn_type, status, order_line_id, origin_line_id)
        VALUES (@date, @grn_no, @doc_no, @code, @qty, @price, @supplier, @handler, @remarks, @po_no, @contract_no, @txn_type, 'draft', @order_line_id, @origin_line_id)`);
      // 明细行核销用「本次提交后的」采购单/合同号（头部字段紧随其后更新）
      const effPoNo = req.body.po_no !== undefined ? req.body.po_no : doc.po_no;
      const effContractNo = req.body.contract_no !== undefined ? req.body.contract_no : doc.contract_no;
      // 明细行供应商用本次提交值，避免先写旧单据头导致列表/明细显示不同步
      const effSupplier = req.body.supplier !== undefined ? req.body.supplier : doc.supplier;
      validLines.forEach(l => {
        const qty = sign.normalizeQty(doc.txn_type, l.qty);
        // 采购退货关联档：单价/来源/核销行继承原入库行；无原单档才允许手填
        const resolved = resolveReturnLine(
          { ...doc, return_tier: normalizeReturnTier(doc.return_tier) },
          l, sources, { po_no: effPoNo, contract_no: effContractNo }
        );
        stmt.run({
          date: l.date || doc.date, grn_no: docNo, doc_no: docNo,
          code: l.code, qty, price: resolved.price,
          supplier: effSupplier, handler: doc.handler,
          remarks: l.remarks || '', po_no: resolved.po_no,
          contract_no: resolved.contract_no, txn_type: doc.txn_type,
          order_line_id: resolved.order_line_id, origin_line_id: resolved.origin_line_id
        });
      });
      // 更新单据头的部分字段（允许跟着明细一起改）
      const updateFields = {};
      if (req.body.supplier !== undefined) updateFields.supplier = req.body.supplier;
      if (req.body.handler !== undefined) updateFields.handler = req.body.handler;
      if (req.body.po_no !== undefined && !isPurchaseReturnDoc(doc)) updateFields.po_no = req.body.po_no;
      if (req.body.contract_no !== undefined && !isPurchaseReturnDoc(doc)) updateFields.contract_no = req.body.contract_no;
      if (req.body.remarks !== undefined) updateFields.remarks = req.body.remarks;
      if (req.body.date !== undefined) updateFields.date = req.body.date;
      // 无原单档允许在草稿里补/改原因（必填在保存与确认时都会校验）
      if (isPurchaseReturnDoc(doc) && normalizeReturnTier(doc.return_tier) === 'none' && req.body.return_reason !== undefined) {
        updateFields.return_reason = req.body.return_reason;
      }
      if (Object.keys(updateFields).length > 0) {
        const sets = Object.keys(updateFields).map(k => `${k}=@${k}`).join(', ');
        db.prepare(`UPDATE inbound_docs SET ${sets} WHERE doc_no=@doc_no`).run({ ...updateFields, doc_no: docNo });
      }
      logInboundDoc(docNo, 'edit', req.user?.name || req.user?.username, `保存明细 ${validLines.length} 行`);
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code || 'INBOUND_LINES_SAVE_FAILED' });
  }
});

// 草稿换档（仅 draft）：重算来源/单价/核销行，失败整体回滚
router.put('/api/inbound-docs/:docNo/return-tier', requirePerm('inbound', 'edit'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });
  if (doc.txn_type !== '采购退货') return res.status(400).json({ error: '仅采购退货单支持切换档位', code: 'RETURN_TIER_NOT_RETURN' });
  if (doc.status !== 'draft') {
    return res.status(409).json({ error: '仅草稿态可切换档位，已过账/已冲销单据不可变更', code: 'RETURN_TIER_NOT_DRAFT' });
  }

  const body = req.body || {};
  const header = {
    txn_type: '采购退货',
    return_tier: body.return_tier,
    origin_doc_no: body.origin_doc_no !== undefined ? body.origin_doc_no : doc.origin_doc_no,
    return_ref_no: body.return_ref_no !== undefined ? body.return_ref_no : doc.return_ref_no,
    return_reason: body.return_reason !== undefined ? body.return_reason : doc.return_reason,
    supplier: body.supplier !== undefined ? body.supplier : doc.supplier,
  };

  try {
    validateReturnTierHeader(header, req.user);
    const tier = normalizeReturnTier(header.return_tier);
    const curTier = normalizeReturnTier(doc.return_tier);
    // 非当前档位的来源字段一律清空：避免旧来源绑定残留
    const originDocNo = tier === 'inbound' ? String(header.origin_doc_no || '').trim() : '';
    const refNo = (tier === 'po' || tier === 'contract') ? String(header.return_ref_no || '').trim() : '';
    let supplier = String(header.supplier || '').trim();
    let poNo = '';
    let contractNo = '';
    let newLines = [];
    const existing = db.prepare("SELECT * FROM inbound WHERE doc_no=? ORDER BY id").all(docNo);

    // 同档位且来源未变：无原单只更新供应商/原因；关联档直接返回，避免误清零
    const sameSource = curTier === tier
      && String(doc.origin_doc_no || '') === originDocNo
      && String(doc.return_ref_no || '') === refNo;

    if (tier === 'inbound') {
      const origin = loadPurchaseReturnOrigin(originDocNo);
      if (!supplier) supplier = origin.supplier || '';
      if (!sameSource) newLines = allocateReturnLines(existing, getPurchaseReturnOriginLines(originDocNo, docNo));
    } else if (tier === 'po' || tier === 'contract') {
      const scopeDoc = loadPurchaseReturnScope(tier, refNo);
      if (!supplier) supplier = scopeDoc.supplier || '';
      if (tier === 'po') poNo = refNo; else contractNo = refNo;
      if (!sameSource) newLines = allocateReturnLines(existing, getPurchaseReturnScopeLines(tier, refNo, docNo));
    } else {
      // 无原单：整体失效旧来源，单价清零待手填，明细行保留
      if (!sameSource) {
        newLines = existing.map(l => ({
          code: l.code,
          qty: sign.normalizeQty(doc.txn_type, Math.abs(Number(l.qty))),
          price: 0,
          po_no: '',
          contract_no: '',
          order_line_id: 0,
          origin_line_id: 0,
          remarks: l.remarks || '',
          date: l.date,
        }));
      }
    }

    const tx = db.transaction(() => {
      db.prepare(`UPDATE inbound_docs SET return_tier=?, origin_doc_no=?, return_ref_no=?, return_reason=?, supplier=?, po_no=?, contract_no=? WHERE doc_no=?`)
        .run(tier, originDocNo, refNo, header.return_reason || '', supplier, poNo, contractNo, docNo);
      if (!sameSource) {
        db.prepare("DELETE FROM inbound WHERE doc_no=?").run(docNo);
        const stmt = db.prepare(`INSERT INTO inbound (date, grn_no, doc_no, code, qty, price, supplier, handler, remarks, po_no, contract_no, txn_type, status, order_line_id, origin_line_id)
          VALUES (@date, @grn_no, @doc_no, @code, @qty, @price, @supplier, @handler, @remarks, @po_no, @contract_no, @txn_type, 'draft', @order_line_id, @origin_line_id)`);
        const rows = sameSource ? existing : newLines;
        rows.forEach(l => {
          stmt.run({
            date: l.date || doc.date, grn_no: docNo, doc_no: docNo, code: l.code, qty: l.qty,
            price: l.price, supplier, handler: doc.handler, remarks: l.remarks || '',
            po_no: l.po_no || '', contract_no: l.contract_no || '',
            txn_type: doc.txn_type, order_line_id: l.order_line_id || 0, origin_line_id: l.origin_line_id || 0,
          });
        });
      }
      logInboundDoc(docNo, 'edit', req.user?.name || req.user?.username, `切换退货档位为 ${tier}，重绑定 ${newLines.length} 行`);
    });
    tx();
    res.json({ success: true, return_tier: tier, line_count: newLines.length, unchanged: sameSource && curTier === tier });
  } catch (e) {
    const payload = { error: e.message, code: e.code || 'RETURN_TIER_SWITCH_FAILED' };
    if (e.details) payload.details = e.details;
    res.status(e.status || 400).json(payload);
  }
});

// 换档重绑定：按物料在新来源范围内按日期/单号顺序分配，不足则整体拒绝
function allocateReturnLines(existing, sources) {
  const pool = sources.map(s => ({ ...s, available: Number(s.available) || 0 }));
  const out = [];
  const shortage = [];
  for (const l of existing) {
    let need = Math.abs(Number(l.qty) || 0);
    if (!need) continue;
    for (const src of pool) {
      if (need <= 0) break;
      if (src.code !== l.code || src.available <= 0) continue;
      const take = Math.min(need, src.available);
      out.push({
        code: l.code, qty: sign.normalizeQty('采购退货', take), price: src.price,
        po_no: src.po_no, contract_no: src.contract_no, order_line_id: src.order_line_id,
        origin_line_id: src.id, remarks: l.remarks || '', date: l.date,
      });
      src.available -= take;
      need -= take;
    }
    if (need > 0) {
      const mat = db.prepare("SELECT name FROM materials WHERE code=?").get(l.code);
      shortage.push({
        code: l.code, material_name: mat?.name || '',
        requested: Math.abs(Number(l.qty) || 0), shortage: need,
        available: Math.abs(Number(l.qty) || 0) - need,
      });
    }
  }
  if (shortage.length) {
    const e = routeFail('RETURN_TIER_QTY_INSUFFICIENT',
      '换档失败：' + shortage.map(x => `物料 ${x.code} 需 ${x.requested}，可退 ${x.available}，差 ${x.shortage}`).join('；'));
    e.details = shortage;
    throw e;
  }
  return out;
}

// 确认入库（过账）—— 草稿 → posted，明细行 status → posted，库存流水生效
router.post('/api/inbound-docs/:docNo/confirm', requirePerm('inbound', 'edit'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '只有草稿单据可以确认', code: 'DOC_NOT_DRAFT' });

  const lines = db.prepare("SELECT * FROM inbound WHERE doc_no=?").all(docNo);
  if (lines.length === 0) return res.status(400).json({ error: '单据没有明细行，无法确认' });

  // 采购入库/采购退货必须有供应商；零星入库允许空供应商，入库冲销跳过该规则
  if (['采购入库', '采购退货'].includes(doc.txn_type) && !String(doc.supplier || '').trim()) {
    return res.status(400).json({ error: '采购入库/采购退货必须填写供应商', code: 'SUPPLIER_REQUIRED' });
  }

  const forceAllow = req.body.force_allow === true && ['admin', 'manager'].includes(req.user?.role);

  try {
    // 采购退货：确认时再次校验档位/权限/原因（force_allow 只放宽库存，不放宽额度）
    validateReturnTierHeader(doc, req.user);
    let sources = new Map();
    if (isPurchaseReturnDoc(doc) && normalizeReturnTier(doc.return_tier) !== 'none') {
      sources = validatePurchaseReturnLines(doc, lines);
      // 关联档单价必须等于原入库行单价，防止绕过前端改写成本
      lines.forEach(l => {
        const src = sources.get(String(l.origin_line_id));
        if (!src) return; // validatePurchaseReturnLines 已抛出
        if (Math.abs(sign.storedAbs(l.price) - src.price) > 1e-6) {
          throw routeFail('RETURN_PRICE_MISMATCH', `物料 ${l.code} 的退货单价必须继承原入库行单价 ${src.price}`);
        }
      });
    }
    const tx = db.transaction(() => {
      // 采购退货库存校验
      if (!forceAllow) {
        validateInboundReturnStock(lines);
      }
      // 明细行过账
      db.prepare("UPDATE inbound SET status='posted' WHERE doc_no=?").run(docNo);
      // 单据头过账
      db.prepare("UPDATE inbound_docs SET status='posted', confirmed_by=?, confirmed_at=datetime('now') WHERE doc_no=?")
        .run(req.user?.name || req.user?.username || '', docNo);
      logInboundDoc(docNo, 'confirm', req.user?.name || req.user?.username, `确认入库，${lines.length} 行已过账`);
    });
    tx();
    res.json({ success: true, line_count: lines.length, forced: forceAllow });
  } catch (e) {
    if (e.stockError) {
      return res.status(400).json({
        error: `库存不足：${e.details.map(d => `${d.code} 需 ${d.requested}，可用 ${d.available}`).join('；')}`,
        code: 'INSUFFICIENT_STOCK',
        details: e.details
      });
    }
    res.status(e.status || 400).json({ error: e.message, code: e.code || 'INBOUND_CONFIRM_FAILED' });
  }
});

// 作废入库单据 —— 草稿 → cancelled
// 草稿态作废：明细行一起删除（因为还没过账，不产生库存影响）
router.post('/api/inbound-docs/:docNo/cancel', requirePerm('inbound', 'delete'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '只有草稿单据可以作废', code: 'DOC_NOT_DRAFT' });

  try {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM inbound WHERE doc_no=?").run(docNo);
      db.prepare("UPDATE inbound_docs SET status='cancelled', cancelled_by=?, cancelled_at=datetime('now') WHERE doc_no=?")
        .run(req.user?.name || req.user?.username || '', docNo);
      logInboundDoc(docNo, 'cancel', req.user?.name || req.user?.username, '作废入库单据');
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 删除入库单据（草稿态可删除，连同明细行一起）
router.delete('/api/inbound-docs/:docNo', requirePerm('inbound', 'delete'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '已过账/作废的单据不能删除', code: 'DOC_NOT_DRAFT' });
  try {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM inbound WHERE doc_no=?").run(docNo);
      db.prepare("DELETE FROM inbound_docs WHERE doc_no=?").run(docNo);
      // 删除后该单据号可能被后续新建单据复用，必须一并清理操作日志，
      // 否则复用同一单号的新单据会显示已被删除单据的历史日志。
      db.prepare("DELETE FROM inbound_doc_logs WHERE doc_no=?").run(docNo);
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== 入库冲销（2026-11-03 新增） ====================
// 设计要点：
//  1. 冲销单是一张独立的 inbound_docs，txn_type='入库冲销'，reversal_of 指向原单号
//  2. 冲销单的明细行 qty 为负数，reversal_of 指向原明细行 ID
//  3. 冲销单状态流转与普通入库单一致：draft → posted（确认冲销后才扣库存）
//  4. 原单状态自动更新：posted → partially_reversed → reversed（所有明细全部冲销后）
//  5. 校验规则：
//     a. 累计冲销数量 ≤ 原入库数量
//     b. 确认冲销时校验当前可用库存（冲销量不能让库存变负）
//  6. 冲销单中数量以正数填写，库存流水按负方向处理

// 生成冲销单号（RV，入库/出库共用一套序号，规则见 services/docno.js）
function genReversalDocNo(date) {
  return docno.genDocNo('rv', date);
}

// 获取原单某明细行的累计已冲销数量
function getReversedQty(lineId) {
  // reversal_of 列是 TEXT 类型，必须用字符串比较
  const r = db.prepare(`
    SELECT COALESCE(SUM(ABS(i.qty)),0) as v FROM inbound i
    JOIN inbound_docs d ON i.doc_no = d.doc_no
    WHERE i.reversal_of = ? AND d.status = 'posted'
  `).get(String(lineId));
  return r ? r.v : 0;
}

// 根据冲销单的过账结果，自动更新原单状态
function updateOriginalDocStatus(originalDocNo) {
  // 查原单所有已过账明细行
  const origLines = db.prepare("SELECT id, qty FROM inbound WHERE doc_no=? AND status='posted'").all(originalDocNo);
  if (origLines.length === 0) return;

  // 检查每行是否已全部冲销（累计冲销量 >= 原入库量）
  const allReversed = origLines.every(l => {
    const revQty = getReversedQty(l.id);
    return revQty >= sign.absQty(l.qty);
  });

  if (allReversed) {
    db.prepare("UPDATE inbound_docs SET status='reversed' WHERE doc_no=?").run(originalDocNo);
    logInboundDoc(originalDocNo, 'reverse', 'system', '所有明细已全部冲销，单据状态更新为已全部冲销');
  } else {
    db.prepare("UPDATE inbound_docs SET status='partially_reversed' WHERE doc_no=?").run(originalDocNo);
    logInboundDoc(originalDocNo, 'reverse', 'system', '部分明细已冲销，单据状态更新为部分冲销');
  }
}

// 获取原单明细的可冲销信息（每行的原入库量、已冲销量、剩余可冲销量）
router.get('/api/inbound-docs/:docNo/reversal-info', requirePerm('inbound', 'view'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });
  if (doc.status !== 'posted' && doc.status !== 'partially_reversed')
    return res.status(400).json({ error: '只有已过账或部分冲销的单据可以冲销', code: 'DOC_NOT_REVERSIBLE' });

  // 原单明细行（正数入库行和采购退货负数行都可冲销，冲销方向由原行符号决定）
  const lines = db.prepare(`
    SELECT i.id, i.code, i.qty, i.price, i.remarks,
           m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM inbound i LEFT JOIN materials m ON i.code = m.code
    WHERE i.doc_no=? AND i.status='posted'
    ORDER BY i.id ASC
  `).all(docNo);

  const lineInfos = lines.map(l => {
    const origQty = sign.absQty(l.qty);
    const reversedQty = getReversedQty(l.id);
    const remaining = origQty - reversedQty;
    return {
      id: l.id,
      code: l.code,
      qty: origQty,
      reversed_qty: reversedQty,
      remaining: remaining,
      material_name: l.material_name,
      material_spec: l.material_spec,
      material_unit: l.material_unit,
      material_brand: l.material_brand,
      remarks: l.remarks
    };
  });

  // 查已有冲销单
  const reversals = db.prepare(`
    SELECT d.doc_no, d.date, d.status, d.remarks, d.created_by, d.created_at, d.confirmed_by, d.confirmed_at,
      (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no) as line_count,
      (SELECT COALESCE(SUM(ABS(qty)),0) FROM inbound i WHERE i.doc_no = d.doc_no) as total_qty
    FROM inbound_docs d WHERE d.reversal_of=? ORDER BY d.created_at DESC
  `).all(docNo);

  res.json({
    doc_no: docNo,
    status: doc.status,
    lines: lineInfos.filter(l => l.remaining > 0),  // 只返回仍有可冲销余额的行
    all_lines: lineInfos,  // 返回全部行（含已全部冲销的）
    reversals: reversals
  });
});

// 创建冲销单（草稿态）
// body: { date, reason, lines: [{ line_id, qty }] }  — qty 为正数（本次冲销量）
router.post('/api/inbound-docs/:docNo/reversal', requirePerm('inbound', 'edit'), (req, res) => {
  const originalDocNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(originalDocNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });
  if (doc.status !== 'posted' && doc.status !== 'partially_reversed')
    return res.status(400).json({ error: '只有已过账或部分冲销的单据可以冲销', code: 'DOC_NOT_REVERSIBLE' });

  const body = req.body;
  const reqLines = Array.isArray(body.lines) ? body.lines : [];
  if (reqLines.length === 0)
    return res.status(400).json({ error: '请至少选择一行进行冲销', code: 'NO_LINES' });

  const date = body.date || time.todayLocal();
  const reason = body.reason || '';
  const revDocNo = genReversalDocNo(date);
  const operator = req.user?.name || req.user?.username || '';

  try {
    const tx = db.transaction(() => {
      // 创建冲销单头
      db.prepare(`INSERT INTO inbound_docs
        (doc_no, date, txn_type, supplier, handler, po_no, contract_no, status, remarks, created_by, reversal_of)
        VALUES (?, ?, '入库冲销', ?, ?, ?, ?, 'draft', ?, ?, ?)`)
        .run(revDocNo, date,
          doc.supplier || '', doc.handler || '', doc.po_no || '', doc.contract_no || '',
          reason || ('冲销原单 ' + originalDocNo), operator,
          originalDocNo);

      // 创建冲销明细行
      const stmt = db.prepare(`INSERT INTO inbound
        (date, grn_no, doc_no, code, qty, price, supplier, handler, remarks, po_no, contract_no, txn_type, status, reversal_of, order_line_id)
        VALUES (@date, @grn_no, @doc_no, @code, @qty, @price, @supplier, @handler, @remarks, @po_no, @contract_no, '入库冲销', 'draft', @reversal_of, @order_line_id)`);

      const lineDescs = [];
      reqLines.forEach(rl => {
        const lineId = parseInt(rl.line_id, 10);
        if (!lineId) throw new Error('冲销明细缺少原明细行 ID');

        const origLine = db.prepare("SELECT * FROM inbound WHERE id=?").get(lineId);
        if (!origLine || origLine.doc_no !== originalDocNo) throw new Error(`明细行 ${lineId} 不属于原单 ${originalDocNo}`);

        // 符号由原行方向决定：正数原行 → 冲销存负；负数原行（采购退货）→ 冲销存正
        const storedQty = sign.normalizeQty('入库冲销', rl.qty, { originalQty: origLine.qty });
        const revQty = sign.absQty(storedQty);

        // 累计冲销校验
        const alreadyReversed = getReversedQty(lineId);
        const origQty = sign.absQty(origLine.qty);
        if (alreadyReversed + revQty > origQty + 0.0001) {
          throw new Error(`物料 ${origLine.code}：累计冲销量 ${alreadyReversed + revQty} 超过原入库量 ${origQty}（本次最多可冲 ${origQty - alreadyReversed}）`);
        }

        // 单价永远取正，金额符号由数量符号决定
        const price = sign.storedAbs(origLine.price);
        stmt.run({
          date, grn_no: revDocNo, doc_no: revDocNo,
          code: origLine.code, qty: storedQty, price,
          supplier: doc.supplier || '', handler: doc.handler || '',
          remarks: rl.remarks || ('冲销物料 ' + origLine.code),
          po_no: doc.po_no || '', contract_no: doc.contract_no || '',
          reversal_of: String(lineId),
          // 冲销行继承原行的采购明细核销关联，保证净到货量口径一致
          order_line_id: origLine.order_line_id || 0
        });

        lineDescs.push(`${origLine.code} × ${revQty}`);
      });

      if (lineDescs.length === 0) throw new Error('没有有效的冲销明细行');

      logInboundDoc(revDocNo, 'create', operator, `创建冲销单，关联原单 ${originalDocNo}；明细：${lineDescs.join('，')}`);
      logInboundDoc(originalDocNo, 'reverse', operator, `创建冲销单 ${revDocNo}（草稿态，尚未扣减库存）`);
    });
    tx();
    res.json({ success: true, doc_no: revDocNo });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 确认冲销（冲销单草稿 → posted）
// 冲销单确认后：冲销行 status → posted，自动扣减库存（qty 为负数）
// 校验：冲销量不能超过当前可用库存（如果物料已出库，不允许全量冲销）
router.post('/api/inbound-docs/:docNo/reversal-confirm', requirePerm('inbound', 'edit'), (req, res) => {
  const revDocNo = req.params.docNo;
  const revDoc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(revDocNo);
  if (!revDoc) return res.status(404).json({ error: '冲销单不存在' });
  if (revDoc.txn_type !== '入库冲销') return res.status(400).json({ error: '该单据不是冲销单', code: 'NOT_REVERSAL' });
  if (revDoc.status !== 'draft') return res.status(400).json({ error: '只有草稿态的冲销单可以确认', code: 'DOC_NOT_DRAFT' });

  const originalDocNo = revDoc.reversal_of;
  if (!originalDocNo) return res.status(400).json({ error: '冲销单缺少原单关联' });

  const lines = db.prepare("SELECT * FROM inbound WHERE doc_no=? AND reversal_of != ''").all(revDocNo);
  if (lines.length === 0) return res.status(400).json({ error: '冲销单没有明细行' });

  const forceAllow = req.body.force_allow === true && ['admin', 'manager'].includes(req.user?.role);
  const operator = req.user?.name || req.user?.username || '';

  // 库存校验：只有「负数量的冲销行」才会让库存减少，需要校验可用库存；
  // 对采购退货（负数原行）的冲销会存正数，属于回补库存，无需校验。
  const demandMap = new Map();
  lines.forEach(l => {
    const qty = Number(l.qty);
    if (qty >= 0) return;
    const need = sign.absQty(qty);
    demandMap.set(l.code, (demandMap.get(l.code) || 0) + need);
  });

  const stockErrors = [];
  demandMap.forEach((needQty, code) => {
    const available = getAvailableStock(code);
    if (needQty > available + 0.0001) {
      stockErrors.push({ code, requested: needQty, available });
    }
  });

  if (stockErrors.length > 0 && !forceAllow) {
    return res.status(400).json({
      error: `库存不足，无法冲销：${stockErrors.map(d => `${d.code} 需冲 ${d.requested}，可用 ${d.available}`).join('；')}`,
      code: 'INSUFFICIENT_STOCK',
      details: stockErrors
    });
  }

  try {
    const tx = db.transaction(() => {
      // 冲销行过账
      db.prepare("UPDATE inbound SET status='posted' WHERE doc_no=?").run(revDocNo);
      // 冲销单头过账
      db.prepare("UPDATE inbound_docs SET status='posted', confirmed_by=?, confirmed_at=datetime('now') WHERE doc_no=?")
        .run(operator, revDocNo);

      logInboundDoc(revDocNo, 'confirm', operator, `确认冲销，${lines.length} 行已过账，库存已反向扣减`);
      logInboundDoc(originalDocNo, 'reverse', operator, `冲销单 ${revDocNo} 已确认，库存已扣减`);

      // 自动更新原单状态
      updateOriginalDocStatus(originalDocNo);
    });
    tx();
    res.json({ success: true, line_count: lines.length, forced: forceAllow });
  } catch (e) {
    if (e.stockError) {
      return res.status(400).json({
        error: `库存不足：${e.details.map(d => `${d.code} 需 ${d.requested}，可用 ${d.available}`).join('；')}`,
        code: 'INSUFFICIENT_STOCK',
        details: e.details
      });
    }
    res.status(400).json({ error: e.message });
  }
});


module.exports = router;
