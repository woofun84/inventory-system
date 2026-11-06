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
const {
  getPurchaseReturnOriginOptions,
  getPurchaseReturnOriginLines,
  getPurchaseReturnScopeOptions,
  getPurchaseReturnScopeLines,
} = require('../services/stock');

const router = express.Router();

const SUB_PURCHASE = '采购退货';
const SUB_STOCK = '领用退库';
const SUB_REVERSAL = '退货冲销';
const TXN_STOCK = '退库出库';
const TXN_INBOUND_REV = '入库冲销';
const TXN_OUTBOUND_REV = '出库冲销';

// 前端/接口传参归一：支持子类型中文名、英文简写
function resolveSubType(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (v === SUB_PURCHASE || v === 'purchase') return SUB_PURCHASE;
  if (v === SUB_STOCK || v === TXN_STOCK || v === 'stock') return SUB_STOCK;
  if (v === SUB_REVERSAL || v === 'reversal') return SUB_REVERSAL;
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
         WHERE i.doc_no = d.doc_no AND rd.status = 'posted') AS reversed_qty,
       0 AS is_reversal
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
       '' AS origin_doc_no,
       '' AS return_ref_no,
       '' AS return_reason,
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
         WHERE o.doc_no = d.doc_no AND rd.status = 'posted') AS reversed_qty,
       0 AS is_reversal
  FROM outbound_docs d
 WHERE d.txn_type = '${TXN_STOCK}'
UNION ALL
SELECT d.doc_no AS doc_no,
       d.date AS date,
       '${SUB_REVERSAL}' AS sub_type,
       'inbound' AS ledger,
       'in' AS direction,
       COALESCE(o.supplier, '') AS party,
       COALESCE(d.reversal_of, '') AS ref_no,
       COALESCE(o.return_tier, '') AS return_tier,
       COALESCE(o.origin_doc_no, '') AS origin_doc_no,
       COALESCE(o.return_ref_no, '') AS return_ref_no,
       COALESCE(o.return_reason, '') AS return_reason,
       d.status AS status,
       COALESCE(d.handler, '') AS handler,
       COALESCE(d.remarks, '') AS remarks,
       d.created_at AS created_at,
       (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no) AS line_count,
       (SELECT COALESCE(SUM(ABS(i.qty)), 0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_qty,
       (SELECT COALESCE(SUM(i.amount), 0) FROM inbound i WHERE i.doc_no = d.doc_no) AS total_amount,
       0 AS reversed_qty,
       1 AS is_reversal
  FROM inbound_docs d
  JOIN inbound_docs o ON o.doc_no = d.reversal_of AND o.txn_type = '${SUB_PURCHASE}'
 WHERE d.txn_type = '${TXN_INBOUND_REV}'
UNION ALL
SELECT d.doc_no AS doc_no,
       d.date AS date,
       '${SUB_REVERSAL}' AS sub_type,
       'outbound' AS ledger,
       'out' AS direction,
       COALESCE(o.destination, '') AS party,
       COALESCE(d.reversal_of, '') AS ref_no,
       '' AS return_tier,
       '' AS origin_doc_no,
       '' AS return_ref_no,
       '' AS return_reason,
       d.status AS status,
       COALESCE(d.handler, '') AS handler,
       COALESCE(d.remarks, '') AS remarks,
       d.created_at AS created_at,
       (SELECT COUNT(*) FROM outbound o2 WHERE o2.doc_no = d.doc_no) AS line_count,
       (SELECT COALESCE(SUM(ABS(o2.qty)), 0) FROM outbound o2 WHERE o2.doc_no = d.doc_no) AS total_qty,
       (SELECT COALESCE(SUM(o2.cost_amount), 0) FROM outbound o2 WHERE o2.doc_no = d.doc_no) AS total_amount,
       0 AS reversed_qty,
       1 AS is_reversal
  FROM outbound_docs d
  JOIN outbound_docs o ON o.doc_no = d.reversal_of AND o.txn_type = '${TXN_STOCK}'
 WHERE d.txn_type = '${TXN_OUTBOUND_REV}'`;

function withDerived(row) {
  const total = Number(row.total_qty || 0);
  const reversed = Number(row.reversed_qty || 0);
  const remaining = Math.max(0, total - reversed);
  const isReversal = Number(row.is_reversal || 0) === 1;
  const returnTier = String(row.return_tier || '');
  return {
    ...row,
    is_reversal: isReversal,
    return_tier: returnTier,
    // 无原单标记：档 3 的采购退货，以及其红冲单（档位从原单继承）
    no_origin: returnTier === 'none',
    total_qty: total,
    total_amount: Number(row.total_amount || 0),
    reversed_qty: reversed,
    remaining_qty: remaining,
    has_reversal: reversed > 0,
    can_reverse: !isReversal && row.status === 'posted' && remaining > 0,
    can_confirm: row.status === 'draft',
    can_edit: row.status === 'draft' && !isReversal,
  };
}

// 判定一张冲销单的原单是否属于退货/退库账本
function isReturnReversal(table, doc) {
  if (!doc || !doc.reversal_of) return false;
  const orig = db.prepare(`SELECT txn_type FROM ${table} WHERE doc_no = ?`).get(doc.reversal_of);
  if (!orig) return false;
  return orig.txn_type === SUB_PURCHASE || orig.txn_type === TXN_STOCK;
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

  // 冲销单归原单所属模块：原单是采购退货 / 领用退库时，冲销单也在退货模块可见
  const ibRev = db.prepare('SELECT * FROM inbound_docs WHERE doc_no = ? AND txn_type = ?').get(docNo, TXN_INBOUND_REV);
  if (ibRev && isReturnReversal('inbound_docs', ibRev)) return sendInboundDetail(res, ibRev, true);

  const obRev = db.prepare('SELECT * FROM outbound_docs WHERE doc_no = ? AND txn_type = ?').get(docNo, TXN_OUTBOUND_REV);
  if (obRev && isReturnReversal('outbound_docs', obRev)) return sendOutboundDetail(res, obRev, true);

  return res.status(404).json({ error: '退货/退库单据不存在', code: 'RETURN_DOC_NOT_FOUND' });
});

function sendInboundDetail(res, doc, isReversal) {
  const lines = db.prepare(`SELECT i.*, m.name AS material_name, m.spec AS material_spec,
      m.unit AS material_unit, m.brand AS material_brand
    FROM inbound i LEFT JOIN materials m ON i.code = m.code
    WHERE i.doc_no = ? ORDER BY i.id ASC`).all(doc.doc_no);
  const logs = db.prepare('SELECT * FROM inbound_doc_logs WHERE doc_no = ? ORDER BY id ASC').all(doc.doc_no);
  const reversals = db.prepare(`SELECT doc_no, date, status FROM inbound_docs
    WHERE reversal_of = ? ORDER BY created_at DESC`).all(doc.doc_no);

  // 冲销单继承原单的退货档位/原因，保证详情与列表「无原单」标记一致
  let tierInfo = {
    return_tier: doc.return_tier || '',
    origin_doc_no: doc.origin_doc_no || '',
    return_ref_no: doc.return_ref_no || '',
    return_reason: doc.return_reason || '',
  };
  if (isReversal && doc.reversal_of) {
    const orig = db.prepare(`SELECT return_tier, origin_doc_no, return_ref_no, return_reason
      FROM inbound_docs WHERE doc_no = ?`).get(doc.reversal_of);
    if (orig) {
      tierInfo = {
        return_tier: orig.return_tier || '',
        origin_doc_no: orig.origin_doc_no || '',
        return_ref_no: orig.return_ref_no || '',
        return_reason: orig.return_reason || '',
      };
    }
  }

  // 关联档明细附上来源入库单号，便于追溯成本
  const originIds = [...new Set(lines.map(l => Number(l.origin_line_id) || 0).filter(Boolean))];
  if (originIds.length) {
    const srcRows = db.prepare(`SELECT id, doc_no FROM inbound
      WHERE id IN (${originIds.map(() => '?').join(',')})`).all(...originIds);
    const srcMap = Object.fromEntries(srcRows.map(r => [String(r.id), r.doc_no]));
    lines.forEach(l => { l.source_doc_no = srcMap[String(l.origin_line_id)] || ''; });
  }

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
    ...tierInfo,
    no_origin: tierInfo.return_tier === 'none',
    sub_type: isReversal ? SUB_REVERSAL : SUB_PURCHASE,
    ledger: 'inbound',
    direction: isReversal ? 'in' : 'out',
    party: doc.supplier || '',
    ref_no: isReversal ? (doc.reversal_of || '')
      : (tierInfo.origin_doc_no || tierInfo.return_ref_no || doc.po_no || doc.contract_no || ''),
    is_reversal: !!isReversal,
    lines,
    logs,
    reversals,
    summary,
    can_reverse: !isReversal && doc.status === 'posted' && summary.remaining_qty > 0,
    can_confirm: doc.status === 'draft',
    can_edit: doc.status === 'draft' && !isReversal,
  });
}

function sendOutboundDetail(res, doc, isReversal) {
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
    sub_type: isReversal ? SUB_REVERSAL : SUB_STOCK,
    ledger: 'outbound',
    direction: isReversal ? 'out' : 'in',
    party: doc.destination || '',
    ref_no: isReversal ? (doc.reversal_of || '') : (doc.origin_doc_no || ''),
    is_reversal: !!isReversal,
    lines,
    logs,
    reversals,
    summary,
    can_reverse: !isReversal && doc.status === 'posted' && summary.remaining_qty > 0,
    can_confirm: doc.status === 'draft',
    can_edit: doc.status === 'draft' && !isReversal,
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
    res.json(getPurchaseReturnOriginLines(docNo, String(req.query.excludeDocNo || '').trim()));
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
    res.json(getPurchaseReturnScopeLines(scope, refNo, String(req.query.excludeDocNo || '').trim()));
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code || 'RETURN_SOURCE_FAILED' });
  }
});

// ==================== 无原单退货报表（2026-11 第六批） ====================
// 明细级数据源：return_tier='none' 的采购退货单及其明细，附冲销单信息便于倒查
const NO_ORIGIN_SORT = {
  date: 'd.date', doc_no: 'd.doc_no', supplier: 'd.supplier', code: 'i.code',
  name: 'm.name', qty: 'i.qty', price: 'i.price', amount: 'i.qty * i.price',
  reason: 'd.return_reason', handler: 'd.handler', status: 'd.status',
};

router.get('/api/returns/no-origin', requirePerm('returns', 'view'), (req, res) => {
  const q = req.query || {};
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize, 10) || 20));
  const sortKey = NO_ORIGIN_SORT[q.sortBy] ? q.sortBy : 'date';
  const sortDir = String(q.sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const where = ["d.txn_type = '采购退货'", "COALESCE(d.return_tier, '') = 'none'"];
  const params = [];
  if (String(q.dateFrom || '').trim()) { where.push('d.date >= ?'); params.push(String(q.dateFrom).trim()); }
  if (String(q.dateTo || '').trim()) { where.push('d.date <= ?'); params.push(String(q.dateTo).trim()); }
  if (String(q.supplier || '').trim()) { where.push('d.supplier LIKE ?'); params.push('%' + String(q.supplier).trim() + '%'); }
  if (String(q.status || '').trim()) { where.push('d.status = ?'); params.push(String(q.status).trim()); }
  if (String(q.keyword || '').trim()) {
    const kw = '%' + String(q.keyword).trim() + '%';
    where.push("(d.doc_no LIKE ? OR i.code LIKE ? OR COALESCE(m.name, '') LIKE ? OR d.return_reason LIKE ? OR d.handler LIKE ?)");
    params.push(kw, kw, kw, kw, kw);
  }
  const whereSql = where.join(' AND ');

  const fromSql = `FROM inbound i
    JOIN inbound_docs d ON d.doc_no = i.doc_no
    LEFT JOIN materials m ON m.code = i.code
    WHERE ${whereSql}`;

  const totals = db.prepare(`SELECT COUNT(DISTINCT d.doc_no) AS doc_count, COUNT(*) AS line_count,
      COALESCE(SUM(i.qty), 0) AS total_qty,
      COALESCE(SUM(i.qty * i.price), 0) AS total_amount
    ${fromSql}`).get(...params);

  const rows = db.prepare(`SELECT i.id AS line_id, d.doc_no AS doc_no, d.date AS date,
      COALESCE(d.supplier,'') AS supplier, i.code AS code, COALESCE(m.name,'') AS material_name,
      COALESCE(m.spec,'') AS material_spec, COALESCE(m.unit,'') AS material_unit,
      i.qty AS qty, i.price AS price,
      (i.qty * i.price) AS amount,
      COALESCE(d.return_reason,'') AS return_reason,
      COALESCE(d.handler,'') AS handler, d.status AS status,
      COALESCE(i.remarks,'') AS remarks, COALESCE(d.return_tier,'') AS return_tier,
      (SELECT rd.doc_no FROM inbound_docs rd WHERE rd.reversal_of = d.doc_no ORDER BY rd.created_at DESC LIMIT 1) AS reversal_doc_no,
      (SELECT rd.status FROM inbound_docs rd WHERE rd.reversal_of = d.doc_no ORDER BY rd.created_at DESC LIMIT 1) AS reversal_status
    ${fromSql}
    ORDER BY ${NO_ORIGIN_SORT[sortKey]} ${sortDir}, d.doc_no DESC, i.id ASC
    LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);

  res.json({
    items: rows, page, pageSize, sortBy: sortKey, sortOrder: sortDir.toLowerCase(),
    total: Number(totals.line_count || 0),
    totalPages: Math.max(1, Math.ceil(Number(totals.line_count || 0) / pageSize)),
    totals: {
      doc_count: Number(totals.doc_count || 0),
      line_count: Number(totals.line_count || 0),
      total_qty: Number(totals.total_qty || 0),
      total_amount: Number(totals.total_amount || 0),
    },
  });
});

module.exports = router;
