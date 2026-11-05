/**
 * 采购管理 —— 采购单 / 合同 / 采购明细 / 到货履历
 *
 * 信息架构（对齐 ERP 采购管理范式）：
 *   1. 采购单：一张采购单一行（表头），明细在详情页维护
 *   2. 合同：独立档案表。采购单 ↔ 合同是多对多，
 *      真实归属以明细行 order_lines.contract_no 为准，
 *      采购单头的 contract_no 仅作新建明细时带出的「默认合同」
 *   3. 采购明细：行级综合查询（可按采购单 / 合同 / 综合三个入口），可下钻到到货履历
 *
 * 到货口径（services/stock.js）：
 *   优先按 inbound.order_line_id 精确核销；
 *   否则回退「采购单 + 物料 + 有效合同号」匹配（双方都带合同号时必须一致，避免同单同料跨合同串账）
 *
 * 操作日志：直接复用系统审计表 audit_logs（module='purchase', target=单号），
 *          与「系统日志」页面同源，避免再造一张重复的日志表。
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const {
  getOrderLinesForInbound,
  getOrderLinesByContract,
  RECEIVED_BY_LINE,
  EFF_CONTRACT,
} = require('../services/stock');
const docno = require('../services/docno');

const router = express.Router();

// 采购明细行的统一投影：带出采购单头信息、有效合同号、已到货数量、物料档案
const LINE_SEL = `
  SELECT ol.*, po.date AS po_date, po.supplier AS po_supplier, po.project, po.expected_date, po.manual_status,
         ${EFF_CONTRACT} AS contract_no_eff,
         ${RECEIVED_BY_LINE} AS received_qty,
         m.name AS material_name, m.spec AS material_spec, m.unit AS material_unit, m.brand AS material_brand
  FROM order_lines ol
  LEFT JOIN purchase_orders po ON ol.po_no = po.po_no
  LEFT JOIN materials m ON ol.code = m.code`;

const r2 = v => Math.round(Number(v || 0) * 100) / 100;

// 关键字分词：按空格拆分，返回若干个非空片段（多关键字取 AND，片段内多字段取 OR）
const kwTokens = keyword => String(keyword || '').trim().split(/\s+/).filter(Boolean);

// 计算单行的到货状态 / 逾期天数 / 未到数量
function enrichLine(l) {
  const ordered = Number(l.order_qty || 0);
  const received = Number(l.received_qty || 0);
  const closed = l.manual_status === '已关闭' || l.manual_status === '已取消';
  let status;
  if (closed) status = l.manual_status;
  else if (received <= 0) status = '未到货';
  else if (received + 0.0001 < ordered) status = '部分到货';
  else status = '已到货';

  let overdue = 0;
  if (l.expected_date && (status === '未到货' || status === '部分到货')) {
    const diff = Math.floor((Date.now() - new Date(l.expected_date).getTime()) / 86400000);
    overdue = diff > 0 ? diff : 0;
  }
  return {
    ...l,
    contract_no_eff: l.contract_no_eff || '',
    received_qty: received,
    unreceived_qty: r2(ordered - received),
    line_status: status,
    overdue_days: overdue,
  };
}

// 按采购单头汇总到货状态
function poDeliveryStatus(manualStatus, lines, receivedQty, orderQty) {
  if (manualStatus === '已关闭' || manualStatus === '已取消') return manualStatus;
  if (lines.length === 0) return '无明细';
  if (receivedQty <= 0) return '未到货';
  if (receivedQty + 0.0001 < orderQty) return '部分到货';
  return '已到货';
}

function overdueDaysOf(expectedDate, deliveryStatus) {
  if (!expectedDate || (deliveryStatus !== '未到货' && deliveryStatus !== '部分到货')) return 0;
  const diff = Math.floor((Date.now() - new Date(expectedDate).getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

// 批量取多张采购单的明细
function linesOfOrders(poNos) {
  const map = new Map();
  if (!poNos.length) return map;
  const ph = poNos.map(() => '?').join(',');
  db.prepare(`${LINE_SEL} WHERE ol.po_no IN (${ph}) ORDER BY ol.id`).all(...poNos)
    .forEach(r => {
      const e = enrichLine(r);
      if (!map.has(e.po_no)) map.set(e.po_no, []);
      map.get(e.po_no).push(e);
    });
  return map;
}

// 合同号被引用时自动建档，保证「按合同」视图不漏单
function ensureContract(contractNo, supplier) {
  const c = String(contractNo || '').trim();
  if (!c) return;
  db.prepare("INSERT OR IGNORE INTO contracts (contract_no, supplier) VALUES (?, ?)").run(c, supplier || '');
}

// 单据操作日志：直接读系统审计表（与「系统日志」页面同源）
function fetchLogs(module, target, limit) {
  return db.prepare(`SELECT id, username, name, action, target, method, detail, created_at
    FROM audit_logs WHERE module = ? AND target = ? ORDER BY id DESC LIMIT ?`)
    .all(module, target, limit || 200);
}

// 单条采购明细的已到货数量（用于编辑时的数量下限 / 删除保护）
function receivedQtyOfLine(lineId) {
  const row = db.prepare(`SELECT ${RECEIVED_BY_LINE} AS r FROM order_lines ol
    LEFT JOIN purchase_orders po ON ol.po_no = po.po_no WHERE ol.id = ?`).get(lineId);
  return row ? Number(row.r || 0) : 0;
}

// ==================== 采购单 ====================

// 生成下一个采购单号（规则见 services/docno.js，前缀可在参数设置中修改）
router.get('/api/purchase/orders/next-no', requirePerm('purchase', 'view'), (req, res) => {
  try {
    res.json({ po_no: docno.genDocNo('po', req.query.date || '') });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 采购单列表（多条件 + 到货状态）
router.get('/api/purchase/orders', requirePerm('purchase', 'view'), (req, res) => {
  const { keyword, supplier, contractNo, status, deliveryStatus, dateFrom, dateTo } = req.query;
  let sql = "SELECT po.* FROM purchase_orders po WHERE 1=1";
  const params = [];
  if (supplier) { sql += " AND po.supplier LIKE ?"; params.push('%' + supplier + '%'); }
  if (status) { sql += " AND po.manual_status = ?"; params.push(status); }
  if (dateFrom) { sql += " AND po.date >= ?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND po.date <= ?"; params.push(dateTo + ' 23:59:59'); }
  if (keyword) {
    kwTokens(keyword).forEach(tk => {
      const kw = '%' + tk + '%';
      sql += ` AND (po.po_no LIKE ? OR po.contract_no LIKE ? OR po.supplier LIKE ? OR po.project LIKE ? OR po.remarks LIKE ?
        OR EXISTS (SELECT 1 FROM order_lines ol2 WHERE ol2.po_no = po.po_no AND (ol2.code LIKE ? OR ol2.contract_no LIKE ?))
        OR EXISTS (SELECT 1 FROM order_lines ol3 LEFT JOIN materials m3 ON ol3.code = m3.code
                   WHERE ol3.po_no = po.po_no AND (m3.name LIKE ? OR m3.spec LIKE ? OR m3.brand LIKE ?)))`;
      params.push(kw, kw, kw, kw, kw, kw, kw, kw, kw, kw);
    });
  }
  sql += " ORDER BY po.date DESC, po.po_no DESC";
  const orders = db.prepare(sql).all(...params);
  const linesByPo = linesOfOrders(orders.map(o => o.po_no));

  let result = orders.map(po => {
    const lines = linesByPo.get(po.po_no) || [];
    const orderQty = lines.reduce((s, l) => s + Number(l.order_qty || 0), 0);
    const orderAmount = lines.reduce((s, l) => s + Number(l.order_amount || 0), 0);
    const receivedQty = lines.reduce((s, l) => s + Number(l.received_qty || 0), 0);
    const receivedAmount = lines.reduce((s, l) => s + Number(l.received_qty || 0) * Number(l.order_price || 0), 0);
    const delivery_status = poDeliveryStatus(po.manual_status, lines, receivedQty, orderQty);
    const contractNos = [...new Set(lines.map(l => l.contract_no_eff).filter(Boolean))];
    if (contractNos.length === 0 && po.contract_no) contractNos.push(po.contract_no);
    return {
      ...po,
      contract_nos: contractNos,
      contract_display: contractNos.join('、'),
      line_count: lines.length,
      order_qty: r2(orderQty),
      order_amount: r2(orderAmount),
      received_qty: r2(receivedQty),
      received_amount: r2(receivedAmount),
      delivery_status,
      overdue_days: overdueDaysOf(po.expected_date, delivery_status),
    };
  });
  if (contractNo) result = result.filter(o => o.contract_nos.includes(contractNo));
  if (deliveryStatus) result = result.filter(o => o.delivery_status === deliveryStatus);
  res.json(result);
});

// 采购单详情（表头 + 明细含到货 + 入库单 + 汇总 + 操作日志）
router.get('/api/purchase/orders/:poNo', requirePerm('purchase', 'view'), (req, res) => {
  const poNo = req.params.poNo;
  const po = db.prepare("SELECT * FROM purchase_orders WHERE po_no = ?").get(poNo);
  if (!po) return res.status(404).json({ error: '采购单不存在' });

  const lines = db.prepare(`${LINE_SEL} WHERE ol.po_no = ? ORDER BY ol.id`).all(poNo).map(enrichLine);

  const orderQty = lines.reduce((s, l) => s + Number(l.order_qty || 0), 0);
  const orderAmount = lines.reduce((s, l) => s + Number(l.order_amount || 0), 0);
  const receivedQty = lines.reduce((s, l) => s + Number(l.received_qty || 0), 0);
  const receivedAmount = lines.reduce((s, l) => s + Number(l.received_qty || 0) * Number(l.order_price || 0), 0);
  const delivery_status = poDeliveryStatus(po.manual_status, lines, receivedQty, orderQty);

  // 该采购单关联的入库单据（含明细行直接核销到本单明细的情况）
  const inboundDocs = db.prepare(`
    SELECT d.doc_no, d.date, d.txn_type, d.supplier, d.handler, d.status, d.contract_no, d.created_by, d.confirmed_at,
      (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no) AS line_count,
      (SELECT COALESCE(SUM(i.qty),0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_qty,
      (SELECT COALESCE(SUM(i.amount),0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_amount
    FROM inbound_docs d
    WHERE d.doc_no <> '' AND d.doc_no IN (
      SELECT DISTINCT i.doc_no FROM inbound i
      WHERE i.doc_no <> '' AND i.status = 'posted'
        AND (i.po_no = ? OR i.order_line_id IN (SELECT id FROM order_lines WHERE po_no = ?))
    )
    ORDER BY d.date DESC, d.created_at DESC`).all(poNo, poNo);

  res.json({
    ...po,
    lines,
    inbound_docs: inboundDocs,
    logs: fetchLogs('purchase', poNo, 200),
    summary: {
      line_count: lines.length,
      order_qty: r2(orderQty),
      order_amount: r2(orderAmount),
      received_qty: r2(receivedQty),
      unreceived_qty: r2(orderQty - receivedQty),
      received_amount: r2(receivedAmount),
      unreceived_amount: r2(orderAmount - receivedAmount),
      delivery_status,
      overdue_days: overdueDaysOf(po.expected_date, delivery_status),
    },
  });
});

// 采购单的「行级入库明细」：模板「入库」页签按物料行展示到货流水
router.get('/api/purchase/orders/:poNo/inbound-lines', requirePerm('purchase', 'view'), (req, res) => {
  const poNo = req.params.poNo;
  const rows = db.prepare(`
    SELECT i.id, i.doc_no, i.date, i.code, i.qty, i.price, i.amount, i.grn_no, i.txn_type,
           i.supplier, i.handler, i.remarks, i.order_line_id, i.contract_no,
           d.status AS doc_status,
           m.name AS material_name, m.spec AS material_spec, m.unit AS material_unit
    FROM inbound i
    LEFT JOIN inbound_docs d ON i.doc_no = d.doc_no
    LEFT JOIN materials m ON i.code = m.code
    WHERE i.status = 'posted'
      AND (i.po_no = ? OR i.order_line_id IN (SELECT id FROM order_lines WHERE po_no = ?))
    ORDER BY i.date DESC, i.id DESC`).all(poNo, poNo);
  res.json(rows);
});

router.post('/api/purchase/orders', requirePerm('purchase', 'create'), (req, res) => {
  const b = req.body || {};
  const date = b.date || '';
  // 单号缺省时按编号规则自动生成（草稿流：先建单，再补明细）
  const poNo = String(b.po_no || '').trim() || (date ? docno.genDocNo('po', date) : '');
  if (!poNo) return res.status(400).json({ error: '采购单号不能为空' });
  try {
    const exist = db.prepare("SELECT po_no FROM purchase_orders WHERE po_no = ?").get(poNo);
    if (exist) return res.status(400).json({ error: `采购单号已存在：${poNo}` });
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO purchase_orders (po_no,date,supplier,contract_no,project,expected_date,remarks,manual_status,status)
        VALUES (@po_no,@date,@supplier,@contract_no,@project,@expected_date,@remarks,@manual_status,@status)`)
        .run({
          po_no: poNo, date, supplier: b.supplier || '',
          contract_no: b.contract_no || '', project: b.project || '',
          expected_date: b.expected_date || '', remarks: b.remarks || '',
          manual_status: b.manual_status || '',
          status: b.status === 'draft' ? 'draft' : 'posted',
        });
      ensureContract(b.contract_no, b.supplier);
      if (Array.isArray(b.lines) && b.lines.length) insertLines(tx, poNo, b.lines, b.supplier);
    });
    tx();
    res.json({ success: true, po_no: poNo });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/purchase/orders/:poNo', requirePerm('purchase', 'edit'), (req, res) => {
  const poNo = req.params.poNo;
  const b = req.body || {};
  try {
    const exist = db.prepare("SELECT status FROM purchase_orders WHERE po_no = ?").get(poNo);
    if (!exist) return res.status(404).json({ error: '采购单不存在' });
    const tx = db.transaction(() => {
      db.prepare(`UPDATE purchase_orders SET date=@date,supplier=@supplier,contract_no=@contract_no,
        project=@project,expected_date=@expected_date,remarks=@remarks,manual_status=@manual_status
        WHERE po_no=@po_no`)
        .run({
          po_no: poNo, date: b.date || '', supplier: b.supplier || '',
          contract_no: b.contract_no || '', project: b.project || '',
          expected_date: b.expected_date || '', remarks: b.remarks || '',
          manual_status: b.manual_status || '',
        });
      ensureContract(b.contract_no, b.supplier);
      if (Array.isArray(b.lines)) {
        // 整单保存：表头 + 明细一起提交，明细按 id 增量同步（保住到货核销关联）
        syncLines(poNo, b.lines, b.supplier);
      } else if (b.contract_no) {
        // 头部的合同号是「默认合同」：只回填尚未单独指定合同的行
        db.prepare(`UPDATE order_lines SET contract_no = ?
          WHERE po_no = ? AND TRIM(COALESCE(contract_no,'')) = ''`).run(b.contract_no, poNo);
      }
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 确认采购单 —— 草稿 → 已确认
router.post('/api/purchase/orders/:poNo/confirm', requirePerm('purchase', 'edit'), (req, res) => {
  const poNo = req.params.poNo;
  const po = db.prepare("SELECT status FROM purchase_orders WHERE po_no = ?").get(poNo);
  if (!po) return res.status(404).json({ error: '采购单不存在' });
  if (po.status !== 'draft') return res.status(400).json({ error: '只有草稿状态的采购单可以确认', code: 'PO_NOT_DRAFT' });
  const cnt = db.prepare("SELECT COUNT(*) AS c FROM order_lines WHERE po_no = ?").get(poNo).c;
  if (cnt === 0) return res.status(400).json({ error: '采购单没有明细行，无法确认' });
  try {
    db.prepare("UPDATE purchase_orders SET status='posted' WHERE po_no = ?").run(poNo);
    res.json({ success: true, line_count: cnt });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/purchase/orders/:poNo', requirePerm('purchase', 'delete'), (req, res) => {
  const poNo = req.params.poNo;
  try {
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM inbound i
      WHERE i.status = 'posted' AND (i.po_no = ? OR i.order_line_id IN (SELECT id FROM order_lines WHERE po_no = ?))`)
      .get(poNo, poNo).c;
    if (cnt > 0) return res.status(400).json({ error: '该采购单已有入库记录，无法删除。请先冲销关联入库单。' });
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM order_lines WHERE po_no = ?").run(poNo);
      db.prepare("DELETE FROM purchase_orders WHERE po_no = ?").run(poNo);
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== 采购明细（行） ====================

function insertLines(tx, poNo, items, supplier) {
  const stmt = db.prepare(`INSERT INTO order_lines (po_no,code,order_qty,order_price,remarks,contract_no)
    VALUES (@po_no,@code,@order_qty,@order_price,@remarks,@contract_no)`);
  items.forEach(r => {
    if (!r.code) return;
    stmt.run({
      po_no: r.po_no || poNo, code: r.code,
      order_qty: Number(r.order_qty || 0), order_price: Number(r.order_price || 0),
      remarks: r.remarks || '', contract_no: r.contract_no || '',
    });
    ensureContract(r.contract_no, supplier);
  });
}

// 整单保存明细：按行 id 增量同步（有 id→更新，无 id→新增，缺失→删除）
// 关键点：不能整体删了重插，否则 inbound.order_line_id 会指向已删除的行，
//        导致到货核销统计失效。
function syncLines(poNo, items, supplier) {
  const exist = db.prepare("SELECT * FROM order_lines WHERE po_no = ?").all(poNo);
  const byId = new Map(exist.map(l => [Number(l.id), l]));
  const ins = db.prepare(`INSERT INTO order_lines (po_no,code,order_qty,order_price,remarks,contract_no)
    VALUES (@po_no,@code,@order_qty,@order_price,@remarks,@contract_no)`);
  const upd = db.prepare(`UPDATE order_lines SET code=@code,order_qty=@order_qty,order_price=@order_price,
    remarks=@remarks,contract_no=@contract_no WHERE id=@id`);
  const keep = new Set();

  items.forEach(r => {
    if (!r || !r.code) return;
    const id = r.id ? Number(r.id) : 0;
    const qty = Number(r.order_qty || 0);
    const price = Number(r.order_price || 0);
    const contractNo = r.contract_no || '';
    if (id && byId.has(id)) {
      const old = byId.get(id);
      const received = receivedQtyOfLine(id);
      if (received > 0 && qty + 0.0001 < received) {
        throw new Error(`物料 ${old.code} 的订购数量不能小于已到货数量 ${received}`);
      }
      upd.run({ id, code: r.code, order_qty: qty, order_price: price, remarks: r.remarks || '', contract_no: contractNo });
      keep.add(id);
    } else {
      const info = ins.run({ po_no: poNo, code: r.code, order_qty: qty, order_price: price, remarks: r.remarks || '', contract_no: contractNo });
      keep.add(Number(info.lastInsertRowid));
    }
    ensureContract(contractNo, supplier);
  });

  exist.forEach(l => {
    if (keep.has(Number(l.id))) return;
    const received = receivedQtyOfLine(l.id);
    if (received > 0) throw new Error(`明细 ${l.code} 已有到货记录（${received}），不能删除；如需撤销请先冲销关联入库单`);
    db.prepare("DELETE FROM order_lines WHERE id = ?").run(l.id);
  });
}

// 批量写入采购明细（同一张采购单下同一物料只允许一行）
router.post('/api/purchase/lines/batch', requirePerm('purchase', 'create'), (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '无数据' });
  try {
    const tx = db.transaction(() => { insertLines(tx, items[0].po_no, items); });
    tx();
    res.json({ success: true, count: items.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/purchase/lines', requirePerm('purchase', 'create'), (req, res) => {
  const l = req.body || {};
  try {
    const tx = db.transaction(() => { insertLines(tx, l.po_no, [l]); });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/purchase/lines/:id', requirePerm('purchase', 'edit'), (req, res) => {
  const l = req.body || {};
  try {
    const exist = db.prepare("SELECT * FROM order_lines WHERE id = ?").get(req.params.id);
    if (!exist) return res.status(404).json({ error: '采购明细不存在' });
    const tx = db.transaction(() => {
      db.prepare(`UPDATE order_lines SET po_no=@po_no,code=@code,order_qty=@order_qty,
        order_price=@order_price,remarks=@remarks,contract_no=@contract_no WHERE id=@id`)
        .run({
          id: req.params.id,
          po_no: l.po_no || exist.po_no, code: l.code || exist.code,
          order_qty: l.order_qty !== undefined ? Number(l.order_qty) : exist.order_qty,
          order_price: l.order_price !== undefined ? Number(l.order_price) : exist.order_price,
          remarks: l.remarks !== undefined ? l.remarks : exist.remarks,
          contract_no: l.contract_no !== undefined ? l.contract_no : exist.contract_no,
        });
      ensureContract(l.contract_no !== undefined ? l.contract_no : exist.contract_no, '');
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/purchase/lines/:id', requirePerm('purchase', 'delete'), (req, res) => {
  try {
    const line = db.prepare(`${LINE_SEL} WHERE ol.id = ?`).get(req.params.id);
    if (!line) return res.status(404).json({ error: '采购明细不存在' });
    const received = Number(line.received_qty || 0);
    if (received > 0) {
      return res.status(400).json({ error: `该明细已有到货记录（${received}），不能删除；如需撤销请先冲销关联入库单` });
    }
    db.prepare("DELETE FROM order_lines WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 采购明细综合查询（全部 / 按采购单 / 按合同）
router.get('/api/purchase/lines', requirePerm('purchase', 'view'), (req, res) => {
  const { poNo, contractNo, supplier, keyword, deliveryStatus, dateFrom, dateTo } = req.query;
  let sql = `${LINE_SEL} WHERE 1=1`;
  const params = [];
  if (poNo) { sql += " AND ol.po_no = ?"; params.push(poNo); }
  if (contractNo) { sql += ` AND ${EFF_CONTRACT} = ?`; params.push(contractNo); }
  if (supplier) { sql += " AND po.supplier LIKE ?"; params.push('%' + supplier + '%'); }
  if (dateFrom) { sql += " AND po.date >= ?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND po.date <= ?"; params.push(dateTo + ' 23:59:59'); }
  if (keyword) {
    kwTokens(keyword).forEach(tk => {
      const kw = '%' + tk + '%';
      sql += " AND (ol.code LIKE ? OR ol.po_no LIKE ? OR ol.contract_no LIKE ? OR po.contract_no LIKE ?" +
        " OR m.name LIKE ? OR m.spec LIKE ? OR m.brand LIKE ? OR po.supplier LIKE ?)";
      params.push(kw, kw, kw, kw, kw, kw, kw, kw);
    });
  }
  sql += " ORDER BY ol.po_no DESC, ol.id";
  let rows = db.prepare(sql).all(...params).map(enrichLine);
  if (deliveryStatus) rows = rows.filter(r => r.line_status === deliveryStatus);
  res.json(rows);
});

// 单个采购明细的到货履历（下钻：这张明细被哪些入库单核销了多少）
router.get('/api/purchase/lines/:id/inbound', requirePerm('purchase', 'view'), (req, res) => {
  const line = db.prepare(`${LINE_SEL} WHERE ol.id = ?`).get(req.params.id);
  if (!line) return res.status(404).json({ error: '采购明细不存在' });
  const e = enrichLine(line);
  const rows = db.prepare(`
    SELECT i.id, i.date, i.qty, i.price, i.amount, i.grn_no, i.doc_no, i.txn_type,
           i.supplier, i.handler, i.remarks, i.order_line_id, d.status AS doc_status
    FROM inbound i
    LEFT JOIN inbound_docs d ON i.doc_no = d.doc_no
    WHERE i.status = 'posted' AND (
      i.order_line_id = ? OR (
        i.order_line_id = 0 AND i.po_no = ? AND i.code = ?
        AND (? = '' OR TRIM(COALESCE(i.contract_no,'')) = '' OR i.contract_no = ?)
      )
    )
    ORDER BY i.date, i.id`).all(e.id, e.po_no, e.code, e.contract_no_eff, e.contract_no_eff);

  let acc = 0;
  const history = rows.map(r => {
    acc += Number(r.qty || 0);
    return { ...r, cum_qty: r2(acc) };
  });
  res.json({
    line: e,
    history,
    summary: {
      received_qty: e.received_qty,
      unreceived_qty: e.unreceived_qty,
      inbound_count: history.length,
      order_qty: Number(e.order_qty || 0),
    },
  });
});

// 供入库选单：按采购单 / 按合同 带出未到齐的明细
router.get('/api/purchase/lines/by-po/:poNo', requirePerm('purchase', 'view'), (req, res) => {
  try { res.json(getOrderLinesForInbound(req.params.poNo)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/api/purchase/lines/by-contract/:contractNo', requirePerm('purchase', 'view'), (req, res) => {
  try { res.json(getOrderLinesByContract(req.params.contractNo)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 入库选单用：采购单下拉（只给未到齐仍有余额的）
router.get('/api/purchase/pending-orders', requirePerm('purchase', 'view'), (req, res) => {
  const orders = db.prepare("SELECT po_no, date, supplier, contract_no, expected_date, manual_status FROM purchase_orders ORDER BY date DESC").all();
  const out = [];
  orders.forEach(o => {
    if (o.manual_status === '已取消' || o.manual_status === '已关闭') { out.push({ ...o, has_pending: false }); return; }
    const lines = db.prepare(`${LINE_SEL} WHERE ol.po_no = ?`).all(o.po_no).map(enrichLine)
      .filter(l => l.unreceived_qty > 0);
    if (lines.length > 0) out.push({ ...o, has_pending: true });
  });
  res.json(out);
});

// ==================== 合同 ====================

// 合同汇总列表（含采购单数、明细数、金额、到货率、预计到货区间）
router.get('/api/purchase/contracts', requirePerm('purchase', 'view'), (req, res) => {
  const { keyword, supplier, status } = req.query;
  let sql = "SELECT * FROM contracts WHERE 1=1";
  const params = [];
  if (supplier) { sql += " AND supplier LIKE ?"; params.push('%' + supplier + '%'); }
  if (status) { sql += " AND status = ?"; params.push(status); }
  if (keyword) {
    kwTokens(keyword).forEach(tk => {
      const kw = '%' + tk + '%';
      sql += " AND (contract_no LIKE ? OR name LIKE ? OR supplier LIKE ? OR remarks LIKE ?)";
      params.push(kw, kw, kw, kw);
    });
  }
  sql += " ORDER BY contract_no";
  const list = db.prepare(sql).all(...params);

  const allLines = db.prepare(`${LINE_SEL} ORDER BY ol.po_no, ol.id`).all().map(enrichLine);
  const byContract = new Map();
  allLines.forEach(l => {
    const k = l.contract_no_eff;
    if (!k) return;
    if (!byContract.has(k)) byContract.set(k, []);
    byContract.get(k).push(l);
  });

  res.json(list.map(c => {
    const lines = byContract.get(c.contract_no) || [];
    const pos = [...new Set(lines.map(l => l.po_no))];
    const orderAmount = lines.reduce((s, l) => s + Number(l.order_amount || 0), 0);
    const receivedAmount = lines.reduce((s, l) => s + Number(l.received_qty || 0) * Number(l.order_price || 0), 0);
    const dates = lines.map(l => l.expected_date).filter(Boolean).sort();
    return {
      ...c,
      po_count: pos.length,
      line_count: lines.length,
      order_amount: r2(orderAmount),
      received_amount: r2(receivedAmount),
      receive_rate: orderAmount > 0 ? Math.round(receivedAmount / orderAmount * 1000) / 10 : 0,
      expected_from: dates[0] || '',
      expected_to: dates[dates.length - 1] || '',
    };
  }));
});

// 合同详情（合同头 + 采购单清单 + 采购明细 + 入库明细 + 汇总 + 操作日志）
router.get('/api/purchase/contracts/:contractNo', requirePerm('purchase', 'view'), (req, res) => {
  const no = req.params.contractNo;
  const contract = db.prepare("SELECT * FROM contracts WHERE contract_no = ?").get(no);
  if (!contract) return res.status(404).json({ error: '合同不存在' });

  const lines = db.prepare(`${LINE_SEL} WHERE ${EFF_CONTRACT} = ? ORDER BY ol.po_no, ol.id`).all(no).map(enrichLine);
  const poNos = [...new Set(lines.map(l => l.po_no))];

  const orders = poNos.length
    ? db.prepare(`SELECT * FROM purchase_orders WHERE po_no IN (${poNos.map(() => '?').join(',')}) ORDER BY date DESC`).all(...poNos)
    : [];

  const orderAmount = lines.reduce((s, l) => s + Number(l.order_amount || 0), 0);
  const receivedAmount = lines.reduce((s, l) => s + Number(l.received_qty || 0) * Number(l.order_price || 0), 0);
  const receivedQty = lines.reduce((s, l) => s + Number(l.received_qty || 0), 0);
  const orderQty = lines.reduce((s, l) => s + Number(l.order_qty || 0), 0);

  const inboundDocs = db.prepare(`
    SELECT d.doc_no, d.date, d.txn_type, d.supplier, d.handler, d.status, d.po_no, d.contract_no, d.confirmed_at,
      (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no) AS line_count,
      (SELECT COALESCE(SUM(i.qty),0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_qty,
      (SELECT COALESCE(SUM(i.amount),0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_amount
    FROM inbound_docs d
    WHERE d.doc_no <> '' AND d.doc_no IN (
      SELECT DISTINCT i.doc_no FROM inbound i
      WHERE i.doc_no <> '' AND i.status = 'posted' AND TRIM(COALESCE(i.contract_no,'')) = ?
    )
    ORDER BY d.date DESC, d.created_at DESC`).all(no);

  res.json({
    ...contract,
    orders,
    lines,
    inbound_docs: inboundDocs,
    logs: fetchLogs('purchase', no, 200),
    summary: {
      po_count: poNos.length,
      line_count: lines.length,
      order_qty: r2(orderQty),
      order_amount: r2(orderAmount),
      received_qty: r2(receivedQty),
      unreceived_qty: r2(orderQty - receivedQty),
      received_amount: r2(receivedAmount),
      receive_rate: orderAmount > 0 ? Math.round(receivedAmount / orderAmount * 1000) / 10 : 0,
    },
  });
});

// 合同的「行级入库明细」：模板「入库」页签按物料行展示到货流水
router.get('/api/purchase/contracts/:contractNo/inbound-lines', requirePerm('purchase', 'view'), (req, res) => {
  const no = req.params.contractNo;
  const rows = db.prepare(`
    SELECT i.id, i.doc_no, i.date, i.code, i.qty, i.price, i.amount, i.grn_no, i.txn_type,
           i.supplier, i.handler, i.remarks, i.order_line_id, i.contract_no, i.po_no,
           d.status AS doc_status,
           m.name AS material_name, m.spec AS material_spec, m.unit AS material_unit
    FROM inbound i
    LEFT JOIN inbound_docs d ON i.doc_no = d.doc_no
    LEFT JOIN materials m ON i.code = m.code
    WHERE i.status = 'posted'
      AND (TRIM(COALESCE(i.contract_no,'')) = ?
        OR i.order_line_id IN (
          SELECT ol.id FROM order_lines ol
          JOIN purchase_orders po ON po.po_no = ol.po_no
          WHERE ${EFF_CONTRACT} = ?))
    ORDER BY i.date DESC, i.id DESC`).all(no, no);
  res.json(rows);
});

router.post('/api/purchase/contracts', requirePerm('purchase', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.contract_no) return res.status(400).json({ error: '合同号不能为空' });
  try {
    db.prepare(`INSERT INTO contracts (contract_no,name,supplier,sign_date,amount,status,remarks,created_by)
      VALUES (@contract_no,@name,@supplier,@sign_date,@amount,@status,@remarks,@created_by)`)
      .run({
        contract_no: String(b.contract_no).trim(), name: b.name || '', supplier: b.supplier || '',
        sign_date: b.sign_date || '', amount: Number(b.amount || 0),
        status: b.status || 'active', remarks: b.remarks || '',
        created_by: req.user?.name || req.user?.username || '',
      });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/purchase/contracts/:contractNo', requirePerm('purchase', 'edit'), (req, res) => {
  const no = req.params.contractNo;
  const b = req.body || {};
  try {
    const exist = db.prepare("SELECT contract_no FROM contracts WHERE contract_no = ?").get(no);
    if (!exist) return res.status(404).json({ error: '合同不存在' });
    db.prepare(`UPDATE contracts SET name=@name,supplier=@supplier,sign_date=@sign_date,
      amount=@amount,status=@status,remarks=@remarks WHERE contract_no=@contract_no`)
      .run({
        contract_no: no, name: b.name || '', supplier: b.supplier || '',
        sign_date: b.sign_date || '', amount: Number(b.amount || 0),
        status: b.status || 'active', remarks: b.remarks || '',
      });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/purchase/contracts/:contractNo', requirePerm('purchase', 'delete'), (req, res) => {
  const no = req.params.contractNo;
  try {
    const used = db.prepare(`
      SELECT (SELECT COUNT(*) FROM order_lines WHERE contract_no = ?) AS a,
             (SELECT COUNT(*) FROM purchase_orders WHERE contract_no = ?) AS b,
             (SELECT COUNT(*) FROM inbound WHERE contract_no = ? AND status = 'posted') AS c`)
      .get(no, no, no);
    if (used.a + used.b + used.c > 0) {
      return res.status(400).json({ error: '合同已被采购单/入库单引用，不能删除' });
    }
    db.prepare("DELETE FROM contracts WHERE contract_no = ?").run(no);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
