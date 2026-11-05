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
} = require('../services/stock');
const docno = require('../services/docno');
const time = require('../services/time');

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
    const items = raw
      .filter(r => r && r.code && r.qty)
      .map(r => ({ ...r, date: r.date || body.date || '' }))
      .filter(r => r.date);
    if (items.length === 0) return res.status(400).json({ error: '没有有效的入库行（缺少物料、数量或日期）' });

    // 统一规范化符号
    const firstItem = items[0];
    if (!firstItem.txn_type) firstItem.txn_type = '采购入库';
    const sharedGrnNo = genGrnNo(firstItem.date, firstItem.txn_type);
    items.forEach(r => {
      if (!r.grn_no) r.grn_no = sharedGrnNo;
      if (!r.txn_type) r.txn_type = '采购入库';
      if (r.txn_type === '采购退货') {
        r.qty = -Math.abs(Number(r.qty));
        r.price = -Math.abs(Number(r.price || 0));
      } else {
        r.qty = Math.abs(Number(r.qty));
        r.price = Math.abs(Number(r.price || 0));
      }
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
    const r = {
      date: body.date || old.date,
      grn_no: body.grn_no !== undefined ? body.grn_no : old.grn_no,
      code: body.code || old.code,
      qty: body.qty !== undefined && body.qty !== '' ? Number(body.qty) : old.qty,
      price: body.price !== undefined && body.price !== '' ? Number(body.price) : old.price,
      supplier: body.supplier !== undefined ? body.supplier : old.supplier,
      handler: body.handler !== undefined ? body.handler : old.handler,
      remarks: body.remarks !== undefined ? body.remarks : old.remarks,
      po_no: body.po_no !== undefined ? body.po_no : old.po_no,
      contract_no: body.contract_no !== undefined ? body.contract_no : old.contract_no,
      txn_type: body.txn_type || old.txn_type || '采购入库'
    };
    // 统一符号
    if (r.txn_type === '采购退货') {
      r.qty = -Math.abs(Number(r.qty));
      r.price = -Math.abs(Number(r.price || 0));
    } else {
      r.qty = Math.abs(Number(r.qty));
      r.price = Math.abs(Number(r.price || 0));
    }

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
  const { status, keyword, dateFrom, dateTo, txnType } = req.query;
  let sql = `SELECT d.*,
    (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no) as line_count,
    (SELECT COALESCE(SUM(qty),0) FROM inbound i WHERE i.doc_no = d.doc_no) as total_qty,
    (SELECT COALESCE(SUM(amount),0) FROM inbound i WHERE i.doc_no = d.doc_no) as total_amount
    FROM inbound_docs d WHERE 1=1`;
  const params = [];
  if (status) { sql += " AND d.status=?"; params.push(status); }
  if (txnType) { sql += " AND d.txn_type=?"; params.push(txnType); }
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

    db.prepare(`INSERT INTO inbound_docs (doc_no, date, txn_type, supplier, handler, po_no, contract_no, status, remarks, created_by)
      VALUES (@doc_no, @date, @txn_type, @supplier, @handler, @po_no, @contract_no, 'draft', @remarks, @created_by)`)
      .run({
        doc_no: docNo, date, txn_type: txnType,
        supplier: body.supplier || '', handler: body.handler || '',
        po_no: body.po_no || '', contract_no: body.contract_no || '',
        remarks: body.remarks || '', created_by: req.user?.name || req.user?.username || ''
      });

    // 如果带了明细行，一并创建
    if (Array.isArray(body.lines) && body.lines.length > 0) {
      const stmt = db.prepare(`INSERT INTO inbound (date, grn_no, doc_no, code, qty, price, supplier, handler, remarks, po_no, contract_no, txn_type, status, order_line_id)
        VALUES (@date, @grn_no, @doc_no, @code, @qty, @price, @supplier, @handler, @remarks, @po_no, @contract_no, @txn_type, 'draft', @order_line_id)`);
      const hdrPoNo = body.po_no || '';
      const hdrContractNo = body.contract_no || '';
      body.lines.forEach(l => {
        if (!l.code || !l.qty) return;
        let qty = Number(l.qty), price = Number(l.price || 0);
        if (txnType === '采购退货') { qty = -Math.abs(qty); price = -Math.abs(price); }
        else { qty = Math.abs(qty); price = Math.abs(price); }
        // 明细行可覆盖单头：按采购单载入时各行合同可能不同，按合同载入时各行采购单可能不同
        const poNo = l.po_no !== undefined ? String(l.po_no || '') : hdrPoNo;
        const contractNo = l.contract_no !== undefined ? String(l.contract_no || '') : hdrContractNo;
        // 把到货精确核销到具体采购明细行（采购单+物料+合同号解析；找不到记 0，回退三元组匹配）
        stmt.run({
          date, grn_no: docNo, doc_no: docNo, code: l.code, qty, price,
          supplier: body.supplier || '', handler: body.handler || '',
          remarks: l.remarks || '', po_no: poNo,
          contract_no: contractNo, txn_type: txnType,
          order_line_id: resolveOrderLineId(poNo, l.code, contractNo)
        });
      });
    }

    logInboundDoc(docNo, 'create', req.user?.name || req.user?.username, '创建入库单据');
    res.json({ success: true, doc_no: docNo });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
    const tx = db.transaction(() => {
      // 先删旧行
      db.prepare("DELETE FROM inbound WHERE doc_no=?").run(docNo);
      // 再插新行
      const stmt = db.prepare(`INSERT INTO inbound (date, grn_no, doc_no, code, qty, price, supplier, handler, remarks, po_no, contract_no, txn_type, status, order_line_id)
        VALUES (@date, @grn_no, @doc_no, @code, @qty, @price, @supplier, @handler, @remarks, @po_no, @contract_no, @txn_type, 'draft', @order_line_id)`);
      // 明细行核销用「本次提交后的」采购单/合同号（头部字段紧随其后更新）
      const effPoNo = req.body.po_no !== undefined ? req.body.po_no : doc.po_no;
      const effContractNo = req.body.contract_no !== undefined ? req.body.contract_no : doc.contract_no;
      // 明细行供应商用本次提交值，避免先写旧单据头导致列表/明细显示不同步
      const effSupplier = req.body.supplier !== undefined ? req.body.supplier : doc.supplier;
      lines.forEach(l => {
        if (!l.code || !l.qty) return;
        let qty = Number(l.qty), price = Number(l.price || 0);
        if (doc.txn_type === '采购退货') { qty = -Math.abs(qty); price = -Math.abs(price); }
        else { qty = Math.abs(qty); price = Math.abs(price); }
        // 明细行可覆盖单头：按采购单载入时各行合同可能不同，按合同载入时各行采购单可能不同
        const poNo = l.po_no !== undefined ? String(l.po_no || '') : effPoNo;
        const contractNo = l.contract_no !== undefined ? String(l.contract_no || '') : effContractNo;
        stmt.run({
          date: l.date || doc.date, grn_no: docNo, doc_no: docNo,
          code: l.code, qty, price,
          supplier: effSupplier, handler: doc.handler,
          remarks: l.remarks || '', po_no: poNo,
          contract_no: contractNo, txn_type: doc.txn_type,
          order_line_id: resolveOrderLineId(poNo, l.code, contractNo)
        });
      });
      // 更新单据头的部分字段（允许跟着明细一起改）
      const updateFields = {};
      if (req.body.supplier !== undefined) updateFields.supplier = req.body.supplier;
      if (req.body.handler !== undefined) updateFields.handler = req.body.handler;
      if (req.body.po_no !== undefined) updateFields.po_no = req.body.po_no;
      if (req.body.contract_no !== undefined) updateFields.contract_no = req.body.contract_no;
      if (req.body.remarks !== undefined) updateFields.remarks = req.body.remarks;
      if (req.body.date !== undefined) updateFields.date = req.body.date;
      if (Object.keys(updateFields).length > 0) {
        const sets = Object.keys(updateFields).map(k => `${k}=@${k}`).join(', ');
        db.prepare(`UPDATE inbound_docs SET ${sets} WHERE doc_no=@doc_no`).run({ ...updateFields, doc_no: docNo });
      }
      logInboundDoc(docNo, 'edit', req.user?.name || req.user?.username, `保存明细 ${lines.length} 行`);
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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
    res.status(400).json({ error: e.message });
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
    return revQty >= Math.abs(Number(l.qty));
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

  // 原单明细行（只查已过账的正数行，负数行是退货行不可冲销）
  const lines = db.prepare(`
    SELECT i.id, i.code, i.qty, i.price, i.remarks,
           m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM inbound i LEFT JOIN materials m ON i.code = m.code
    WHERE i.doc_no=? AND i.status='posted' AND i.qty > 0
    ORDER BY i.id ASC
  `).all(docNo);

  const lineInfos = lines.map(l => {
    const origQty = Math.abs(Number(l.qty));
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
        const revQty = Math.abs(Number(rl.qty));
        if (!lineId || !revQty || revQty <= 0) return;

        const origLine = db.prepare("SELECT * FROM inbound WHERE id=?").get(lineId);
        if (!origLine || origLine.doc_no !== originalDocNo) throw new Error(`明细行 ${lineId} 不属于原单 ${originalDocNo}`);
        if (origLine.qty <= 0) throw new Error(`明细行 ${lineId} 不是正数入库行，不可冲销`);

        // 累计冲销校验
        const alreadyReversed = getReversedQty(lineId);
        const origQty = Math.abs(Number(origLine.qty));
        if (alreadyReversed + revQty > origQty + 0.0001) {
          throw new Error(`物料 ${origLine.code}：累计冲销量 ${alreadyReversed + revQty} 超过原入库量 ${origQty}（本次最多可冲 ${origQty - alreadyReversed}）`);
        }

        // 冲销行 qty 为负数
        const negQty = -revQty;
        const negPrice = -Math.abs(Number(origLine.price || 0));
        stmt.run({
          date, grn_no: revDocNo, doc_no: revDocNo,
          code: origLine.code, qty: negQty, price: negPrice,
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

  // 库存校验：冲销量（绝对值）不能超过当前可用库存
  // 按物料汇总冲销量
  const demandMap = new Map();
  lines.forEach(l => {
    const absQty = Math.abs(Number(l.qty));
    demandMap.set(l.code, (demandMap.get(l.code) || 0) + absQty);
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
