/**
 * 出库相关接口（单据列表、明细、草稿/确认/更正）
 *
 * 与入库保持一致：outbound_docs 是单据头，outbound 明细行通过 doc_no 关联；
 * 草稿态明细行 status='draft' 不计入库存，确认过账后 status='posted' 才纳入库存。
 */
const express = require('express');
const db = require('../db');
const costing = require('../services/costing');
const { requirePerm } = require('../middleware/auth');
const {
  validateOutboundStock,
  computeCostPrice,
  getAvailableStock,
  getReturnableLines,
  getReturnedQtyByLine,
  validateReturnAgainstOrigin,
  loadReturnableOrigin,
} = require('../services/stock');
const docno = require('../services/docno');
const time = require('../services/time');
const sign = require('../services/sign');
const audit = require('../services/audit');
const { packDetail } = require('../services/logdetail');
const { maskRows } = require('../services/price-mask');
const { isBusy, busyBody, businessError, withEn, stockBody, bizBody } = require('../services/errors');

const router = express.Router();

// 生成出库单据号（正常出库 GIN / 领料退库 GIT，规则见 services/docno.js，前缀可在参数设置中修改）
function genOutboundDocNo(date, txnType) {
  return docno.genDocNo(txnType === '领料退库' ? 'git' : 'gin', date);
}

// 退库单单头「只补空」：去向/领用人 body 为空（空串/null/未传）时才继承原出库单；
// 显式传了值一律尊重。originDoc 为已取到的原单整行，没有则不处理。
function fillReturnHeaderFromOrigin(txnType, originDoc, values) {
  const empty = v => v === undefined || v === null || String(v).trim() === '';
  const out = { destination: values.destination, receiver: values.receiver };
  if (txnType !== '领料退库' || !originDoc) return out;
  if (empty(out.destination)) out.destination = originDoc.destination || '';
  if (empty(out.receiver)) out.receiver = originDoc.receiver || '';
  return out;
}

// 无原单退库：去向 / 领用人 / 退库原因必填（关联原单的退库不受影响）
function noOriginReturnHeaderError(txnType, originDocNo, h) {
  if (txnType !== '领料退库' || String(originDocNo || '').trim()) return null;
  const missing = [];
  if (!String((h || {}).destination || '').trim()) missing.push('destination');
  if (!String((h || {}).receiver || '').trim()) missing.push('receiver');
  if (!String((h || {}).return_reason || '').trim()) missing.push('return_reason');
  if (!missing.length) return null;
  return { error: '无原单退库必须填写去向、领用人和退库原因', code: 'RETURN_HEADER_REQUIRED', fields: missing };
}

// 记录单据操作日志
function logOutboundDoc(docNo, action, operator, detail) {
  const d = packDetail(detail);
  db.prepare("INSERT INTO outbound_doc_logs (doc_no, action, operator, detail, detail_json) VALUES (?, ?, ?, ?, ?)")
    .run(docNo, action, operator || '', d.text, d.json);
}

// ==================== 出库更正（作废重开） ====================
const CORRECTION_SOURCE_TYPES = ['正常出库', '领料退库'];

function routeFail(code, message, details) {
  const e = new Error(message);
  e.code = code;
  e.status = 400;
  if (details !== undefined) e.details = details;
  return e;
}

function isCorrectionDraft(docLike) {
  return !!docLike && docLike.status === 'draft' && String(docLike.corrects_doc_no || '').trim() !== '';
}

// 跨版本行身份：退库行按原出库行 ID；普通出库行按「物料 + 同物料出现序号」
function outboundLineKeys(lines) {
  const occurrence = new Map();
  return (lines || []).map(l => {
    const rid = Number(l && l.origin_line_id) || 0;
    if (rid > 0) return 'RL:' + rid;
    const code = String((l && l.code) || '').trim();
    const n = (occurrence.get(code) || 0) + 1;
    occurrence.set(code, n);
    return 'MC:' + code + '#' + n;
  });
}

function outboundKeyMap(lines) {
  const keys = outboundLineKeys(lines);
  const map = new Map();
  (lines || []).forEach((l, i) => { if (!map.has(keys[i])) map.set(keys[i], l); });
  return { keys, map };
}

function correctionEligibility(docLike) {
  const deny = (code, reason) => ({ eligible: false, code, reason });
  if (!docLike) return deny('DOC_NOT_FOUND', '单据不存在');
  if (docLike.status === 'draft') return deny('DOC_IS_DRAFT', '草稿单据不支持更正');
  if (docLike.status === 'voided') return deny('DOC_IS_VOIDED', '该单已被作废，不能再次更正');
  if (!CORRECTION_SOURCE_TYPES.includes(docLike.txn_type)) return deny('TYPE_NOT_SUPPORTED', '该单据类型不支持更正');
  if (String(docLike.corrected_by_doc_no || '').trim()) {
    return deny('ALREADY_CORRECTED', '该单已被更正，只能更正最新版本');
  }
  if (docLike.status !== 'posted') return deny('DOC_NOT_POSTED', '只有已过账的单据可以更正');
  return { eligible: true, code: '', reason: '' };
}

// 更正预填：数量/成本单价取绝对值（领料退库存储为负），原行关联全继承
function correctionLines(docLike, includeDraft = false) {
  return db.prepare(`SELECT o.id, o.code, o.qty, o.cost_price, o.origin_line_id, o.remarks,
      o.destination, o.receiver, o.handler,
      m.name AS material_name, m.spec AS material_spec, m.unit AS material_unit, m.brand AS material_brand
    FROM outbound o LEFT JOIN materials m ON m.code = o.code
    WHERE o.doc_no = ? ${includeDraft ? '' : "AND o.status = 'posted'"}
    ORDER BY o.id ASC`).all(docLike.doc_no).map(l => ({
      ...l,
      qty: sign.absQty(l.qty),
      cost_price: sign.storedAbs(l.cost_price),
      origin_line_id: Number(l.origin_line_id) || 0,
    }));
}

// 更正草稿「无改动」判定：行数、每行数量、单头可改字段（日期/去向/领用人/经手人/备注）与原单完全一致。
// 整单作废（草稿无行）属于改动，不在此列。保存草稿与确认更正共用这一套口径。
function correctionUnchanged(draftDoc, draftLines, origDoc, origLines) {
  const live = (draftLines || []).filter(l => sign.absQty(l.qty) > 0);
  const base = (origLines || []).filter(l => sign.absQty(l.qty) > 0);
  if (live.length === 0 || live.length !== base.length) return false;
  const liveKeys = outboundLineKeys(live);
  const baseKeys = outboundLineKeys(base);
  for (let i = 0; i < live.length; i++) {
    if (liveKeys[i] !== baseKeys[i]) return false;
    if (Math.abs(sign.absQty(live[i].qty) - sign.absQty(base[i].qty)) > 1e-9) return false;
  }
  // 无原单退库：退库原因同属单头可改字段（关联原单时该列恒为空，比较不受影响）
  const head = ['date', 'destination', 'receiver', 'handler', 'return_reason'];
  for (const f of head) {
    if (String(draftDoc[f] == null ? '' : draftDoc[f]).trim() !== String(origDoc[f] == null ? '' : origDoc[f]).trim()) return false;
  }
  const remarksNow = String(draftDoc.remarks || '').trim();
  return String(origDoc.remarks || '').trim() === remarksNow;
}

function correctionBlock(docLike) {
  const elig = correctionEligibility(docLike);
  const draft = db.prepare("SELECT doc_no FROM outbound_docs WHERE corrects_doc_no=? AND status='draft' ORDER BY created_at DESC LIMIT 1").get(docLike.doc_no);
  return {
    ...elig,
    is_voided: docLike.status === 'voided',
    voided_at: String(docLike.voided_at || ''),
    voided_by: String(docLike.voided_by || ''),
    corrects_doc_no: String(docLike.corrects_doc_no || ''),
    corrected_by_doc_no: String(docLike.corrected_by_doc_no || ''),
    has_draft: !!draft,
    draft_doc_no: draft ? draft.doc_no : '',
  };
}

function inPlaceholders(arr) {
  return arr.map(() => '?').join(',');
}

// 出库单据列表（支持按状态/关键字/日期/类型筛选；excludeType 用于列表排除某类单据）
router.get('/api/outbound-docs', requirePerm('outbound', 'view'), (req, res) => {
  const { status, keyword, dateFrom, dateTo, txnType, excludeType, includeHistory, noOrigin } = req.query;
  let sql = `SELECT d.*,
    (CASE WHEN d.txn_type = '领料退库' AND TRIM(COALESCE(d.origin_doc_no,'')) = '' THEN 1 ELSE 0 END) as no_origin,
    (SELECT COUNT(*) FROM outbound o WHERE o.doc_no = d.doc_no) as line_count,
    (SELECT COALESCE(SUM(qty),0) FROM outbound o WHERE o.doc_no = d.doc_no) as total_qty,
    (SELECT COALESCE(SUM(cost_amount),0) FROM outbound o WHERE o.doc_no = d.doc_no) as total_amount
    FROM outbound_docs d WHERE 1=1`;
  const params = [];
  if (String(noOrigin || '') === '1') {
    sql += " AND d.txn_type = '领料退库' AND TRIM(COALESCE(d.origin_doc_no,'')) = ''";
  }
  // 作废单默认不进列表；历史版本或关键字搜索时出现
  if (!status && !keyword && !includeHistory) {
    sql += " AND d.status <> 'voided'";
  }
  if (status) { sql += " AND d.status=?"; params.push(status); }
  if (txnType) { sql += " AND d.txn_type=?"; params.push(txnType); }
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
    sql += " AND (d.doc_no LIKE ? OR d.destination LIKE ? OR d.receiver LIKE ? OR d.handler LIKE ? OR d.remarks LIKE ?)";
    const kw = '%' + keyword + '%';
    params.push(kw, kw, kw, kw, kw);
  }
  sql += " ORDER BY d.date DESC, d.created_at DESC";
  res.json(maskRows(req, db.prepare(sql).all(...params), ['total_amount']));
});

// 获取下一个出库单据号
router.get('/api/outbound-docs/next-no', requirePerm('outbound', 'view'), (req, res) => {
  const date = req.query.date || time.todayLocal();
  const txnType = req.query.txnType || '正常出库';
  res.json({ doc_no: genOutboundDocNo(date, txnType) });
});

// 创建出库单据（草稿态）
router.post('/api/outbound-docs', requirePerm('outbound', 'create'), (req, res) => {
  const body = req.body;
  const date = body.date || time.todayLocal();
  const txnType = body.txn_type || '正常出库';
  // 单号在事务内生成，避免多实例并发建单时撞号
  let docNo = body.doc_no ? String(body.doc_no).trim() : '';
  // 2C：只有领料退库允许关联原出库单；其他类型忽略该字段
  const originDocNo = txnType === '领料退库' ? String(body.origin_doc_no || '').trim() : '';
  let originDoc = null;
  try {
    if (originDocNo) originDoc = loadReturnableOrigin(originDocNo);
    // 退库单去向/领用人只补空：前端未带出时后端兜底继承原单
    const header = fillReturnHeaderFromOrigin(txnType, originDoc, {
      destination: body.destination, receiver: body.receiver,
    });
    // 无原单退库：单头三项必填，草稿也不许绕过
    const hdrErr = noOriginReturnHeaderError(txnType, originDocNo, {
      destination: header.destination, receiver: header.receiver, return_reason: body.return_reason,
    });
    if (hdrErr) return res.status(400).json(hdrErr);

    // 先规整明细行（保留原行关联），再整体校验可退量
    const preparedLines = (Array.isArray(body.lines) ? body.lines : [])
      .filter(l => l && l.code)
      .map(l => ({
        code: l.code,
        qty: sign.normalizeQty(txnType, l.qty),
        origin_line_id: Number(l.origin_line_id) || 0,
        remarks: l.remarks || '',
      }));
    if (originDocNo && preparedLines.length) {
      validateReturnAgainstOrigin(preparedLines, originDocNo, docNo);
    }

    // 空草稿兜底：无任何有效明细，且单头无关键字段（领用单位/领用人/来源/备注）时拒绝建单
    const hasHeaderContent = [body.destination, body.receiver, originDocNo, body.remarks, body.return_reason]
      .some(v => String(v || '').trim());
    if (preparedLines.length === 0 && !hasHeaderContent) {
      return res.status(400).json({ error: '未填写任何内容，已拒绝创建空草稿', code: 'EMPTY_DRAFT' });
    }

    const tx = db.transaction(() => {
      if (!docNo) docNo = genOutboundDocNo(date, txnType);
      if (db.prepare("SELECT 1 AS ok FROM outbound_docs WHERE doc_no=?").get(docNo)) {
        throw businessError('DOC_NO_CONFLICT', `单据号 ${docNo} 已被其他请求占用，请重试`, undefined, 409);
      }
      db.prepare(`INSERT INTO outbound_docs (doc_no, date, txn_type, destination, receiver, handler, status, remarks, created_by, origin_doc_no, return_reason)
        VALUES (@doc_no, @date, @txn_type, @destination, @receiver, @handler, 'draft', @remarks, @created_by, @origin_doc_no, @return_reason)`)
        .run({
          doc_no: docNo, date, txn_type: txnType,
          destination: header.destination || '', receiver: header.receiver || '',
          handler: body.handler || '', remarks: body.remarks || '',
          created_by: req.user?.name || req.user?.username || '',
          origin_doc_no: originDocNo,
          return_reason: txnType === '领料退库' ? String(body.return_reason || '') : '',
        });

      const stmt = db.prepare(`INSERT INTO outbound (date, gin_no, doc_no, code, qty, destination, receiver, handler, remarks, cost_price, txn_type, status, origin_line_id)
        VALUES (@date, @gin_no, @doc_no, @code, @qty, @destination, @receiver, @handler, @remarks, 0, @txn_type, 'draft', @origin_line_id)`);
      preparedLines.forEach(l => {
        stmt.run({
          date, gin_no: docNo, doc_no: docNo, code: l.code, qty: l.qty,
          destination: header.destination || '', receiver: header.receiver || '',
          handler: body.handler || '', remarks: l.remarks, txn_type: txnType,
          origin_line_id: l.origin_line_id,
        });
      });

      logOutboundDoc(docNo, 'create', req.user?.name || req.user?.username,
        originDocNo
          ? { key: 'audit_detail_ob_create_return', params: { doc: originDocNo } }
          : { key: 'audit_detail_ob_create' });
    });
    tx.immediate();
    res.json({ success: true, doc_no: docNo });
  } catch (e) {
    if (isBusy(e)) return res.status(409).json(busyBody());
    if (/UNIQUE constraint failed: outbound_docs\.doc_no/.test(String(e.message || ''))) {
      return res.status(409).json(withEn({
        code: 'DOC_NO_CONFLICT',
        error: `单据号 ${docNo} 已被其他请求占用，请重试`,
      }));
    }
    res.status(400).json(withEn(bizBody(e, 'OUTBOUND_DOC_CREATE_FAILED')));
  }
});

// 出库单据详情（含明细行 + 操作日志 + 更正信息）
router.get('/api/outbound-docs/:docNo', requirePerm('outbound', 'view'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });

  const lines = db.prepare(`SELECT o.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand,
      (SELECT sl.cost_basis FROM stock_ledger sl
        WHERE sl.source_type='outbound' AND sl.source_line_id=o.id AND sl.status='active'
        ORDER BY sl.posting_sequence DESC LIMIT 1) AS cost_basis
    FROM outbound o LEFT JOIN materials m ON o.code = m.code
    WHERE o.doc_no=? ORDER BY o.id ASC`).all(docNo);

  const logs = db.prepare("SELECT * FROM outbound_doc_logs WHERE doc_no=? ORDER BY id ASC").all(docNo);

  const summary = {
    line_count: lines.length,
    total_qty: lines.reduce((s, l) => s + Number(l.qty || 0), 0),
    total_amount: lines.reduce((s, l) => s + Number(l.cost_amount || 0), 0)
  };

  // 关联退库单（单据级）：单头 origin_doc_no 匹配，或任一退库明细行核销到本出库单的明细行。
  // 两者取或避免「单头为空、关系只在明细行」的漏单；GROUP BY doc_no 保证一张单只出现一次。
  // 含草稿/已作废；数量、金额按存储值有符号返回（领料退库为负），不做绝对值。
  const relatedReturns = db.prepare(`
    SELECT d.doc_no, d.date, d.txn_type, d.status,
      COALESCE(d.destination,'') AS destination, COALESCE(d.handler,'') AS handler,
      COUNT(o.id) AS line_count,
      COALESCE(SUM(o.qty), 0) AS total_qty,
      COALESCE(SUM(o.cost_amount), 0) AS total_amount
    FROM outbound_docs d LEFT JOIN outbound o ON o.doc_no = d.doc_no
    WHERE d.txn_type = '领料退库' AND d.doc_no <> '' AND (
      d.origin_doc_no = ?
      OR EXISTS (SELECT 1 FROM outbound r WHERE r.doc_no = d.doc_no
        AND r.origin_line_id IN (SELECT id FROM outbound WHERE doc_no = ?))
    )
    GROUP BY d.doc_no
    ORDER BY d.date DESC`).all(docNo, docNo);
  // 同日单号按修订号数字排序，保证 -R2 排在 -R10 之前
  relatedReturns.sort((a, b) => {
    const d = String(b.date || '').localeCompare(String(a.date || ''));
    return d !== 0 ? d : docno.compareDocNo(b.doc_no, a.doc_no);
  });

  // 无价格权限：明细成本单价/金额、合计金额、关联退库金额整组不下发（数量类保留）
  if (!req.canViewPrice) {
    lines.forEach(l => { delete l.cost_price; delete l.cost_amount; });
    delete summary.total_amount;
    relatedReturns.forEach(r => { delete r.total_amount; });
  }
  res.json({ ...doc, lines, logs, summary, correction: correctionBlock(doc), related_returns: relatedReturns });
});

// 原出库单的可退明细（2C）：仅已过账的「正常出库」单可作为退库来源
// excludeDocNo: 当前正在编辑的退库单，避免把自己的占用算进已退量
router.get('/api/outbound-docs/:docNo/returnable', requirePerm('outbound', 'view'), (req, res) => {
  const docNo = req.params.docNo;
  try {
    const origin = loadReturnableOrigin(docNo);
    const lines = getReturnableLines(docNo, String(req.query.excludeDocNo || '').trim(), origin);
    // 退库明细的成本单价只用于展示，保存时服务端按原出库行继承，前端不需要它
    if (!req.canViewPrice) lines.forEach(l => { delete l.cost_price; });
    res.json({
      doc_no: docNo, status: origin.status, date: origin.date,
      destination: origin.destination, receiver: origin.receiver,
      handler: origin.handler, remarks: origin.remarks, lines,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

// 保存出库单据明细行（草稿态可操作）—— 整体替换
router.put('/api/outbound-docs/:docNo/lines', requirePerm('outbound', 'edit'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '已过账/作废的单据不能修改明细', code: 'DOC_NOT_DRAFT' });

  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];

  // 更正草稿：明细存「更正后目标数量」，成本单价只读（继承原行），允许一行不剩
  if (isCorrectionDraft(doc)) {
    // 无原单退库更正：单头三项仍必填（空值视为沿用当前单据）
    const cHdrErr = noOriginReturnHeaderError(doc.txn_type, doc.origin_doc_no, {
      destination: req.body.destination !== undefined ? req.body.destination : doc.destination,
      receiver: req.body.receiver !== undefined ? req.body.receiver : doc.receiver,
      return_reason: req.body.return_reason !== undefined ? req.body.return_reason : doc.return_reason,
    });
    if (cHdrErr) return res.status(400).json(cHdrErr);
    const orig = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(doc.corrects_doc_no);
    if (!orig) return res.status(404).json({ error: '被更正的原单不存在', code: 'ORIGIN_DOC_NOT_FOUND' });
    const origLines = db.prepare("SELECT * FROM outbound WHERE doc_no=? AND status='posted' ORDER BY id").all(orig.doc_no)
      .filter(l => sign.absQty(l.qty) > 0);
    const keyMap = outboundKeyMap(origLines);
    const targets = lines.filter(l => l && l.code && Number(l.qty) > 0);
    const targetKeys = outboundLineKeys(targets);
    const seen = new Set();
    try {
      targetKeys.forEach((key, i) => {
        if (String(key).startsWith('RL:')) {
          if (seen.has(key)) throw routeFail('DUPLICATE_CORRECTION_LINE', `第 ${i + 1} 行与其他行重复关联同一个原出库行`);
          seen.add(key);
        }
      });
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM outbound WHERE doc_no=?").run(docNo);
        const stmt = db.prepare(`INSERT INTO outbound (date, gin_no, doc_no, code, qty, destination, receiver, handler, remarks, cost_price, txn_type, status, origin_line_id)
          VALUES (@date, @gin_no, @doc_no, @code, @qty, @destination, @receiver, @handler, @remarks, @cost_price, @txn_type, 'draft', @origin_line_id)`);
        targets.forEach((l, i) => {
          const key = targetKeys[i];
          const baseLine = keyMap.map.get(key);
          let qty = sign.normalizeQty(doc.txn_type, Number(l.qty));
          let costPrice = baseLine ? sign.storedAbs(baseLine.cost_price) : 0;
          let originLineId = Number(l.origin_line_id) || (baseLine ? Number(baseLine.origin_line_id) || 0 : 0);
          if (doc.txn_type === '领料退库' && String(doc.origin_doc_no || '').trim() && originLineId <= 0) {
            throw routeFail('RETURN_ORIGIN_REQUIRED', `物料 ${l.code} 缺少原出库行关联，无法更正退库单`);
          }
          stmt.run({
            date: doc.date, gin_no: docNo, doc_no: docNo,
            code: l.code, qty, destination: doc.destination, receiver: doc.receiver,
            handler: doc.handler, remarks: l.remarks || '', cost_price: costPrice,
            txn_type: doc.txn_type, origin_line_id: originLineId
          });
        });
        if (req.body.remarks !== undefined) {
          db.prepare("UPDATE outbound_docs SET remarks=? WHERE doc_no=?").run(req.body.remarks, docNo);
        }
        // 无原单退库更正：退库原因可随更正一起维护
        if (doc.txn_type === '领料退库' && req.body.return_reason !== undefined) {
          db.prepare("UPDATE outbound_docs SET return_reason=? WHERE doc_no=?").run(String(req.body.return_reason || ''), docNo);
        }
        logOutboundDoc(docNo, 'edit', req.user?.name || req.user?.username,
          targets.length === 0
            ? { key: 'audit_detail_ob_clear' }
            : { key: 'audit_detail_ob_save_targets', params: { n: targets.length } });
      });
      tx();
      res.json({ success: true, target_count: targets.length });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message, code: e.code || 'CORRECTION_LINES_SAVE_FAILED' });
    }
    return;
  }

  // 2C：退库单可维护原出库单关联（不传则沿用原值）
  const originDocNo = doc.txn_type === '领料退库'
    ? (req.body.origin_doc_no !== undefined ? String(req.body.origin_doc_no || '').trim() : (doc.origin_doc_no || ''))
    : '';
  // 退库单去向/领用人只补空：编辑保存时同样继承原单（原单行直接取，不做额外校验）
  const originDoc = originDocNo
    ? db.prepare('SELECT destination, receiver FROM outbound_docs WHERE doc_no=?').get(originDocNo)
    : null;
  const header = fillReturnHeaderFromOrigin(doc.txn_type, originDoc, {
    destination: req.body.destination !== undefined ? req.body.destination : doc.destination,
    receiver: req.body.receiver !== undefined ? req.body.receiver : doc.receiver,
  });
  const returnReason = doc.txn_type === '领料退库'
    ? (req.body.return_reason !== undefined ? String(req.body.return_reason || '') : String(doc.return_reason || ''))
    : '';
  // 无原单退库：编辑保存同样必须满足单头三项
  const hdrErr = noOriginReturnHeaderError(doc.txn_type, originDocNo, {
    destination: header.destination, receiver: header.receiver, return_reason: returnReason,
  });
  if (hdrErr) return res.status(400).json(hdrErr);

  // 先规整明细（原行关联 + 符号推导），再校验可退量；校验与写入基于同一批行
  try {
    const preparedLines = lines.filter(l => l && l.code).map(l => ({
      code: l.code,
      qty: sign.normalizeQty(doc.txn_type, l.qty),
      origin_line_id: Number(l.origin_line_id) || 0,
      remarks: l.remarks || ''
    }));
    if (originDocNo && preparedLines.length) {
      validateReturnAgainstOrigin(preparedLines, originDocNo, docNo);
    }
    const tx = db.transaction(() => {
      // 先删旧行
      db.prepare("DELETE FROM outbound WHERE doc_no=?").run(docNo);
      // 再插新行
      const stmt = db.prepare(`INSERT INTO outbound (date, gin_no, doc_no, code, qty, destination, receiver, handler, remarks, cost_price, txn_type, status, origin_line_id)
        VALUES (@date, @gin_no, @doc_no, @code, @qty, @destination, @receiver, @handler, @remarks, 0, @txn_type, 'draft', @origin_line_id)`);
      preparedLines.forEach(l => {
        stmt.run({
          date: doc.date, gin_no: docNo, doc_no: docNo,
          code: l.code, qty: l.qty,
          destination: header.destination || '', receiver: header.receiver || '', handler: doc.handler,
          remarks: l.remarks, txn_type: doc.txn_type, origin_line_id: l.origin_line_id
        });
      });
      // 更新单据头的部分字段（允许跟着明细一起改）
      const updateFields = {};
      if (header.destination !== (doc.destination || '')) updateFields.destination = header.destination;
      if (header.receiver !== (doc.receiver || '')) updateFields.receiver = header.receiver;
      if (req.body.handler !== undefined) updateFields.handler = req.body.handler;
      if (req.body.remarks !== undefined) updateFields.remarks = req.body.remarks;
      if (req.body.date !== undefined) updateFields.date = req.body.date;
      if (doc.txn_type === '领料退库') {
        updateFields.origin_doc_no = originDocNo;
        updateFields.return_reason = returnReason;
      }
      if (Object.keys(updateFields).length > 0) {
        const sets = Object.keys(updateFields).map(k => `${k}=@${k}`).join(', ');
        db.prepare(`UPDATE outbound_docs SET ${sets} WHERE doc_no=@doc_no`).run({ ...updateFields, doc_no: docNo });
      }
      logOutboundDoc(docNo, 'edit', req.user?.name || req.user?.username,
        originDocNo
          ? { key: 'audit_detail_ob_save_return', params: { n: preparedLines.length, doc: originDocNo } }
          : { key: 'audit_detail_ob_save', params: { n: preparedLines.length } });
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

// 确认出库（过账）—— 草稿 → posted，明细行 status → posted，库存流水生效
router.post('/api/outbound-docs/:docNo/confirm', requirePerm('outbound', 'edit'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '只有草稿单据可以确认', code: 'DOC_NOT_DRAFT' });

  // 无原单退库：过账前再校验单头三项（防止历史草稿绕过）
  const hdrErr = noOriginReturnHeaderError(doc.txn_type, doc.origin_doc_no, {
    destination: doc.destination, receiver: doc.receiver, return_reason: doc.return_reason,
  });
  if (hdrErr) return res.status(400).json(hdrErr);

  // 2C：退库单的可退量校验放在过账事务内（见下），避免跨实例并发时两张退库单同时通过
  const originDocNo = doc.txn_type === '领料退库' ? (doc.origin_doc_no || '') : '';

  // 无成本依据（该物料从未有过正库存）：须管理员显式确认后带 accept_no_basis 重提
  const acceptNoBasis = req.body && req.body.accept_no_basis === true;
  if (acceptNoBasis && (!req.user || req.user.role !== 'admin')) {
    return res.status(403).json({ error: '仅管理员可确认按 0 成本入账', code: 'NO_BASIS_FORBIDDEN' });
  }

  const operator = req.user?.name || req.user?.username || '';
  let lineCount = 0;
  try {
    // BEGIN IMMEDIATE：事务开始即拿写锁，状态判断、可退量、库存判断与扣减在同一临界区
    const tx = db.transaction(() => {
      // 事务内重读明细，避免读到过期的草稿行
      const lines = db.prepare("SELECT * FROM outbound WHERE doc_no=?").all(docNo);
      if (lines.length === 0) throw businessError('NO_LINES', '单据没有明细行，无法确认');
      // 有原单退库：可退量校验与过账同事务，跨实例并发退库只有一张能通过
      if (originDocNo) {
        validateReturnAgainstOrigin(
          lines.map(l => ({ code: l.code, qty: sign.absQty(l.qty), origin_line_id: l.origin_line_id })),
          originDocNo, docNo);
      }
      // 负库存硬拦：出库/退库数量超过可用库存直接拒绝，不再提供强制放行
      validateOutboundStock(lines);
      // 校验全部通过后再翻转状态：状态守卫保证跨实例重复确认只有第一个能改到行
      const posted = db.prepare(`UPDATE outbound_docs SET status='posted', confirmed_by=?, confirmed_at=datetime('now')
        WHERE doc_no=? AND status='draft'`).run(operator, docNo);
      if (posted.changes === 0) {
        throw businessError('DOC_STATE_CHANGED', '单据已被其他请求处理（可能已确认或作废），请刷新后重试', undefined, 409);
      }
      // 明细行过账（成本单价由统一成本服务按流水核算并回写）
      db.prepare("UPDATE outbound SET status='posted' WHERE doc_no=?").run(docNo);
      costing.postOutboundDoc(doc, lines, null, { acceptNoBasis, triggerDoc: docNo });
      logOutboundDoc(docNo, 'confirm', operator,
        { key: 'audit_detail_ob_confirm', params: { n: lines.length } });
      if (acceptNoBasis) {
        audit.record({
          user_id: req.user?.id ?? null, username: req.user?.username || '', name: req.user?.name || '',
          role: req.user?.role || '', module: 'outbound', action: 'accept_no_basis', target: docNo,
          method: req.method, path: req.originalUrl, ip: req.ip, status: 200,
          detail: { key: 'audit_detail_accept_no_basis', params: { doc: docNo, n: lines.length } },
        });
      }
      lineCount = lines.length;
    });
    tx.immediate();
    res.json({ success: true, line_count: lineCount });
  } catch (e) {
    if (e.stockError) return res.status(400).json(stockBody(e));
    if (e.code === 'NO_COST_BASIS') {
      return res.status(400).json(withEn({ error: e.message, code: 'NO_COST_BASIS', details: e.details }));
    }
    if (isBusy(e)) return res.status(409).json(busyBody());
    res.status(e.status || 400).json(bizBody(e, 'OUTBOUND_CONFIRM_FAILED'));
  }
});

// 删除出库单据（草稿态可删除，连同明细行一起）
router.delete('/api/outbound-docs/:docNo', requirePerm('outbound', 'delete'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '已过账/作废的单据不能删除', code: 'DOC_NOT_DRAFT' });
  try {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM outbound WHERE doc_no=?").run(docNo);
      db.prepare("DELETE FROM outbound_docs WHERE doc_no=?").run(docNo);
      // 删除后该单据号可能被后续新建单据复用，必须一并清理操作日志，
      // 否则复用同一单号的新单据会显示已被删除单据的历史日志。
      db.prepare("DELETE FROM outbound_doc_logs WHERE doc_no=?").run(docNo);
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== 出库更正（作废重开）接口 ====================

// 更正信息：资格 + 预填行 + 草稿/作废信息
router.get('/api/outbound-docs/:docNo/correction-info', requirePerm('outbound', 'view'), (req, res) => {
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(req.params.docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });
  const lines = correctionLines(doc, doc.status === 'draft');
  if (!req.canViewPrice) lines.forEach(l => { delete l.cost_price; });
  res.json({ doc, lines, correction: correctionBlock(doc) });
});

// 创建更正草稿：继承日期/类型/去向/领用人/退库原单/明细；确认后原单作废、新单直接过账
router.post('/api/outbound-docs/:docNo/correction', requirePerm('outbound', 'correct'), (req, res) => {
  const orig = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(req.params.docNo);
  if (!orig) return res.status(404).json({ error: '出库单据不存在' });

  const elig = correctionEligibility(orig);
  if (!elig.eligible) return res.status(400).json({ error: elig.reason, code: elig.code });

  const existing = db.prepare("SELECT doc_no FROM outbound_docs WHERE corrects_doc_no=? AND status='draft'").get(orig.doc_no);
  if (existing) return res.json({ success: true, doc_no: existing.doc_no, reused: true });

  const docNo = docno.genRevisionDocNo(orig.doc_no);
  const operator = req.user?.name || req.user?.username || '';
  const prefill = correctionLines(orig);

  try {
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO outbound_docs (doc_no, date, txn_type, destination, receiver, handler, status, remarks,
          created_by, origin_doc_no, corrects_doc_no, return_reason)
        VALUES (@doc_no, @date, @txn_type, @destination, @receiver, @handler, 'draft', @remarks,
          @created_by, @origin_doc_no, @corrects_doc_no, @return_reason)`)
        .run({
          doc_no: docNo, date: orig.date, txn_type: orig.txn_type,
          destination: orig.destination || '', receiver: orig.receiver || '', handler: orig.handler || '',
          remarks: req.body?.remarks !== undefined ? req.body.remarks : '',
          created_by: operator, origin_doc_no: orig.origin_doc_no || '', corrects_doc_no: orig.doc_no,
          return_reason: orig.txn_type === '领料退库' ? String(orig.return_reason || '') : '',
        });
      const stmt = db.prepare(`INSERT INTO outbound (date, gin_no, doc_no, code, qty, destination, receiver, handler,
          remarks, cost_price, txn_type, status, origin_line_id)
        VALUES (@date, @gin_no, @doc_no, @code, @qty, @destination, @receiver, @handler,
          @remarks, @cost_price, @txn_type, 'draft', @origin_line_id)`);
      prefill.forEach(l => {
        stmt.run({
          date: orig.date, gin_no: docNo, doc_no: docNo, code: l.code,
          qty: sign.normalizeQty(orig.txn_type, l.qty), destination: orig.destination || '',
          receiver: orig.receiver || '', handler: orig.handler || '', remarks: l.remarks || '',
          cost_price: l.cost_price, txn_type: orig.txn_type, origin_line_id: l.origin_line_id
        });
      });
      logOutboundDoc(docNo, 'create', operator, { key: 'audit_detail_ob_corr_draft', params: { doc: orig.doc_no } });
      logOutboundDoc(orig.doc_no, 'correction-draft', operator, { key: 'audit_detail_ob_corr_created', params: { doc: docNo } });
    });
    tx();
    res.json({ success: true, doc_no: docNo, reused: false });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code || 'CORRECTION_CREATE_FAILED' });
  }
});

// 确认更正：单事务完成「原单作废 + 退库单改指向 + 新单过账」；明细全删则只作废原单
router.post('/api/outbound-docs/:docNo/confirm-correction', requirePerm('outbound', 'correct'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });
  if (!isCorrectionDraft(doc) || doc.status !== 'draft') {
    return res.status(400).json({ error: '该单据不是待确认的更正草稿', code: 'NOT_CORRECTION_DRAFT' });
  }

  const orig = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(doc.corrects_doc_no);
  if (!orig) return res.status(404).json({ error: '被更正的原单不存在' });
  const elig = correctionEligibility(orig);
  if (!elig.eligible) return res.status(400).json({ error: elig.reason, code: elig.code });

  const draftLines = db.prepare("SELECT * FROM outbound WHERE doc_no=? ORDER BY id").all(docNo);
  const origLines = db.prepare("SELECT * FROM outbound WHERE doc_no=? AND status='posted' ORDER BY id")
    .all(orig.doc_no).filter(l => sign.absQty(l.qty) > 0);
  const origKeyMap = outboundKeyMap(origLines);
  const newKeyMap = outboundKeyMap(draftLines);
  // 无改动不生成更正：草稿与原单的行数/每行数量/单头可改字段完全一致时拒绝（绕过前端同样拦住）
  if (correctionUnchanged(doc, draftLines, orig, origLines)) {
    return res.status(400).json({ error: '没有改动，无需更正', code: 'CORRECTION_UNCHANGED' });
  }

  // 更正领料退库：新数量不得超过原出库行的剩余可退量（排除原退库单自身）
  if (orig.txn_type === '领料退库' && orig.origin_doc_no && draftLines.length > 0) {
    try {
      validateReturnAgainstOrigin(
        draftLines.map(l => ({ code: l.code, qty: sign.absQty(l.qty), origin_line_id: l.origin_line_id })),
        orig.origin_doc_no, orig.doc_no);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message, code: e.code || 'RETURN_QTY_EXCEEDED', details: e.details });
    }
  }

  const downstreamReturns = db.prepare(`SELECT doc_no, status FROM outbound_docs
    WHERE txn_type='领料退库' AND origin_doc_no=?`).all(orig.doc_no);
  if (draftLines.length === 0 && downstreamReturns.length > 0) {
    return res.status(400).json({
      error: `该出库单挂着退库单 ${downstreamReturns.map(d => d.doc_no).join('、')}，不能整单作废；` +
        '请保留对应明细行，或先删除/更正这些退库单。',
      code: 'DOWNSTREAM_DOCS_EXIST',
      details: { return_docs: downstreamReturns.map(d => d.doc_no) }
    });
  }

  // 冲突 1：已确认退库量 > 新单对应行数量 → 拒绝，提示具体退库单
  const returnDocsForLine = db.prepare(`SELECT DISTINCT d.doc_no FROM outbound r
    JOIN outbound_docs d ON d.doc_no = r.doc_no
    WHERE r.origin_line_id = ? AND r.txn_type = '领料退库' AND d.status = 'posted'`);
  const conflicts = [];
  origLines.forEach((ol, idx) => {
    const returned = getReturnedQtyByLine(ol.id);
    const target = newKeyMap.map.get(origKeyMap.keys[idx]);
    const newQty = target ? sign.absQty(target.qty) : 0;
    if (returned > newQty + 0.0001) {
      conflicts.push({
        code: ol.code,
        original_qty: sign.absQty(ol.qty),
        returned_qty: Number(returned.toFixed(6)),
        new_qty: Number(newQty.toFixed(6)),
        return_docs: returnDocsForLine.all(ol.id).map(r => r.doc_no)
      });
    }
  });
  if (conflicts.length > 0) {
    const msg = conflicts.map(c =>
      `物料 ${c.code}：已确认退库 ${c.returned_qty}，更正后新数量 ${c.new_qty}` +
      (c.return_docs.length ? `（退库单：${c.return_docs.join('、')}）` : '')
    ).join('；');
    return res.status(400).json({
      error: `${msg}。请先更正上述退库单数量后再重新确认。`,
      code: 'RETURN_EXCEEDS_CORRECTED_QTY',
      details: conflicts
    });
  }

  // 冲突 2：作废原单后库存转负 → 拒绝
  const newQtyByCode = new Map();
  draftLines.forEach(l => newQtyByCode.set(l.code, (newQtyByCode.get(l.code) || 0) + (Number(l.qty) || 0)));
  const origQtyByCode = new Map();
  origLines.forEach(l => origQtyByCode.set(l.code, (origQtyByCode.get(l.code) || 0) + (Number(l.qty) || 0)));
  const codes = new Set([...newQtyByCode.keys(), ...origQtyByCode.keys()]);
  const stockErrors = [];
  const snapshot = {};
  codes.forEach(code => {
    const available = getAvailableStock(code);
    const delta = (origQtyByCode.get(code) || 0) - (newQtyByCode.get(code) || 0);
    snapshot[code] = {
      available_before: Number(available.toFixed(6)),
      original_qty: Number((origQtyByCode.get(code) || 0).toFixed(6)),
      new_qty: Number((newQtyByCode.get(code) || 0).toFixed(6)),
      available_after: Number((available + delta).toFixed(6))
    };
    if (available + delta < -0.0001) {
      stockErrors.push({
        code,
        available: Number(available.toFixed(6)),
        required: Number(Math.abs(delta).toFixed(6)),
        after: Number((available + delta).toFixed(6))
      });
    }
  });
  if (stockErrors.length > 0) {
    return res.status(400).json({
      error: `更正后库存将为负数：${stockErrors.map(d =>
        `${d.code} 需要减少 ${d.required}，当前可用 ${d.available}`).join('；')}。` +
        '请先补充入库或调整相关单据后再重新确认。',
      code: 'INSUFFICIENT_STOCK',
      details: stockErrors
    });
  }

  const operator = req.user?.name || req.user?.username || '';
  const origLineIds = origLines.map(l => l.id);
  const reopen = draftLines.length > 0;
  let result = null;
  const balBefore = costing.captureBalances();

  try {
    const tx = db.transaction(() => {
      // 事务内复核：跨实例并发退库/更正时，以写锁内读到的最新数据为准
      if (reopen) {
        if (orig.txn_type === '领料退库' && orig.origin_doc_no) {
          validateReturnAgainstOrigin(
            draftLines.map(l => ({ code: l.code, qty: sign.absQty(l.qty), origin_line_id: l.origin_line_id })),
            orig.origin_doc_no, orig.doc_no);
        }
        origLines.forEach((ol, idx) => {
          const target = newKeyMap.map.get(origKeyMap.keys[idx]);
          const newQty = target ? sign.absQty(target.qty) : 0;
          if (getReturnedQtyByLine(ol.id) > newQty + 0.0001) {
            throw businessError('RETURN_EXCEEDS_CORRECTED_QTY',
              `物料 ${ol.code}：已确认退库量已超过更正后的新数量 ${newQty}，请先更正相关退库单`);
          }
        });
      }
      const voided = db.prepare(`UPDATE outbound_docs SET status='voided', voided_at=datetime('now'), voided_by=?,
          corrected_by_doc_no=? WHERE doc_no=? AND status='posted'`)
        .run(operator, reopen ? docNo : '', orig.doc_no);
      if (voided.changes === 0) throw businessError('DOC_STATE_CHANGED', '原单状态已变化，请刷新后重试', undefined, 409);
      db.prepare("UPDATE outbound SET status='voided' WHERE doc_no=?").run(orig.doc_no);

      // 原单流水置无效；重开时先不重算，等新单在原核算位置落位后一次性重算后续流水
      const ledgerVoid = costing.voidDocLedger('outbound', orig.doc_no, { recompute: !reopen });

      let retargeted = 0;
      if (reopen) {
        // 下游退库单改指向新单；行按行身份映射
        retargeted = db.prepare(`UPDATE outbound_docs SET origin_doc_no=?
          WHERE txn_type='领料退库' AND origin_doc_no=?`).run(docNo, orig.doc_no).changes;
        if (origLineIds.length > 0) {
          const returnLines = db.prepare(`SELECT id, origin_line_id FROM outbound
            WHERE txn_type='领料退库' AND origin_line_id IN (${inPlaceholders(origLineIds)})`).all(...origLineIds);
          const updLine = db.prepare("UPDATE outbound SET origin_line_id=? WHERE id=?");
          returnLines.forEach(r => {
            let target = null;
            for (let i = 0; i < origLines.length; i++) {
              if (origLines[i].id === Number(r.origin_line_id)) {
                target = newKeyMap.map.get(origKeyMap.keys[i]) || null;
                break;
              }
            }
            updLine.run(target ? target.id : 0, r.id);
          });
        }
      }

      // 新单在原单的核算位置生效：写流水并重算该物料其后全部有效流水
      if (reopen) {
        db.prepare("UPDATE outbound SET status='posted' WHERE doc_no=?").run(docNo);
        costing.postOutboundDoc(doc, draftLines, {
          ...(ledgerVoid.anchor || {}),
          correctionOf: orig.doc_no,
        });
        const postedNew = db.prepare(`UPDATE outbound_docs SET status='posted', confirmed_by=?, confirmed_at=datetime('now')
          WHERE doc_no=? AND status='draft'`).run(operator, docNo);
        if (postedNew.changes === 0) throw businessError('DOC_STATE_CHANGED', '更正草稿状态已变化，请刷新后重试', undefined, 409);
      } else {
        db.prepare("DELETE FROM outbound WHERE doc_no=?").run(docNo);
        db.prepare("DELETE FROM outbound_docs WHERE doc_no=?").run(docNo);
        db.prepare("DELETE FROM outbound_doc_logs WHERE doc_no=?").run(docNo);
      }

      const auditDetail = {
        action: reopen ? 'void-reopen' : 'void-only',
        original_doc_no: orig.doc_no,
        new_doc_no: reopen ? docNo : '',
        original_qty: Object.fromEntries(origQtyByCode),
        new_qty: Object.fromEntries(newQtyByCode),
        stock_snapshot: snapshot,
        retargeted_returns: retargeted
      };
      audit.record({
        user_id: req.user?.id ?? null, username: req.user?.username || '', name: req.user?.name || '',
        role: req.user?.role || '', module: 'outbound', action: 'void', target: orig.doc_no,
        method: req.method, path: req.originalUrl, ip: req.ip, status: 200,
        detail: JSON.stringify(auditDetail)
      });
      if (reopen) {
        logOutboundDoc(docNo, 'confirm-correction', operator,
          { key: 'audit_detail_ob_void_reopen', params: { doc: orig.doc_no, n: retargeted } });
        logOutboundDoc(orig.doc_no, 'void', operator,
          { key: 'audit_detail_ob_void_corrected', params: { time: time.nowUtc(), doc: docNo } });
      } else {
        logOutboundDoc(orig.doc_no, 'void', operator,
          { key: 'audit_detail_ob_void_only', params: { time: time.nowUtc() } });
      }
      result = {
        success: true,
        mode: reopen ? 'reopen' : 'void-only',
        doc_no: reopen ? docNo : '',
        voided_doc_no: orig.doc_no,
        retargeted_returns: retargeted
      };
    });
    tx.immediate();
    try {
      costing.logCorrection({
        kind: reopen ? 'void-reopen' : 'void-only',
        originalDoc: orig.doc_no, newDoc: reopen ? docNo : '',
        operator, before: balBefore, status: 'ok',
      });
    } catch (le) { console.error('重算日志写入失败:', le.message); }
    res.json(result);
  } catch (e) {
    try {
      costing.logCorrection({
        kind: reopen ? 'void-reopen' : 'void-only',
        originalDoc: orig.doc_no, newDoc: reopen ? docNo : '',
        operator, before: balBefore, status: 'failed', message: e.message,
      });
    } catch (le) { console.error('重算日志写入失败:', le.message); }
    if (isBusy(e)) return res.status(409).json(busyBody());
    res.status(e.status || 400).json(withEn({ error: e.message, code: e.code || 'CORRECTION_CONFIRM_FAILED', details: e.details }));
  }
});

module.exports = router;
