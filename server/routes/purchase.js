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
const { requirePerm, hasGrant } = require('../middleware/auth');
const audit = require('../services/audit');
const costing = require('../services/costing');
const {
  getOrderLinesForInbound,
  getOrderLinesByContract,
  getPurchaseScopeLines,
  RECEIVED_BY_LINE,
  EFF_CONTRACT,
} = require('../services/stock');
const docno = require('../services/docno');
const { maskRows, requirePriceEdit } = require('../services/price-mask');
const { kwClause, kwClauseExpr } = require('../utils/search');
const { clientIp } = require('../utils/client-ip');

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

// ==================== 关联单据（单据级，B 口径） ====================
// 粒度＝入库单头：一张单一行。
//
// 1) 是否出现：归属判定取并集 ——
//    采购单：单头 po_no 匹配，或该单任一入库明细行 po_no 匹配 / order_line_id 核销到该采购单；
//    合同  ：单头 contract_no 匹配，或任一明细行 contract_no 匹配 /
//            order_line_id 的有效合同（EFF_CONTRACT：行级合同优先、单头合同兜底）匹配。
//    两者取或的原因：单头可能为空而关系落在明细行，也可能反过来；只比单头或只比明细行都会漏。
//    外层 GROUP BY doc_no：多个条件同时命中同一张单只出现一次，不会重复。
//
// 2) 显示的数字：只统计「属于这张采购单/合同」的明细行，SUM(qty)/SUM(amount) 有符号
//    （采购退货行本身为负，按存储值如实返回，不取绝对值）。
//    若单据因单头匹配而入列、但没有任何属于本采购单/合同的明细行，数量金额为 0，
//    单据照列（line_count = 0），由前端标注「该单无本采购单/本合同明细」。
//
// 本列表只回答「哪些单据属于这张采购单/合同」，不参与库存与净到货统计；
// 因此草稿、作废单据同样返回，由前端用状态徽标与弱化样式区分。
function relatedInboundDocs(scope) {
  const key = scope.poNo || scope.contractNo;
  const where = scope.poNo
    ? `(
        TRIM(COALESCE(d.po_no,'')) = ?
        OR EXISTS (SELECT 1 FROM inbound i WHERE i.doc_no = d.doc_no AND TRIM(COALESCE(i.po_no,'')) = ?)
        OR EXISTS (SELECT 1 FROM inbound i2 WHERE i2.doc_no = d.doc_no
             AND i2.order_line_id IN (SELECT id FROM order_lines WHERE po_no = ?))
      )`
    : `(
        TRIM(COALESCE(d.contract_no,'')) = ?
        OR EXISTS (SELECT 1 FROM inbound i WHERE i.doc_no = d.doc_no AND TRIM(COALESCE(i.contract_no,'')) = ?)
        OR EXISTS (SELECT 1 FROM inbound i2 WHERE i2.doc_no = d.doc_no
             AND i2.order_line_id IN (
               SELECT ol.id FROM order_lines ol LEFT JOIN purchase_orders po ON po.po_no = ol.po_no
               WHERE ${EFF_CONTRACT} = ?))
      )`;
  // 只有这些明细行计入数量/金额小计
  const lineCond = scope.poNo
    ? `(TRIM(COALESCE(i.po_no,'')) = ?
         OR i.order_line_id IN (SELECT id FROM order_lines WHERE po_no = ?))`
    : `(TRIM(COALESCE(i.contract_no,'')) = ?
         OR i.order_line_id IN (
           SELECT ol.id FROM order_lines ol LEFT JOIN purchase_orders po ON po.po_no = ol.po_no
           WHERE ${EFF_CONTRACT} = ?))`;
  return db.prepare(`
    SELECT d.doc_no, d.date, d.txn_type, d.status,
           COALESCE(d.supplier,'') AS supplier, COALESCE(d.handler,'') AS handler,
           COUNT(i.id) AS line_count,
           COALESCE(SUM(i.qty),0) AS total_qty,
           COALESCE(SUM(i.amount),0) AS total_amount
      FROM inbound_docs d
      LEFT JOIN inbound i ON i.doc_no = d.doc_no AND ${lineCond}
     WHERE d.doc_no <> '' AND ${where}
     GROUP BY d.doc_no
     ORDER BY d.date DESC, d.doc_no DESC`).all(key, key, key, key, key);
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
// detail/detail_json 可能含补价重算写入的真实金额，须与系统日志页同口径按价格权限脱敏
function fetchLogs(module, target, limit, canViewPrice) {
  const rows = db.prepare(`SELECT id, username, name, action, target, method, detail, detail_json, created_at
    FROM audit_logs WHERE module = ? AND target = ? ORDER BY id DESC LIMIT ?`)
    .all(module, target, limit || 200);
  return canViewPrice ? rows : rows.map(r => audit.maskRowDetail(r, false));
}

// 单条采购明细的已到货数量（用于编辑时的数量下限 / 删除保护）
// 别名必须是数量列登记表里的 received_qty，scaled-db 才会把库里的 1e6 定点还原成件数；
// 用任意别名（如 r）会拿到 10000000 这类原始定点值，导致与订购数量比较恒不通过。
function receivedQtyOfLine(lineId) {
  const row = db.prepare(`SELECT ${RECEIVED_BY_LINE} AS received_qty FROM order_lines ol
    LEFT JOIN purchase_orders po ON ol.po_no = po.po_no WHERE ol.id = ?`).get(lineId);
  return row ? Number(row.received_qty || 0) : 0;
}

// ==================== 已确认单编辑（modify） ====================

// 草稿走 manage（建档/编辑草稿），已确认走 modify（修改已确认单）
function editActionOf(status) {
  return status === 'draft' ? 'manage' : 'modify';
}

// 校验采购单存在 + 对应状态的编辑权限；不通过时直接写响应并返回 null
function requireOrderEdit(req, res, poNo) {
  const po = db.prepare('SELECT status FROM purchase_orders WHERE po_no = ?').get(poNo);
  if (!po) { res.status(404).json({ error: '采购单不存在' }); return null; }
  const action = editActionOf(po.status);
  if (!hasGrant(req.grants, 'purchase', action)) {
    const body = { error: action === 'modify' ? '权限不足：无「修改已确认单」权限' : '权限不足：无该操作权限' };
    if (action === 'modify') body.code = 'PERM_PURCHASE_MODIFY';
    res.status(403).json(body);
    return null;
  }
  return po;
}

const HEAD_LABELS = [
  ['date', '日期'], ['supplier', '供应商'], ['contract_no', '合同号'], ['project', '项目'],
  ['expected_date', '预计到货'], ['manual_status', '手工状态'], ['remarks', '备注'],
];

// 修改前后快照：只取会出现在审计里的业务字段（单价只判断是否变化，不落数值）
function orderSnapshot(poNo) {
  const head = db.prepare(`SELECT date,supplier,contract_no,project,expected_date,manual_status,remarks
    FROM purchase_orders WHERE po_no = ?`).get(poNo) || {};
  const lines = db.prepare(`SELECT id,code,order_qty,order_price,contract_no,remarks
    FROM order_lines WHERE po_no = ? ORDER BY id`).all(poNo);
  return { head, lines };
}

function briefText(v, max) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > (max || 40) ? s.slice(0, max || 40) + '…' : s;
}

// 生成「改了哪些字段」的审计文案；价格只写「单价已调整」，避免无价格权限者从日志读回金额
function diffOrder(before, after) {
  const out = [];
  HEAD_LABELS.forEach(([k, label]) => {
    const a = String(before.head[k] == null ? '' : before.head[k]);
    const b = String(after.head[k] == null ? '' : after.head[k]);
    if (a !== b) out.push(`表头 ${label}：${briefText(a) || '空'} → ${briefText(b) || '空'}`);
  });
  const beforeMap = new Map(before.lines.map(l => [Number(l.id), l]));
  const afterMap = new Map(after.lines.map(l => [Number(l.id), l]));
  after.lines.forEach(l => {
    if (!beforeMap.has(Number(l.id))) out.push(`新增明细 ${l.code}：数量 ${l.order_qty}`);
  });
  before.lines.forEach(l => {
    const a = afterMap.get(Number(l.id));
    if (!a) { out.push(`删除明细 ${l.code}：数量 ${l.order_qty}`); return; }
    const ch = [];
    if (String(l.code) !== String(a.code)) ch.push(`物料 ${l.code} → ${a.code}`);
    if (Number(l.order_qty) !== Number(a.order_qty)) ch.push(`数量 ${l.order_qty} → ${a.order_qty}`);
    if (Number(l.order_price) !== Number(a.order_price)) ch.push('单价已调整');
    if (String(l.contract_no || '') !== String(a.contract_no || '')) {
      ch.push(`合同号 ${briefText(l.contract_no) || '空'} → ${briefText(a.contract_no) || '空'}`);
    }
    if (String(l.remarks || '') !== String(a.remarks || '')) ch.push('备注已调整');
    if (ch.length) out.push(`修改明细 ${l.code}：${ch.join('，')}`);
  });
  return out.join('；');
}

// 已确认单的改动只落审计日志：路由自行记录更精确的字段差异，跳过后台通用摘要
function recordModifyAudit(req, poNo, detail) {
  const u = req.user || {};
  audit.record({
    user_id: u.id || null,
    username: u.username || '',
    name: u.name || '',
    role: u.role || '',
    module: 'purchase',
    action: 'update',
    target: poNo,
    method: req.method,
    path: req.originalUrl.split('?')[0],
    ip: clientIp(req),
    status: 200,
    detail: detail || '表头与明细未发生变化',
  });
  req.skipGenericAudit = true;
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
    const k = kwClauseExpr([
      'po.po_no LIKE ?',
      'po.contract_no LIKE ?',
      'po.supplier LIKE ?',
      'po.project LIKE ?',
      'po.remarks LIKE ?',
      'EXISTS (SELECT 1 FROM order_lines ol2 WHERE ol2.po_no = po.po_no AND (ol2.code LIKE ? OR ol2.contract_no LIKE ?))',
      'EXISTS (SELECT 1 FROM order_lines ol3 LEFT JOIN materials m3 ON ol3.code = m3.code WHERE ol3.po_no = po.po_no AND (m3.name LIKE ? OR m3.spec LIKE ? OR m3.brand LIKE ?))',
    ], keyword);
    if (k.sql) { sql += ' AND ' + k.sql; params.push(...k.params); }
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
  // 无价格权限：订单金额与已到货金额不下发（数量、笔数、到货状态保留）
  res.json(maskRows(req, result, ['order_amount', 'received_amount']));
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

  const relatedDocs = relatedInboundDocs({ poNo });
  const summary = {
    line_count: lines.length,
    order_qty: r2(orderQty),
    order_amount: r2(orderAmount),
    received_qty: r2(receivedQty),
    unreceived_qty: r2(orderQty - receivedQty),
    received_amount: r2(receivedAmount),
    unreceived_amount: r2(orderAmount - receivedAmount),
    delivery_status,
    overdue_days: overdueDaysOf(po.expected_date, delivery_status),
  };

  // 无价格权限：行单价/行金额、订单与到货金额、入库单金额整组不下发（数量类保留）
  if (!req.canViewPrice) {
    lines.forEach(l => { delete l.order_price; delete l.order_amount; });
    inboundDocs.forEach(d => { delete d.total_amount; });
    relatedDocs.forEach(d => { delete d.total_amount; });
    delete summary.order_amount;
    delete summary.received_amount;
    delete summary.unreceived_amount;
  }
  res.json({
    ...po,
    lines,
    inbound_docs: inboundDocs,
    related_inbound_docs: relatedDocs.filter(r => r.txn_type !== '采购退货'),
    related_return_docs: relatedDocs.filter(r => r.txn_type === '采购退货'),
    logs: fetchLogs('purchase', poNo, 200, !!req.canViewPrice),
    summary,
  });
});

router.post('/api/purchase/orders', requirePerm('purchase', 'manage'), requirePriceEdit, (req, res) => {
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

router.put('/api/purchase/orders/:poNo', requirePriceEdit, (req, res) => {
  const poNo = req.params.poNo;
  const b = req.body || {};
  try {
    // 草稿要 manage，已确认要 modify；修改已确认单不改变状态
    const po = requireOrderEdit(req, res, poNo);
    if (!po) return;
    const before = po.status === 'posted' ? orderSnapshot(poNo) : null;
    const operator = (req.user && req.user.username) || '';
    let priceChanges = [];
    let priceSync = null;
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
      // 供应商/合同号后补：同步到已生成的入库单、退货单
      cascadePoRefs(poNo);
      // 已确认单至少保留一行有效明细；校验放在同一事务内，失败整体回滚
      if (po.status === 'posted') {
        const cnt = db.prepare('SELECT COUNT(*) AS c FROM order_lines WHERE po_no = ?').get(poNo).c;
        if (cnt === 0) {
          const err = new Error('已确认的采购单至少要保留一行有效明细');
          err.code = 'PO_LAST_LINE';
          throw err;
        }
        // 单价变化：同步引用该采购行的入库/退货，已过账单据从过账位置重算
        priceChanges = priceChangesOf(before, orderSnapshot(poNo));
        priceSync = syncPoPriceChanges(poNo, priceChanges, operator);
      }
    });
    tx();
    const after = orderSnapshot(poNo);
    if (before) recordModifyAudit(req, poNo, diffOrder(before, after));
    if (priceChanges.length) recordPriceSyncAudit(req, poNo, priceSync, priceChanges);
    res.json({ success: true, price_sync: priceSync ? priceSyncSummary(priceSync) : null });
  } catch (e) {
    // 行级校验错误带 code / details，前端据此做行内红框与提示
    res.status(400).json({ error: e.message, code: e.code, details: e.details });
  }
});

// 确认采购单 —— 草稿 → 已确认
router.post('/api/purchase/orders/:poNo/confirm', requirePerm('purchase', 'post'), (req, res) => {
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
    // 整单删除只允许草稿：已确认的采购单已进入执行链路（可能已被入库单引用），
    // 不能凭 delete 权限直接抹掉；主数据缺失时同样按 404 处理，避免静默成功。
    const po = db.prepare('SELECT status FROM purchase_orders WHERE po_no = ?').get(poNo);
    if (!po) return res.status(404).json({ error: '采购单不存在' });
    if (po.status !== 'draft') {
      return res.status(400).json({ error: '已确认的采购单不能删除，仅草稿状态的采购单可以删除', code: 'PO_NOT_DRAFT' });
    }
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM inbound i
      WHERE i.status = 'posted' AND (i.po_no = ? OR i.order_line_id IN (SELECT id FROM order_lines WHERE po_no = ?))`)
      .get(poNo, poNo).c;
    if (cnt > 0) return res.status(400).json({ error: '该采购单已有入库记录，无法删除。请先更正关联入库单。' });
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
    // 无价格权限的前端不会回传 order_price：编辑既有行时沿用原单价，避免被写成 0
    const price = r.order_price !== undefined
      ? Number(r.order_price || 0)
      : (id && byId.has(id) ? Number(byId.get(id).order_price || 0) : 0);
    const contractNo = r.contract_no || '';
    if (id && byId.has(id)) {
      const old = byId.get(id);
      const received = receivedQtyOfLine(id);
      if (received > 0 && qty + 1e-6 < received) {
        // 带上行标识，前端按 line_id 定位到具体行做行内提示（不只弹整屏 toast）
        const err = new Error(`物料 ${old.code} 的订购数量不能小于已到货数量 ${received}`);
        err.code = 'PO_QTY_BELOW_RECEIVED';
        err.details = [{ line_id: id, code: old.code, order_qty: qty, received_qty: received }];
        throw err;
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
    if (received > 0) throw new Error(`明细 ${l.code} 已有到货记录（${received}），不能删除；如需撤销请先更正关联入库单`);
    db.prepare("DELETE FROM order_lines WHERE id = ?").run(l.id);
  });
}

// 采购单供应商/合同号允许后补：保存时在同一事务内把新值同步到所有引用它的单据
//  ① 归属该采购单的入库单（含采购退货/零星退货）刷新单头 supplier / contract_no
//  ② 入库明细按 order_line_id 对齐采购行的 contract_no / po_no
//  ③ 引用这些入库单的退货单从原入库单回填
//  ④ 退货明细按 origin_line_id 从原入库行回填
// 供应商按采购单当前值原样同步（清空也同步，避免留旧值）；合同号仅在采购单有值时覆盖。
function cascadePoRefs(poNo) {
  const po = db.prepare('SELECT supplier, contract_no FROM purchase_orders WHERE po_no=?').get(poNo);
  if (!po) return;
  const supplier = String(po.supplier || '');
  const headerContract = String(po.contract_no || '');

  // 归属该采购单的入库单：单头 po_no 命中，或明细行通过 order_line_id 命中
  const docNos = new Set();
  db.prepare('SELECT doc_no FROM inbound_docs WHERE po_no=?').all(poNo).forEach(r => docNos.add(r.doc_no));
  db.prepare(`SELECT DISTINCT i.doc_no FROM inbound i
      JOIN order_lines ol ON ol.id = i.order_line_id WHERE ol.po_no=?`).all(poNo).forEach(r => docNos.add(r.doc_no));

  // ② 入库明细行
  db.prepare(`UPDATE inbound SET po_no=?,
      contract_no=COALESCE((SELECT NULLIF(TRIM(ol.contract_no),'') FROM order_lines ol WHERE ol.id=inbound.order_line_id), contract_no)
    WHERE order_line_id IN (SELECT id FROM order_lines WHERE po_no=?)`).run(poNo, poNo);

  // ① 入库单头
  const updHead = db.prepare(`UPDATE inbound_docs SET supplier=?,
      contract_no=CASE WHEN ?<>'' THEN ? ELSE contract_no END WHERE doc_no=?`);
  docNos.forEach(no => updHead.run(supplier, headerContract, headerContract, no));

  // ③ 采购退货单：来源原入库单 + 按采购单档位引用的退货单
  const retDocNos = new Set();
  docNos.forEach(no => {
    const origin = db.prepare('SELECT supplier, contract_no FROM inbound_docs WHERE doc_no=?').get(no) || {};
    db.prepare(`UPDATE inbound_docs SET supplier=?, contract_no=?
      WHERE origin_doc_no=? AND txn_type IN ('采购退货','零星退货')`)
      .run(origin.supplier || '', origin.contract_no || '', no);
    db.prepare(`SELECT doc_no FROM inbound_docs WHERE origin_doc_no=? AND txn_type IN ('采购退货','零星退货')`)
      .all(no).forEach(r => retDocNos.add(r.doc_no));
  });
  db.prepare(`UPDATE inbound_docs SET supplier=?,
      contract_no=CASE WHEN ?<>'' THEN ? ELSE contract_no END
    WHERE return_tier='po' AND return_ref_no=? AND txn_type='采购退货'`)
    .run(supplier, headerContract, headerContract, poNo);
  db.prepare(`SELECT doc_no FROM inbound_docs WHERE return_tier='po' AND return_ref_no=? AND txn_type='采购退货'`)
    .all(poNo).forEach(r => retDocNos.add(r.doc_no));

  // ④ 退货明细行
  const updRetLine = db.prepare(`UPDATE inbound SET
      po_no=COALESCE(NULLIF((SELECT o.po_no FROM inbound o WHERE o.id=inbound.origin_line_id),''), po_no),
      contract_no=COALESCE(NULLIF((SELECT o.contract_no FROM inbound o WHERE o.id=inbound.origin_line_id),''), contract_no)
    WHERE doc_no=? AND origin_line_id>0`);
  retDocNos.forEach(no => updRetLine.run(no));
}

// ==================== 改价向下游同步 ====================
const PRICE_EPS = 1e-8;
const RETURN_TXNS = new Set(['采购退货', '零星退货']);

function priceChanged(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) > PRICE_EPS;
}

// 对比保存前后的采购明细，找出单价变化的行
function priceChangesOf(before, after) {
  if (!before || !after) return [];
  const afterMap = new Map((after.lines || []).map(l => [Number(l.id), l]));
  const out = [];
  for (const b of before.lines || []) {
    const a = afterMap.get(Number(b.id));
    if (!a) continue;
    if (!priceChanged(b.order_price, a.order_price)) continue;
    out.push({
      id: Number(b.id),
      code: a.code || b.code,
      oldPrice: Number(b.order_price) || 0,
      newPrice: Number(a.order_price) || 0,
    });
  }
  return out;
}

// 采购单改价：草稿入库直接改价；已过账入库改价并从过账位置重算；
// 引用这些入库行的退货明细跟随改价，已过账退货同样重算。
function syncPoPriceChanges(poNo, changes, operator) {
  const out = {
    synced_docs: [], recalculated_docs: [],
    synced_returns: [], recalculated_returns: [],
    inbound_changes: [], return_changes: [], balance_after: [],
  };
  if (!changes.length) return out;
  const changeById = new Map(changes.map(c => [c.id, c]));
  const ids = changes.map(c => c.id);
  const ph = ids.map(() => '?').join(',');

  const inboundLines = db.prepare(`SELECT i.id, i.doc_no, i.code, i.price, i.order_line_id, d.status, d.txn_type
    FROM inbound i JOIN inbound_docs d ON d.doc_no = i.doc_no
    WHERE i.order_line_id IN (${ph}) AND d.status IN ('draft','posted')`).all(...ids);
  const docMap = new Map();
  const priceByInbound = new Map();
  const updInbound = db.prepare('UPDATE inbound SET price=? WHERE id=?');
  for (const l of inboundLines) {
    if (RETURN_TXNS.has(String(l.txn_type || ''))) continue;
    const ch = changeById.get(Number(l.order_line_id));
    if (!ch) continue;
    const oldPrice = Number(l.price) || 0;
    if (!priceChanged(oldPrice, ch.newPrice)) continue;
    updInbound.run(ch.newPrice, l.id);
    let rec = docMap.get(l.doc_no);
    if (!rec) { rec = { docNo: l.doc_no, status: l.status, changes: [] }; docMap.set(l.doc_no, rec); }
    rec.changes.push({ lineId: Number(l.id), code: l.code, oldPrice, newPrice: ch.newPrice });
    priceByInbound.set(Number(l.id), ch.newPrice);
    out.inbound_changes.push({
      doc_no: l.doc_no, line_id: Number(l.id), code: l.code,
      old_price: oldPrice, new_price: ch.newPrice, status: l.status,
    });
  }
  for (const rec of docMap.values()) {
    out.synced_docs.push(rec.docNo);
    if (rec.status !== 'posted') continue;
    const r = costing.updateInboundPrices(rec.docNo, rec.changes, { triggerDoc: poNo, operator });
    out.recalculated_docs.push(rec.docNo);
    const codes = new Set(rec.changes.map(c => c.code));
    (r.after || []).forEach(b => {
      if (codes.has(b.code)) out.balance_after.push({ doc_no: rec.docNo, code: b.code, qty: b.qty, amount: b.amount });
    });
  }

  const changedInboundIds = [...priceByInbound.keys()];
  if (changedInboundIds.length) {
    const rph = changedInboundIds.map(() => '?').join(',');
    const returnLines = db.prepare(`SELECT i.id, i.doc_no, i.code, i.price, i.origin_line_id, d.status
      FROM inbound i JOIN inbound_docs d ON d.doc_no = i.doc_no
      WHERE i.origin_line_id IN (${rph}) AND d.status IN ('draft','posted')`).all(...changedInboundIds);
    const retDocMap = new Map();
    const updRet = db.prepare('UPDATE inbound SET price=? WHERE id=?');
    for (const l of returnLines) {
      const newPrice = priceByInbound.get(Number(l.origin_line_id));
      if (newPrice === undefined) continue;
      const oldPrice = Number(l.price) || 0;
      if (!priceChanged(oldPrice, newPrice)) continue;
      updRet.run(newPrice, l.id);
      let rec = retDocMap.get(l.doc_no);
      if (!rec) { rec = { docNo: l.doc_no, status: l.status, changes: [] }; retDocMap.set(l.doc_no, rec); }
      rec.changes.push({ lineId: Number(l.id), code: l.code, oldPrice, newPrice });
      out.return_changes.push({
        doc_no: l.doc_no, line_id: Number(l.id), code: l.code,
        old_price: oldPrice, new_price: newPrice, status: l.status,
      });
    }
    for (const rec of retDocMap.values()) {
      out.synced_returns.push(rec.docNo);
      if (rec.status !== 'posted') continue;
      const r = costing.updateInboundPrices(rec.docNo, rec.changes, { triggerDoc: poNo, operator });
      out.recalculated_returns.push(rec.docNo);
      const codes = new Set(rec.changes.map(c => c.code));
      (r.after || []).forEach(b => {
        if (codes.has(b.code)) out.balance_after.push({ doc_no: rec.docNo, code: b.code, qty: b.qty, amount: b.amount });
      });
    }
  }
  return out;
}

// 补价与重算审计：价格键由 maskRowDetail 按权限脱敏
function recordPriceSyncAudit(req, poNo, result, changes) {
  if (!changes || !changes.length) return;
  const u = req.user || {};
  audit.record({
    user_id: u.id || null,
    username: u.username || '',
    name: u.name || '',
    role: u.role || '',
    module: 'purchase',
    action: 'price-recalc',
    target: poNo,
    method: req.method,
    path: req.originalUrl.split('?')[0],
    ip: clientIp(req),
    status: 200,
    detail: JSON.stringify({
      source: 'purchase',
      po_no: poNo,
      price_changes: changes.map(c => ({ line_id: c.id, code: c.code, field: '单价', old_price: c.oldPrice, new_price: c.newPrice })),
      inbound_changes: result.inbound_changes,
      return_changes: result.return_changes,
      synced_docs: result.synced_docs,
      recalculated_docs: result.recalculated_docs,
      synced_returns: result.synced_returns,
      recalculated_returns: result.recalculated_returns,
      balance_after: result.balance_after,
    }),
  });
  req.skipGenericAudit = true;
}

function priceSyncSummary(result) {
  return {
    synced_docs: result.synced_docs,
    recalculated_docs: result.recalculated_docs,
    synced_returns: result.synced_returns,
    recalculated_returns: result.recalculated_returns,
  };
}

router.post('/api/purchase/lines', requirePriceEdit, (req, res) => {
  const l = req.body || {};
  if (!l.po_no) return res.status(400).json({ error: '缺少采购单号' });
  const po = requireOrderEdit(req, res, l.po_no);
  if (!po) return;
  const before = po.status === 'posted' ? orderSnapshot(l.po_no) : null;
  try {
    const tx = db.transaction(() => { insertLines(tx, l.po_no, [l]); });
    tx();
    if (before) recordModifyAudit(req, l.po_no, diffOrder(before, orderSnapshot(l.po_no)));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/purchase/lines/:id', requirePriceEdit, (req, res) => {
  const l = req.body || {};
  try {
    const exist = db.prepare("SELECT * FROM order_lines WHERE id = ?").get(req.params.id);
    if (!exist) return res.status(404).json({ error: '采购明细不存在' });
    const targetPo = l.po_no || exist.po_no;
    const po = requireOrderEdit(req, res, targetPo);
    if (!po) return;
    // 不允许借「改 po_no」把明细从一张无权编辑的单据挪走
    if (String(targetPo) !== String(exist.po_no) && !requireOrderEdit(req, res, exist.po_no)) return;
    const qty = l.order_qty !== undefined ? Number(l.order_qty) : Number(exist.order_qty || 0);
    const received = receivedQtyOfLine(exist.id);
    if (received > 0 && qty + 1e-6 < received) {
      return res.status(400).json({
        error: `物料 ${exist.code} 的订购数量不能小于已到货数量 ${received}`,
        code: 'PO_QTY_BELOW_RECEIVED',
        details: [{ line_id: Number(exist.id), code: exist.code, order_qty: qty, received_qty: received }],
      });
    }
    const before = po.status === 'posted' ? orderSnapshot(targetPo) : null;
    const operator = (req.user && req.user.username) || '';
    let priceChanges = [];
    let priceSync = null;
    const tx = db.transaction(() => {
      db.prepare(`UPDATE order_lines SET po_no=@po_no,code=@code,order_qty=@order_qty,
        order_price=@order_price,remarks=@remarks,contract_no=@contract_no WHERE id=@id`)
        .run({
          id: req.params.id,
          po_no: targetPo, code: l.code || exist.code,
          order_qty: qty,
          order_price: l.order_price !== undefined ? Number(l.order_price) : exist.order_price,
          remarks: l.remarks !== undefined ? l.remarks : exist.remarks,
          contract_no: l.contract_no !== undefined ? l.contract_no : exist.contract_no,
        });
      ensureContract(l.contract_no !== undefined ? l.contract_no : exist.contract_no, '');
      cascadePoRefs(targetPo);
      if (po.status === 'posted') {
        const newPrice = l.order_price !== undefined ? Number(l.order_price) : Number(exist.order_price || 0);
        const oldPrice = Number(exist.order_price || 0);
        if (priceChanged(oldPrice, newPrice)) {
          priceChanges = [{ id: Number(exist.id), code: l.code || exist.code, oldPrice, newPrice }];
          priceSync = syncPoPriceChanges(targetPo, priceChanges, operator);
        }
      }
    });
    tx();
    if (before) recordModifyAudit(req, targetPo, diffOrder(before, orderSnapshot(targetPo)));
    if (priceChanges.length) recordPriceSyncAudit(req, targetPo, priceSync, priceChanges);
    res.json({ success: true, price_sync: priceSync ? priceSyncSummary(priceSync) : null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/purchase/lines/:id', requirePriceEdit, (req, res) => {
  try {
    const line = db.prepare(`${LINE_SEL} WHERE ol.id = ?`).get(req.params.id);
    if (!line) return res.status(404).json({ error: '采购明细不存在' });
    const po = requireOrderEdit(req, res, line.po_no);
    if (!po) return;
    const received = Number(line.received_qty || 0);
    if (received > 0) {
      return res.status(400).json({ error: `该明细已有到货记录（${received}），不能删除；如需撤销请先更正关联入库单` });
    }
    if (po.status === 'posted') {
      const cnt = db.prepare('SELECT COUNT(*) AS c FROM order_lines WHERE po_no = ?').get(line.po_no).c;
      if (cnt <= 1) {
        return res.status(400).json({ error: '已确认的采购单至少要保留一行有效明细', code: 'PO_LAST_LINE' });
      }
    }
    const before = po.status === 'posted' ? orderSnapshot(line.po_no) : null;
    db.prepare("DELETE FROM order_lines WHERE id = ?").run(req.params.id);
    if (before) recordModifyAudit(req, line.po_no, diffOrder(before, orderSnapshot(line.po_no)));
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
    const k = kwClause(['ol.code', 'ol.po_no', 'ol.contract_no', 'po.contract_no', 'm.name', 'm.spec', 'm.brand', 'po.supplier'], keyword);
    if (k.sql) { sql += ' AND ' + k.sql; params.push(...k.params); }
  }
  sql += " ORDER BY ol.po_no DESC, ol.id";
  let rows = db.prepare(sql).all(...params).map(enrichLine);
  if (deliveryStatus) rows = rows.filter(r => r.line_status === deliveryStatus);
  res.json(maskRows(req, rows, ['order_price', 'order_amount']));
});

// 单个采购明细的到货履历（下钻：这张明细被哪些入库单核销了多少）
router.get('/api/purchase/lines/:id/inbound', requirePerm('purchase', 'view'), (req, res) => {
  const line = db.prepare(`${LINE_SEL} WHERE ol.id = ?`).get(req.params.id);
  if (!line) return res.status(404).json({ error: '采购明细不存在' });
  const e = enrichLine(line);
  const rows = db.prepare(`
    SELECT i.id, i.date, i.qty, i.price, i.amount, i.grn_no, i.doc_no, i.txn_type,
           i.supplier, i.handler, i.remarks, i.order_line_id, d.status AS doc_status,
           d.created_at AS doc_created_at, d.confirmed_at AS doc_confirmed_at
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
  // 无价格权限：行单价/金额与履历单价/金额不下发（累计到货数量保留）
  if (!req.canViewPrice) {
    delete e.order_price;
    delete e.order_amount;
    history.forEach(r => { delete r.price; delete r.amount; });
  }
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
// excludeInboundDoc：更正预填时临时排除原单已过账数量（不计入其他退货占用）
router.get('/api/purchase/lines/by-po/:poNo', requirePerm('purchase', 'view'), (req, res) => {
  try {
    res.json(maskRows(req, getOrderLinesForInbound(req.params.poNo, { excludeDocNo: req.query.excludeInboundDoc || '' }), ['order_price', 'order_amount']));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/api/purchase/lines/by-contract/:contractNo', requirePerm('purchase', 'view'), (req, res) => {
  try {
    res.json(maskRows(req, getOrderLinesByContract(req.params.contractNo, { excludeDocNo: req.query.excludeInboundDoc || '' }), ['order_price', 'order_amount']));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ==================== 采购入库单头来源（2026-11 第八批） ====================
// 采购单/合同混排，只返回「还有未到货明细行」的来源；已全部到货的不出现。
// refs：采购单来源带出涉及的合同，合同来源带出覆盖的采购单，供前端只读派生展示。
router.get('/api/purchase/inbound-sources', requirePerm('purchase', 'view'), (req, res) => {
  const orders = db.prepare("SELECT po_no, date, supplier, manual_status FROM purchase_orders ORDER BY date DESC").all();
  const contracts = db.prepare("SELECT contract_no, supplier, status FROM contracts ORDER BY contract_no").all();
  const allLines = db.prepare(`${LINE_SEL}`).all().map(enrichLine);
  const byPo = new Map();
  const byContract = new Map();
  allLines.forEach(l => {
    if (!byPo.has(l.po_no)) byPo.set(l.po_no, []);
    byPo.get(l.po_no).push(l);
    const ct = String(l.contract_no_eff || '').trim();
    if (!ct) return;
    if (!byContract.has(ct)) byContract.set(ct, []);
    byContract.get(ct).push(l);
  });
  const out = [];
  orders.forEach(o => {
    if (o.manual_status === '已取消' || o.manual_status === '已关闭') return;
    const lines = (byPo.get(o.po_no) || []).filter(l => Number(l.unreceived_qty) > 0);
    if (!lines.length) return;
    out.push({
      kind: 'po', no: o.po_no, supplier: o.supplier || '', date: o.date || '',
      pending_lines: lines.length,
      refs: [...new Set(lines.map(l => String(l.contract_no_eff || '').trim()).filter(Boolean))].sort(),
    });
  });
  contracts.forEach(c => {
    const lines = (byContract.get(c.contract_no) || []).filter(l => Number(l.unreceived_qty) > 0);
    if (!lines.length) return;
    out.push({
      kind: 'contract', no: c.contract_no, supplier: c.supplier || '', date: '',
      pending_lines: lines.length,
      refs: [...new Set(lines.map(l => l.po_no).filter(Boolean))].sort(),
    });
  });
  res.json(out);
});

// 指定采购单/合同下的全部采购行（含已到齐），用于入库页的物料范围与未到货展示
router.get('/api/purchase/inbound-scope-lines', requirePerm('purchase', 'view'), (req, res) => {
  const poNo = String(req.query.poNo || '').trim();
  const contractNo = String(req.query.contractNo || '').trim();
  const excludeDocNo = String(req.query.excludeDocNo || '').trim();
  if (!poNo && !contractNo) return res.json([]);
  res.json(maskRows(req, getPurchaseScopeLines(poNo ? { poNo } : { contractNo }, { excludeDocNo }), ['order_price', 'order_amount']));
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
    const k = kwClause(['contract_no', 'name', 'supplier', 'remarks'], keyword);
    if (k.sql) { sql += ' AND ' + k.sql; params.push(...k.params); }
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

  const contracts = list.map(c => {
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
  });
  // 无价格权限：合同金额、订单/到货金额与到货率（金额占比）整组不下发
  res.json(maskRows(req, contracts, ['amount', 'order_amount', 'received_amount', 'receive_rate']));
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
      WHERE i.doc_no <> '' AND i.status = 'posted'
        AND (TRIM(COALESCE(i.contract_no,'')) = ?
          OR i.order_line_id IN (
            SELECT ol.id FROM order_lines ol
            JOIN purchase_orders po ON po.po_no = ol.po_no
            WHERE ${EFF_CONTRACT} = ?))
    )
    ORDER BY d.date DESC, d.created_at DESC`).all(no, no);

  const relatedDocs = relatedInboundDocs({ contractNo: no });
  const summary = {
    po_count: poNos.length,
    line_count: lines.length,
    order_qty: r2(orderQty),
    order_amount: r2(orderAmount),
    received_qty: r2(receivedQty),
    unreceived_qty: r2(orderQty - receivedQty),
    received_amount: r2(receivedAmount),
    receive_rate: orderAmount > 0 ? Math.round(receivedAmount / orderAmount * 1000) / 10 : 0,
  };

  // 无价格权限：合同金额、行单价/金额、入库单金额、汇总金额与到货率整组不下发
  if (!req.canViewPrice) {
    delete contract.amount;
    lines.forEach(l => { delete l.order_price; delete l.order_amount; });
    inboundDocs.forEach(d => { delete d.total_amount; });
    relatedDocs.forEach(d => { delete d.total_amount; });
    delete summary.order_amount;
    delete summary.received_amount;
    delete summary.receive_rate;
  }
  res.json({
    ...contract,
    orders,
    lines,
    inbound_docs: inboundDocs,
    related_inbound_docs: relatedDocs.filter(r => r.txn_type !== '采购退货'),
    related_return_docs: relatedDocs.filter(r => r.txn_type === '采购退货'),
    logs: fetchLogs('purchase', no, 200, !!req.canViewPrice),
    summary,
  });
});

router.post('/api/purchase/contracts', requirePerm('purchase', 'manage'), requirePriceEdit, (req, res) => {
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

router.put('/api/purchase/contracts/:contractNo', requirePerm('purchase', 'manage'), requirePriceEdit, (req, res) => {
  const no = req.params.contractNo;
  const b = req.body || {};
  try {
    const exist = db.prepare("SELECT contract_no, amount FROM contracts WHERE contract_no = ?").get(no);
    if (!exist) return res.status(404).json({ error: '合同不存在' });
    // 无 price:edit 的前端不渲染金额输入框，也不会回传 amount：沿用原值，避免被写成 0
    const amount = !req.canEditPrice && b.amount === undefined ? exist.amount : Number(b.amount || 0);
    db.prepare(`UPDATE contracts SET name=@name,supplier=@supplier,sign_date=@sign_date,
      amount=@amount,status=@status,remarks=@remarks WHERE contract_no=@contract_no`)
      .run({
        contract_no: no, name: b.name || '', supplier: b.supplier || '',
        sign_date: b.sign_date || '', amount,
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
