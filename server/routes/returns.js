/**
 * 退货与退库聚合查询
 *
 * 只做「读」的聚合：把 inbound_docs 里的「采购退货」与 outbound_docs 里的
 * 「退库出库」归一成统一字段，供前端新模块使用。
 * 写入仍走原有 /api/inbound-docs 与 /api/outbound-docs，避免复制业务逻辑。
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');

const router = express.Router();

const SUB_PURCHASE = '采购退货';
const SUB_STOCK = '领用退库';
const TXN_STOCK = '退库出库';

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
       COALESCE(NULLIF(d.po_no, ''), NULLIF(d.contract_no, ''), '') AS ref_no,
       d.status AS status,
       COALESCE(d.handler, '') AS handler,
       COALESCE(d.remarks, '') AS remarks,
       d.created_at AS created_at,
       (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no) AS line_count,
       (SELECT COALESCE(SUM(ABS(i.qty)), 0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_qty,
       (SELECT COALESCE(SUM(i.amount), 0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_amount,
       (SELECT COALESCE(SUM(ABS(r.qty)), 0)
          FROM inbound r
          JOIN inbound_docs rd ON rd.doc_no = r.doc_no
          JOIN inbound i ON CAST(i.id AS TEXT) = r.reversal_of
         WHERE i.doc_no = d.doc_no AND rd.status = 'posted') AS reversed_qty
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
       d.status AS status,
       COALESCE(d.handler, '') AS handler,
       COALESCE(d.remarks, '') AS remarks,
       d.created_at AS created_at,
       (SELECT COUNT(*) FROM outbound o WHERE o.doc_no = d.doc_no) AS line_count,
       (SELECT COALESCE(SUM(ABS(o.qty)), 0) FROM outbound o WHERE o.doc_no = d.doc_no) AS total_qty,
       (SELECT COALESCE(SUM(o.cost_amount), 0) FROM outbound o WHERE o.doc_no = d.doc_no) AS total_amount,
       (SELECT COALESCE(SUM(ABS(r.qty)), 0)
          FROM outbound r
          JOIN outbound_docs rd ON rd.doc_no = r.doc_no
          JOIN outbound o ON CAST(o.id AS TEXT) = r.reversal_of
         WHERE o.doc_no = d.doc_no AND rd.status = 'posted') AS reversed_qty
  FROM outbound_docs d
 WHERE d.txn_type = '${TXN_STOCK}'`;

function withDerived(row) {
  const total = Number(row.total_qty || 0);
  const reversed = Number(row.reversed_qty || 0);
  const remaining = Math.max(0, total - reversed);
  return {
    ...row,
    total_qty: total,
    total_amount: Number(row.total_amount || 0),
    reversed_qty: reversed,
    remaining_qty: remaining,
    has_reversal: reversed > 0,
    can_reverse: row.status === 'posted' && remaining > 0,
    can_confirm: row.status === 'draft',
    can_edit: row.status === 'draft',
  };
}

// 聚合列表：支持 type / status / keyword / 日期区间 / 分页
router.get('/api/returns/docs', requirePerm('returns', 'view'), (req, res) => {
  const subType = resolveSubType(req.query.type);
  if (subType === null) {
    return res.status(400).json({ error: '无效的退货类型', code: 'INVALID_RETURN_TYPE' });
  }
  const { status, keyword, dateFrom, dateTo } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));

  const where = [];
  const params = [];
  if (subType) { where.push('t.sub_type = ?'); params.push(subType); }
  if (status) { where.push('t.status = ?'); params.push(status); }
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

  res.json({
    items: rows.map(withDerived),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

// 单据详情：统一返回头信息、明细行、操作日志、冲销记录与剩余可冲量
router.get('/api/returns/docs/:docNo', requirePerm('returns', 'view'), (req, res) => {
  const docNo = req.params.docNo;

  const ib = db.prepare("SELECT * FROM inbound_docs WHERE doc_no = ? AND txn_type = ?").get(docNo, SUB_PURCHASE);
  if (ib) return sendInboundDetail(res, ib);

  const ob = db.prepare("SELECT * FROM outbound_docs WHERE doc_no = ? AND txn_type = ?").get(docNo, TXN_STOCK);
  if (ob) return sendOutboundDetail(res, ob);

  return res.status(404).json({ error: '退货/退库单据不存在', code: 'RETURN_DOC_NOT_FOUND' });
});

function sendInboundDetail(res, doc) {
  const lines = db.prepare(`SELECT i.*, m.name AS material_name, m.spec AS material_spec,
      m.unit AS material_unit, m.brand AS material_brand
    FROM inbound i LEFT JOIN materials m ON i.code = m.code
    WHERE i.doc_no = ? ORDER BY i.id ASC`).all(doc.doc_no);
  const logs = db.prepare('SELECT * FROM inbound_doc_logs WHERE doc_no = ? ORDER BY id ASC').all(doc.doc_no);
  const reversals = db.prepare(`SELECT doc_no, date, status FROM inbound_docs
    WHERE reversal_of = ? ORDER BY created_at DESC`).all(doc.doc_no);

  // 已冲销量按“已过账的冲销单明细”实时汇总，与冲销页的算法保持一致
  const reversedMap = {};
  db.prepare(`SELECT r.reversal_of AS line_id, SUM(ABS(r.qty)) AS v
    FROM inbound r JOIN inbound_docs rd ON rd.doc_no = r.doc_no
    WHERE rd.reversal_of = ? AND rd.status = 'posted'
    GROUP BY r.reversal_of`).all(doc.doc_no).forEach(r => { reversedMap[String(r.line_id)] = Number(r.v || 0); });
  lines.forEach(l => { l.reversed_qty = reversedMap[String(l.id)] || 0; });

  const summary = {
    line_count: lines.length,
    total_qty: lines.reduce((s, l) => s + Math.abs(Number(l.qty || 0)), 0),
    total_amount: lines.reduce((s, l) => s + Number(l.amount || 0), 0),
    reversed_qty: lines.reduce((s, l) => s + Number(l.reversed_qty || 0), 0),
  };
  summary.remaining_qty = Math.max(0, summary.total_qty - summary.reversed_qty);

  res.json({
    ...doc,
    sub_type: SUB_PURCHASE,
    ledger: 'inbound',
    direction: 'out',
    party: doc.supplier || '',
    ref_no: doc.po_no || doc.contract_no || '',
    lines,
    logs,
    reversals,
    summary,
    can_reverse: doc.status === 'posted' && summary.remaining_qty > 0,
    can_confirm: doc.status === 'draft',
    can_edit: doc.status === 'draft',
  });
}

function sendOutboundDetail(res, doc) {
  const lines = db.prepare(`SELECT o.*, m.name AS material_name, m.spec AS material_spec,
      m.unit AS material_unit, m.brand AS material_brand
    FROM outbound o LEFT JOIN materials m ON o.code = m.code
    WHERE o.doc_no = ? ORDER BY o.id ASC`).all(doc.doc_no);
  const logs = db.prepare('SELECT * FROM outbound_doc_logs WHERE doc_no = ? ORDER BY id ASC').all(doc.doc_no);
  const reversals = db.prepare(`SELECT doc_no, date, status FROM outbound_docs
    WHERE reversal_of = ? ORDER BY created_at DESC`).all(doc.doc_no);

  const reversedMap = {};
  db.prepare(`SELECT r.reversal_of AS line_id, SUM(ABS(r.qty)) AS v
    FROM outbound r JOIN outbound_docs rd ON rd.doc_no = r.doc_no
    WHERE rd.reversal_of = ? AND rd.status = 'posted'
    GROUP BY r.reversal_of`).all(doc.doc_no).forEach(r => { reversedMap[String(r.line_id)] = Number(r.v || 0); });
  lines.forEach(l => { l.reversed_qty = reversedMap[String(l.id)] || 0; });

  const summary = {
    line_count: lines.length,
    total_qty: lines.reduce((s, l) => s + Math.abs(Number(l.qty || 0)), 0),
    total_amount: lines.reduce((s, l) => s + Number(l.cost_amount || 0), 0),
    reversed_qty: lines.reduce((s, l) => s + Number(l.reversed_qty || 0), 0),
  };
  summary.remaining_qty = Math.max(0, summary.total_qty - summary.reversed_qty);

  res.json({
    ...doc,
    sub_type: SUB_STOCK,
    ledger: 'outbound',
    direction: 'in',
    party: doc.destination || '',
    ref_no: doc.origin_doc_no || '',
    lines,
    logs,
    reversals,
    summary,
    can_reverse: doc.status === 'posted' && summary.remaining_qty > 0,
    can_confirm: doc.status === 'draft',
    can_edit: doc.status === 'draft',
  });
}

module.exports = router;
