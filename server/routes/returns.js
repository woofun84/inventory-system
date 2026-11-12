/**
 * 退货与退库聚合查询
 *
 * 只做「读」的聚合：把 inbound_docs 里的「采购退货」与 outbound_docs 里的
 * 「领料退库」归一成统一字段，供前端退货模块使用。
 * 写入（创建/确认/更正）仍走 /api/inbound-docs 与 /api/outbound-docs，避免复制业务逻辑。
 *
 * 两种单据都走「作废重开」更正：作废单默认不进列表，includeHistory=1 或关键字搜索时可见。
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const {
  getPurchaseReturnOriginOptions,
  getPurchaseReturnOriginLines,
  getPurchaseReturnScopeOptions,
  getPurchaseReturnScopeLines,
} = require('../services/stock');
const { maskRows } = require('../services/price-mask');

const router = express.Router();

const SUB_PURCHASE = '采购退货';
const SUB_STOCK = '领料退库';
const TXN_STOCK = '领料退库';

// 前端/接口传参归一：支持子类型中文名、英文简写
function resolveSubType(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (v === SUB_PURCHASE || v === 'purchase') return SUB_PURCHASE;
  if (v === SUB_STOCK || v === TXN_STOCK || v === 'stock') return SUB_STOCK;
  return null;
}

// 两个账本归一后的基础集合
const BASE_SQL = `
SELECT d.doc_no AS doc_no,
       d.date AS date,
       '${SUB_PURCHASE}' AS sub_type,
       'inbound' AS ledger,
       'out' AS direction,
       COALESCE(d.supplier, '') AS party,
       COALESCE(NULLIF(d.origin_doc_no, ''), NULLIF(d.return_ref_no, ''), NULLIF(d.po_no, ''), NULLIF(d.contract_no, ''), '') AS ref_no,
       COALESCE(d.return_tier, '') AS return_tier,
       COALESCE(d.origin_doc_no, '') AS origin_doc_no,
       COALESCE(d.return_ref_no, '') AS return_ref_no,
       COALESCE(d.return_reason, '') AS return_reason,
       (CASE WHEN d.return_tier = 'none' THEN 1 ELSE 0 END) AS no_origin_flag,
       d.status AS status,
       COALESCE(d.corrected_by_doc_no, '') AS corrected_by_doc_no,
       COALESCE(d.voided_at, '') AS voided_at,
       COALESCE(d.voided_by, '') AS voided_by,
       COALESCE(d.handler, '') AS handler,
       COALESCE(d.remarks, '') AS remarks,
       d.created_at AS created_at,
       (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no) AS line_count,
       (SELECT COALESCE(SUM(ABS(i.qty)), 0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_qty,
       (SELECT COALESCE(SUM(i.amount), 0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_amount
  FROM inbound_docs d
 WHERE d.txn_type = '${SUB_PURCHASE}'
UNION ALL
SELECT d.doc_no AS doc_no,
       d.date AS date,
       '${SUB_STOCK}' AS sub_type,
       'outbound' AS ledger,
       'in' AS direction,
       COALESCE(d.destination, '') AS party,
       COALESCE(d.origin_doc_no, '') AS ref_no,
       '' AS return_tier,
       COALESCE(d.origin_doc_no, '') AS origin_doc_no,
       '' AS return_ref_no,
       COALESCE(d.return_reason, '') AS return_reason,
       (CASE WHEN TRIM(COALESCE(d.origin_doc_no, '')) = '' THEN 1 ELSE 0 END) AS no_origin_flag,
       d.status AS status,
       COALESCE(d.corrected_by_doc_no, '') AS corrected_by_doc_no,
       COALESCE(d.voided_at, '') AS voided_at,
       COALESCE(d.voided_by, '') AS voided_by,
       COALESCE(d.handler, '') AS handler,
       COALESCE(d.remarks, '') AS remarks,
       d.created_at AS created_at,
       (SELECT COUNT(*) FROM outbound o WHERE o.doc_no = d.doc_no) AS line_count,
       (SELECT COALESCE(SUM(ABS(o.qty)), 0) FROM outbound o WHERE o.doc_no = d.doc_no) AS total_qty,
       (SELECT COALESCE(SUM(o.cost_amount), 0) FROM outbound o WHERE o.doc_no = d.doc_no) AS total_amount
  FROM outbound_docs d
 WHERE d.txn_type = '${TXN_STOCK}'`;

function withDerived(req, row) {
  const total = Number(row.total_qty || 0);
  const status = String(row.status || '');
  const out = {
    ...row,
    return_tier: String(row.return_tier || ''),
    no_origin: Number(row.no_origin_flag || 0) === 1,
    total_qty: total,
    total_amount: Number(row.total_amount || 0),
    is_voided: status === 'voided',
    can_correct: status === 'posted' && !String(row.corrected_by_doc_no || '').trim(),
    can_confirm: status === 'draft',
    can_edit: status === 'draft',
  };
  if (!req.canViewPrice) delete out.total_amount;
  return out;
}

// 聚合列表：支持 type / status / keyword / 日期区间 / 分页
router.get('/api/returns/docs', requirePerm('returns', 'view'), (req, res) => {
  const subType = resolveSubType(req.query.type);
  if (subType === null) {
    return res.status(400).json({ error: '无效的退货类型', code: 'INVALID_RETURN_TYPE' });
  }
  const { status, keyword, dateFrom, dateTo, includeHistory, noOrigin } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));

  const where = [];
  const params = [];
  if (subType) { where.push('t.sub_type = ?'); params.push(subType); }
  if (status) { where.push('t.status = ?'); params.push(status); }
  else if (!keyword && !includeHistory) { where.push("t.status <> 'voided'"); }
  if (String(noOrigin || '') === '1') { where.push('t.no_origin_flag = 1'); }
  if (dateFrom) { where.push('t.date >= ?'); params.push(dateFrom); }
  if (dateTo) { where.push('t.date < ?'); params.push(dateTo + ' 23:59:59'); }
  if (keyword) {
    where.push('(t.doc_no LIKE ? OR t.party LIKE ? OR t.ref_no LIKE ? OR t.handler LIKE ? OR t.remarks LIKE ?)');
    const kw = '%' + keyword + '%';
    params.push(kw, kw, kw, kw, kw);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${BASE_SQL}) t ${whereSql}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM (${BASE_SQL}) t ${whereSql}
    ORDER BY t.date DESC, t.created_at DESC
    LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);

  // withDerived 内部已按 req.canViewPrice 删除 total_amount，这里只负责把 req 传进去
  res.json({
    items: rows.map(r => withDerived(req, r)),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

// 单据详情：统一返回头信息、明细行、操作日志与更正资格
router.get('/api/returns/docs/:docNo', requirePerm('returns', 'view'), (req, res) => {
  const docNo = req.params.docNo;

  const ib = db.prepare("SELECT * FROM inbound_docs WHERE doc_no = ? AND txn_type = ?").get(docNo, SUB_PURCHASE);
  if (ib) return sendInboundDetail(req, res, ib);

  const ob = db.prepare("SELECT * FROM outbound_docs WHERE doc_no = ? AND txn_type = ?").get(docNo, TXN_STOCK);
  if (ob) return sendOutboundDetail(req, res, ob);

  return res.status(404).json({ error: '退货/退库单据不存在', code: 'RETURN_DOC_NOT_FOUND' });
});

function sendInboundDetail(req, res, doc) {
  const lines = db.prepare(`SELECT i.*, m.name AS material_name, m.spec AS material_spec,
      m.unit AS material_unit, m.brand AS material_brand
    FROM inbound i LEFT JOIN materials m ON i.code = m.code
    WHERE i.doc_no = ? ORDER BY i.id ASC`).all(doc.doc_no);
  const logs = db.prepare('SELECT * FROM inbound_doc_logs WHERE doc_no = ? ORDER BY id ASC').all(doc.doc_no);

  // 关联档明细附上来源入库单号，便于追溯成本
  const originIds = [...new Set(lines.map(l => Number(l.origin_line_id) || 0).filter(Boolean))];
  if (originIds.length) {
    const srcRows = db.prepare(`SELECT id, doc_no FROM inbound
      WHERE id IN (${originIds.map(() => '?').join(',')})`).all(...originIds);
    const srcMap = Object.fromEntries(srcRows.map(r => [String(r.id), r.doc_no]));
    lines.forEach(l => { l.source_doc_no = srcMap[String(l.origin_line_id)] || ''; });
  }

  const tierInfo = {
    return_tier: doc.return_tier || '',
    origin_doc_no: doc.origin_doc_no || '',
    return_ref_no: doc.return_ref_no || '',
    return_reason: doc.return_reason || '',
  };
  const summary = {
    line_count: lines.length,
    total_qty: lines.reduce((s, l) => s + Math.abs(Number(l.qty || 0)), 0),
    total_amount: lines.reduce((s, l) => s + Number(l.amount || 0), 0),
  };
  const status = String(doc.status || '');

  // 原入库单（反向关联）：补数量合计/金额合计，与正向关联列表字段一致
  const originDoc = tierInfo.origin_doc_no
    ? db.prepare(`SELECT d.doc_no, d.date, d.txn_type, d.status,
        (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no) AS line_count,
        (SELECT COALESCE(SUM(i.qty),0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_qty,
        (SELECT COALESCE(SUM(i.amount),0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_amount
      FROM inbound_docs d WHERE d.doc_no = ?`).get(tierInfo.origin_doc_no) || null
    : null;

  // 无价格权限：明细单价/金额、合计金额、原单金额整组不下发（数量类保留）
  if (!req.canViewPrice) {
    lines.forEach(l => { delete l.price; delete l.amount; });
    delete summary.total_amount;
    if (originDoc) delete originDoc.total_amount;
  }
  res.json({
    ...doc,
    ...tierInfo,
    no_origin: tierInfo.return_tier === 'none',
    sub_type: SUB_PURCHASE,
    ledger: 'inbound',
    direction: 'out',
    party: doc.supplier || '',
    ref_no: tierInfo.origin_doc_no || tierInfo.return_ref_no || doc.po_no || doc.contract_no || '',
    is_voided: status === 'voided',
    can_correct: status === 'posted' && !String(doc.corrected_by_doc_no || '').trim(),
    can_confirm: status === 'draft',
    can_edit: status === 'draft',
    origin_doc: originDoc,
    lines,
    logs,
    summary,
  });
}

function sendOutboundDetail(req, res, doc) {
  const lines = db.prepare(`SELECT o.*, m.name AS material_name, m.spec AS material_spec,
      m.unit AS material_unit, m.brand AS material_brand
    FROM outbound o LEFT JOIN materials m ON o.code = m.code
    WHERE o.doc_no = ? ORDER BY o.id ASC`).all(doc.doc_no);
  const logs = db.prepare('SELECT * FROM outbound_doc_logs WHERE doc_no = ? ORDER BY id ASC').all(doc.doc_no);

  const summary = {
    line_count: lines.length,
    total_qty: lines.reduce((s, l) => s + Math.abs(Number(l.qty || 0)), 0),
    total_amount: lines.reduce((s, l) => s + Number(l.cost_amount || 0), 0),
  };
  const status = String(doc.status || '');
  // 原出库单（反向关联）：补数量合计/金额合计，与正向关联列表字段一致
  const originDoc = doc.origin_doc_no
    ? db.prepare(`SELECT d.doc_no, d.date, d.txn_type, d.status,
        (SELECT COUNT(*) FROM outbound o WHERE o.doc_no = d.doc_no) AS line_count,
        (SELECT COALESCE(SUM(o.qty),0) FROM outbound o WHERE o.doc_no = d.doc_no) AS total_qty,
        (SELECT COALESCE(SUM(o.cost_amount),0) FROM outbound o WHERE o.doc_no = d.doc_no) AS total_amount
      FROM outbound_docs d WHERE d.doc_no = ?`).get(doc.origin_doc_no) || null
    : null;

  // 无价格权限：明细成本单价/金额、合计金额、原单金额整组不下发（数量类保留）
  if (!req.canViewPrice) {
    lines.forEach(l => { delete l.cost_price; delete l.cost_amount; });
    delete summary.total_amount;
    if (originDoc) delete originDoc.total_amount;
  }
  res.json({
    ...doc,
    sub_type: SUB_STOCK,
    ledger: 'outbound',
    direction: 'in',
    party: doc.destination || '',
    ref_no: doc.origin_doc_no || '',
    no_origin: !String(doc.origin_doc_no || '').trim(),
    is_voided: status === 'voided',
    can_correct: status === 'posted' && !String(doc.corrected_by_doc_no || '').trim(),
    can_confirm: status === 'draft',
    can_edit: status === 'draft',
    origin_doc: originDoc,
    lines,
    logs,
    summary,
  });
}

// ==================== 采购退货三档只读接口（2026-11 第五批） ====================
// 档 1：可选原入库单 + 其可退明细
router.get('/api/returns/purchase/origins', requirePerm('returns', 'view'), (req, res) => {
  res.json(getPurchaseReturnOriginOptions());
});

router.get('/api/returns/purchase/origin-lines', requirePerm('returns', 'view'), (req, res) => {
  const docNo = String(req.query.docNo || '').trim();
  if (!docNo) return res.status(400).json({ error: '缺少原入库单号', code: 'ORIGIN_DOC_REQUIRED' });
  try {
    res.json(maskRows(req, getPurchaseReturnOriginLines(docNo, String(req.query.excludeDocNo || '').trim()), ['price']));
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code || 'RETURN_SOURCE_FAILED' });
  }
});

// 档 2：采购单/合同下拉候选 + 范围内跨多张入库单的可退明细
router.get('/api/returns/purchase/scope-options', requirePerm('returns', 'view'), (req, res) => {
  res.json(getPurchaseReturnScopeOptions());
});

router.get('/api/returns/purchase/scope-lines', requirePerm('returns', 'view'), (req, res) => {
  const scope = String(req.query.scope || 'po');
  const refNo = String(req.query.refNo || '').trim();
  if (!['po', 'contract'].includes(scope)) {
    return res.status(400).json({ error: '关联范围必须是采购单或合同', code: 'INVALID_RETURN_SCOPE' });
  }
  if (!refNo) return res.status(400).json({ error: '缺少采购单号或合同号', code: 'RETURN_REF_REQUIRED' });
  try {
    res.json(maskRows(req, getPurchaseReturnScopeLines(scope, refNo, String(req.query.excludeDocNo || '').trim()), ['price']));
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code || 'RETURN_SOURCE_FAILED' });
  }
});

module.exports = router;
