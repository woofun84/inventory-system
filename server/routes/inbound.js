/**
 * 入库相关接口（单据列表、明细、草稿/确认/更正）
 */
const express = require('express');
const db = require('../db');
const costing = require('../services/costing');
const { requirePerm } = require('../middleware/auth');
const {
  getAvailableStock,
  validateInboundReturnStock,
  resolveOrderLineId,
  resolveUniqueOrderLineId,
  getPurchaseScopeLines,
  loadPurchaseReturnOrigin,
  loadPurchaseReturnScope,
  validatePurchaseReturnLines,
  getPurchaseReturnedQtyByLine,
} = require('../services/stock');
const docno = require('../services/docno');
const time = require('../services/time');
const sign = require('../services/sign');
const audit = require('../services/audit');
const { packDetail } = require('../services/logdetail');
const { maskRows } = require('../services/price-mask');
const { isBusy, busyBody, businessError, withEn, stockBody, bizBody } = require('../services/errors');

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
  // 采购退货落库时用保守核销：只在「采购单 + 物料（合同为空或一致）」唯一命中时回填，
  // 多条候选保持 0，避免把退货错记到别的采购明细行上。
  const resolveLine = (poNo, code, contractNo) => {
    // 采购入库：前端在「采购明细行」下拉里显式选中的行优先，
    // 避免同一合同下同物料跨多张采购单时被自动解析到别的行。
    const explicit = Number(l.order_line_id) || 0;
    if (docLike.txn_type !== '采购退货' && explicit > 0) return explicit;
    return docLike.txn_type === '采购退货'
      ? resolveUniqueOrderLineId(poNo, code, contractNo)
      : resolveOrderLineId(poNo, code, contractNo);
  };
  if (docLike.return_tier === 'none') {
    return {
      origin_line_id: 0,
      price: sign.normalizePrice(l.price),
      po_no: l.po_no !== undefined ? String(l.po_no || '') : (defaults.po_no || ''),
      contract_no: l.contract_no !== undefined ? String(l.contract_no || '') : (defaults.contract_no || ''),
      order_line_id: resolveLine(
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
      ? (src.order_line_id || resolveLine(poNo, l.code, contractNo))
      : resolveLine(poNo, l.code, contractNo),
  };
}

const router = express.Router();

// ==================== 入库单据（草稿/确认/作废 状态流转） ====================
// 设计要点：
//  1. inbound_docs 是单据头，inbound 明细行通过 doc_no 关联
//  2. 草稿态明细行 status='draft'，不计入库存；确认后 status='posted'，纳入库存
//  3. 已过账单据不可直接修改，应通过「更正（作废重开）」处理
//  4. 权限：inbound 模块的 view/create/edit/delete + confirm 动作

// 生成入库单据号（采购入库 GRN / 采购退货 RET，规则见 services/docno.js，前缀可在参数设置中修改）
function genInboundDocNo(date, txnType) {
  return docno.genDocNo(txnType === '采购退货' ? 'ret' : 'grn', date);
}

// 记录单据操作日志
function logInboundDoc(docNo, action, operator, detail) {
  const d = packDetail(detail);
  db.prepare("INSERT INTO inbound_doc_logs (doc_no, action, operator, detail, detail_json) VALUES (?, ?, ?, ?, ?)")
    .run(docNo, action, operator || '', d.text, d.json);
}

// ==================== 采购入库：来源归属 + 超收校验（2026-11 第八批） ====================
// 归属：每行物料/采购行必须属于单头的采购单或合同，隔离「单头与明细不相干」的组合。
// 超收：同一采购行在本单拆成多行时按行合计，与行级未到货比较；默认拦截，
//       显式 over_receipt_confirm=true 才放行，并写单据审计留痕。
// 豁免：零星入库（不关联采购行）、退货继承行（origin_line_id > 0）、更正单从原单继承的行（历史数据）。
// 更正单：来源取继承的原单单头，归属只约束「本次新加的行」；超收照常校验，
//         但基准要排除原单自身的过账量（确认后原单作废，这部分额度要还回来）。
function validatePurchaseInboundScope(docLike, lines, opts) {
  const options = opts || {};
  if (!docLike || docLike.txn_type !== '采购入库') return [];
  const corrNo = String(docLike.corrects_doc_no || '').trim();
  const poNo = String(docLike.po_no || '').trim();
  const contractNo = String(docLike.contract_no || '').trim();
  if (!poNo && !contractNo) {
    if (options.requireSource && !corrNo) throw routeFail('SOURCE_REQUIRED', '采购入库必须选择采购单或合同后再确认');
    return [];
  }
  const scopeLines = getPurchaseScopeLines(poNo ? { poNo } : { contractNo }, { excludeDocNo: corrNo || undefined });
  const sourceLabel = poNo ? `采购单 ${poNo}` : `合同 ${contractNo}`;
  const byId = new Map(scopeLines.map(l => [String(l.id), l]));
  const codes = new Set(scopeLines.map(l => String(l.code)));
  const groups = new Map();
  const outside = [];
  lines.forEach((l, i) => {
    const code = String(l.code || '').trim();
    if (!code) return; // 空行由前端忽略，不计入行号与超收
    // 更正单：从原单继承的行按行身份键匹配，豁免归属校验（即使其采购归属已不在当前来源范围内也不重选）
    const inherited = !!corrNo && !!findOriginLine(corrNo, correctionLineKey(l));
    if (!inherited && Number(l.origin_line_id) > 0) return;
    const oid = Number(l.order_line_id) || 0;
    let key;
    let base;
    if (oid > 0) {
      const ol = byId.get(String(oid));
      if (!ol || (!inherited && code && String(ol.code) !== code)) {
        // 继承行若在来源里查不到基准，不参与超收，也不要求重选
        if (!inherited) outside.push({ line_no: i + 1, code });
        return;
      }
      key = 'OL:' + oid;
      base = Number(ol.unreceived_qty) || 0;
    } else {
      if (!codes.has(code)) {
        if (!inherited) outside.push({ line_no: i + 1, code });
        return;
      }
      key = 'MC:' + code;
      base = scopeLines
        .filter(x => String(x.code) === code)
        .reduce((s, x) => s + (Number(x.unreceived_qty) || 0), 0);
    }
    if (!groups.has(key)) {
      groups.set(key, { line_no: i + 1, code, order_line_id: oid, unreceived: base, requested: 0 });
    }
    groups.get(key).requested += Math.abs(Number(l.qty) || 0);
  });
  if (outside.length) {
    const first = outside[0];
    const e = routeFail('LINE_NOT_IN_SOURCE',
      `第 ${first.line_no} 行物料 ${first.code || '（空）'} 不属于${sourceLabel}` +
      (outside.length > 1 ? `（共 ${outside.length} 行）` : ''));
    e.details = outside;
    throw e;
  }
  const round2 = v => Math.round(v * 100) / 100;
  const overs = [...groups.values()]
    .filter(g => g.requested > g.unreceived + 1e-6)
    .map(g => ({
      line_no: g.line_no, code: g.code, order_line_id: g.order_line_id,
      unreceived: round2(g.unreceived), requested: round2(g.requested),
      over: round2(g.requested - g.unreceived),
    }));
  if (!overs.length) return [];
  if (!options.allowOver) {
    const first = overs[0];
    const e = routeFail('OVER_RECEIPT',
      `物料 ${first.code} 超收：该采购行未到货 ${first.unreceived}，本单填 ${first.requested}，超出 ${first.over}` +
      (overs.length > 1 ? `（共 ${overs.length} 个采购行超收）` : ''));
    e.details = overs;
    throw e;
  }
  return overs;
}

// 超收行明细（结构化，前端按当前语言拼装）
function overReceiptLineParams(overs) {
  return (overs || []).map(o => ({
    key: 'audit_detail_over_line',
    params: {
      code: o.code,
      line: o.order_line_id || '-',
      unreceived: o.unreceived,
      requested: o.requested,
      over: o.over,
    },
  }));
}

// ==================== 入库更正：作废重开（2026-11 第七批） ====================
// 用户点「更正」→ 生成预填草稿 → 确认后：
//  1. 原单由系统置为作废（status='voided'，明细行同样置 voided），不参与任何计算；
//  2. 有明细 → 新单直接过账生效，继承原单日期/类型/供应商/采购单/合同/明细；
//     一行不剩 → 只作废原单，不生成新单（整单不要了）；
//  3. 原单已确认的采购退货单自动改指向新单（头 origin_doc_no + 行 origin_line_id）；
//  4. 不产生红冲单、不产生差额调整单，也不提供任何强制放行入口。
const CORRECTION_SOURCE_TYPES = ['采购入库', '零星入库', '采购退货'];

function isCorrectionDraft(docLike) {
  return !!docLike && docLike.status === 'draft' && String(docLike.corrects_doc_no || '').trim() !== '';
}

// 跨版本行身份：采购退货行优先用原入库行 ID；其次采购明细核销号；再按采购单/物料/合同；最后物料
function correctionLineKey(l) {
  const rid = Number(l && l.origin_line_id) || 0;
  if (rid > 0) return 'RL:' + rid;
  const oid = Number(l && l.order_line_id) || 0;
  if (oid > 0) return 'OL:' + oid;
  const po = String((l && l.po_no) || '').trim();
  const code = String((l && l.code) || '').trim();
  const ct = String((l && l.contract_no) || '').trim();
  if (po) return 'PC:' + po + '|' + code + '|' + ct;
  return 'MC:' + code;
}

function inPlaceholders(arr) {
  return arr.map(() => '?').join(',');
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
  if (docLike.status !== 'posted') {
    return deny('DOC_NOT_POSTED', '只有已过账的单据可以更正');
  }
  return { eligible: true, code: '', reason: '' };
}

// 更正预填：原单已过账明细，数量取绝对值（采购退货存储为负），单价/采购归属/原行关联全继承
function correctionLines(docLike, includeDraft = false) {
  return db.prepare(`SELECT i.id, i.code, i.qty, i.price, i.po_no, i.contract_no, i.order_line_id,
      i.origin_line_id, i.remarks, m.name AS material_name, m.spec AS material_spec,
      m.unit AS material_unit, m.brand AS material_brand
    FROM inbound i LEFT JOIN materials m ON m.code = i.code
    WHERE i.doc_no = ? ${includeDraft ? '' : "AND i.status = 'posted'"}
    ORDER BY i.id ASC`).all(docLike.doc_no).map(l => ({
      ...l,
      qty: sign.absQty(l.qty),
      price: sign.storedAbs(l.price),
      origin_line_id: Number(l.origin_line_id) || 0,
      line_key: correctionLineKey(l),
    }));
}

// 更正草稿「无改动」判定：行数、每行数量、单头可改字段（备注）与原单完全一致。
// 整单作废（草稿无行）属于改动，不在此列。保存草稿与确认更正共用这一套口径。
function correctionUnchanged(draftDoc, draftLines, origDoc, origLines) {
  const live = (draftLines || []).filter(l => sign.absQty(l.qty) > 0);
  const base = (origLines || []).filter(l => sign.absQty(l.qty) > 0);
  if (live.length === 0 || live.length !== base.length) return false;
  const baseByKey = new Map(base.map(l => [correctionLineKey(l), sign.absQty(l.qty)]));
  for (const l of live) {
    const k = correctionLineKey(l);
    if (!baseByKey.has(k)) return false;
    if (Math.abs(sign.absQty(l.qty) - baseByKey.get(k)) > 1e-9) return false;
  }
  const remarksNow = String(draftDoc.remarks || '').trim();
  return String(origDoc.remarks || '').trim() === remarksNow;
}

function correctionBlock(docLike) {
  const elig = correctionEligibility(docLike);
  const draft = db.prepare("SELECT doc_no FROM inbound_docs WHERE corrects_doc_no=? AND status='draft' ORDER BY created_at DESC LIMIT 1").get(docLike.doc_no);
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

// 同单内行身份不得重复（前端先拦一次，后端再拦一次）
function validateCorrectionKeys(lines) {
  const seen = new Map();
  (lines || []).forEach((l, i) => {
    const key = correctionLineKey(l);
    if (seen.has(key)) {
      const prev = seen.get(key);
      throw routeFail('DUPLICATE_CORRECTION_LINE',
        `第 ${i + 1} 行与第 ${prev + 1} 行是同一采购行/物料（${key}），同单内不能重复`);
    }
    seen.set(key, i);
  });
  return seen;
}

function findOriginLine(origDocNo, key) {
  if (!origDocNo) return null;
  const rows = db.prepare("SELECT * FROM inbound WHERE doc_no=? AND status='posted' ORDER BY id").all(origDocNo);
  return rows.find(r => correctionLineKey(r) === key) || null;
}

// 更正草稿保存时服务端推导单价与采购归属（单价只读，忽略前端传值）
function deriveCorrectionLine(docLike, l) {
  const key = correctionLineKey(l);
  const baseLine = findOriginLine(String(docLike.corrects_doc_no || ''), key);
  if (baseLine) {
    return {
      price: sign.storedAbs(baseLine.price),
      po_no: baseLine.po_no || '',
      contract_no: baseLine.contract_no || '',
      order_line_id: Number(baseLine.order_line_id) || 0,
      origin_line_id: Number(baseLine.origin_line_id) || 0,
    };
  }
  // 新增行：按采购单/合同 + 物料的采购明细价，找不到回退物料期初价
  const poNo = String(l.po_no || docLike.po_no || '');
  const contractNo = String(l.contract_no || docLike.contract_no || '');
  const orderLineId = Number(l.order_line_id) || resolveOrderLineId(poNo, l.code, contractNo);
  let price = Number(l.price);
  if (!Number.isFinite(price) || price < 0) price = 0;
  if (orderLineId > 0) {
    const ol = db.prepare("SELECT order_price FROM order_lines WHERE id=?").get(orderLineId);
    if (ol && Number.isFinite(Number(ol.order_price))) price = sign.storedAbs(ol.order_price);
  } else {
    const mat = db.prepare("SELECT opening_price FROM materials WHERE code=?").get(l.code);
    if (mat && Number.isFinite(Number(mat.opening_price))) price = sign.storedAbs(mat.opening_price);
  }
  return {
    price: sign.normalizePrice(price),
    po_no: poNo,
    contract_no: contractNo,
    order_line_id: orderLineId,
    origin_line_id: Number(l.origin_line_id) || 0,
  };
}


// 无价格权限时保存草稿的单价由服务端推导（前端拿不到单价，不能用它回写 0）：
// 退货继承原入库行 → 采购明细行取订单价 → 编辑既有行保留原价 → 新增行回退物料期初价。
function hiddenPricePool(docNo) {
  const pool = new Map();
  db.prepare('SELECT * FROM inbound WHERE doc_no=? ORDER BY id ASC').all(docNo).forEach(r => {
    const k = correctionLineKey(r);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(r.price);
  });
  return pool;
}

function hiddenLinePrice(docLike, l, resolved, pool) {
  const isReturn = docLike.txn_type === '采购退货';
  const tier = isReturn ? normalizeReturnTier(docLike.return_tier) : '';
  // 关联档退货：单价随原入库行，resolveReturnLine 已从来源行取到
  if (isReturn && tier !== 'none' && Number(resolved.origin_line_id) > 0) {
    return sign.storedAbs(resolved.price);
  }
  const oid = Number(resolved.order_line_id) || 0;
  if (oid > 0) {
    const ol = db.prepare('SELECT order_price FROM order_lines WHERE id=?').get(oid);
    if (ol && Number.isFinite(Number(ol.order_price))) return sign.storedAbs(ol.order_price);
  }
  // 编辑草稿：按行身份取回原单价（同键多行按顺序消耗，避免重复物料被串价）
  const bucket = pool && pool.get(correctionLineKey({ ...resolved, code: l.code }));
  if (bucket && bucket.length) return sign.storedAbs(bucket.shift());
  // 新增行：回退物料期初单价（与前端默认带价口径一致）
  const mat = db.prepare('SELECT opening_price FROM materials WHERE code=?').get(l.code);
  if (mat && Number.isFinite(Number(mat.opening_price))) return sign.storedAbs(mat.opening_price);
  return sign.normalizePrice(l.price);
}

// 获取入库单据列表（支持按状态/关键字/日期筛选）
router.get('/api/inbound-docs', requirePerm('inbound', 'view'), (req, res) => {
  const { status, keyword, dateFrom, dateTo, txnType, excludeType, includeHistory } = req.query;
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
  // 默认不显示作废单；includeHistory=1（历史版本开关 / 关键字搜索）时才返回
  if (String(includeHistory) !== '1') {
    sql += " AND d.status <> 'voided'";
  }
  if (keyword) {
    sql += " AND (d.doc_no LIKE ? OR d.supplier LIKE ? OR d.handler LIKE ? OR d.po_no LIKE ? OR d.contract_no LIKE ? OR d.remarks LIKE ?)";
    const kw = '%' + keyword + '%';
    params.push(kw, kw, kw, kw, kw, kw);
  }
  sql += " ORDER BY d.date DESC, d.created_at DESC";
  res.json(maskRows(req, db.prepare(sql).all(...params), ['total_amount']));
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
  // 单号在事务内生成，避免多实例并发建单时撞号
  let docNo = body.doc_no ? String(body.doc_no).trim() : '';
  try {
    // 空草稿兜底：无任何有效明细，且单头无关键字段（供应商/来源/备注/原单）时拒绝建单
    const validLineCount = Array.isArray(body.lines) ? body.lines.filter(l => l && l.code).length : 0;
    const hasHeaderContent = [body.supplier, body.po_no, body.contract_no, body.origin_doc_no,
      body.remarks, body.return_reason].some(v => String(v || '').trim());
    if (validLineCount === 0 && !hasHeaderContent) {
      return res.status(400).json({ error: '未填写任何内容，已拒绝创建空草稿', code: 'EMPTY_DRAFT' });
    }

    // 采购退货：先校验三档单头并继承供应商/原单号
    const hdr = prepareReturnHeader(body, txnType, req.user);

    // 单头 + 明细同一事务：明细校验失败时回滚单头，避免留下空草稿
    const createdTx = db.transaction(() => {
    if (!docNo) docNo = genInboundDocNo(date, txnType);
    if (db.prepare("SELECT 1 AS ok FROM inbound_docs WHERE doc_no=?").get(docNo)) {
      throw businessError('DOC_NO_CONFLICT', `单据号 ${docNo} 已被其他请求占用，请重试`, undefined, 409);
    }
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
      const pricePool = req.canViewPrice ? null : new Map();
      validLines.forEach(l => {
        const qty = sign.normalizeQty(txnType, l.qty);
        const resolved = resolveReturnLine(docLike, l, sources, { po_no: hdr.po_no, contract_no: hdr.contract_no });
        const price = req.canViewPrice ? resolved.price : hiddenLinePrice(docLike, l, resolved, pricePool);
        // 把到货精确核销到具体采购明细行；关联档直接继承原入库行的核销号
        stmt.run({
          date, grn_no: docNo, doc_no: docNo, code: l.code, qty, price,
          supplier: hdr.supplier, handler: body.handler || '',
          remarks: l.remarks || '', po_no: resolved.po_no,
          contract_no: resolved.contract_no, txn_type: txnType,
          order_line_id: resolved.order_line_id, origin_line_id: resolved.origin_line_id
        });
      });
    }
    });
    createdTx.immediate();

    logInboundDoc(docNo, 'create', req.user?.name || req.user?.username, { key: 'audit_detail_ib_create' });
    res.json({ success: true, doc_no: docNo });
  } catch (e) {
    if (isBusy(e)) return res.status(409).json(busyBody());
    if (/UNIQUE constraint failed: inbound_docs\.doc_no/.test(String(e.message || ''))) {
      return res.status(409).json(withEn({
        code: 'DOC_NO_CONFLICT',
        error: `单据号 ${docNo} 已被其他请求占用，请重试`,
      }));
    }
    res.status(e.status || 400).json(withEn(bizBody(e, 'INBOUND_DOC_CREATE_FAILED')));
  }
});

// 获取入库单据详情（含明细行 + 操作日志 + 更正/作废信息）
router.get('/api/inbound-docs/:docNo', requirePerm('inbound', 'view'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });

  const lines = db.prepare(`SELECT i.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM inbound i LEFT JOIN materials m ON i.code = m.code
    WHERE i.doc_no=? ORDER BY i.id ASC`).all(docNo);

  const logs = db.prepare("SELECT * FROM inbound_doc_logs WHERE doc_no=? ORDER BY id ASC").all(docNo);

  // 汇总
  const summary = {
    line_count: lines.length,
    total_qty: lines.reduce((s, l) => s + Number(l.qty || 0), 0),
    total_amount: lines.reduce((s, l) => s + Number(l.amount || l.qty * l.price || 0), 0)
  };

  // 关联退货单（单据级）：单头 origin_doc_no 匹配，或任一退货明细行核销到本入库单的明细行。
  // 两者取或避免「单头为空、关系只在明细行」的漏单；GROUP BY doc_no 保证一张单只出现一次。
  // 含草稿/已作废；数量、金额按存储值有符号返回（采购退货为负），不做绝对值。
  const relatedReturns = db.prepare(`
    SELECT d.doc_no, d.date, d.txn_type, d.status,
      COALESCE(d.supplier,'') AS supplier, COALESCE(d.handler,'') AS handler,
      COUNT(i.id) AS line_count,
      COALESCE(SUM(i.qty), 0) AS total_qty,
      COALESCE(SUM(i.amount), 0) AS total_amount
    FROM inbound_docs d LEFT JOIN inbound i ON i.doc_no = d.doc_no
    WHERE d.txn_type = '采购退货' AND d.doc_no <> '' AND (
      d.origin_doc_no = ?
      OR EXISTS (SELECT 1 FROM inbound r WHERE r.doc_no = d.doc_no
        AND r.origin_line_id IN (SELECT id FROM inbound WHERE doc_no = ?))
    )
    GROUP BY d.doc_no
    ORDER BY d.date DESC`).all(docNo, docNo);
  // 同日单号按修订号数字排序，保证 -R2 排在 -R10 之前
  relatedReturns.sort((a, b) => {
    const d = String(b.date || '').localeCompare(String(a.date || ''));
    return d !== 0 ? d : docno.compareDocNo(b.doc_no, a.doc_no);
  });

  // 无价格权限：明细单价/金额、合计金额、关联退货金额整组不下发（数量类保留）
  if (!req.canViewPrice) {
    lines.forEach(l => { delete l.price; delete l.amount; });
    delete summary.total_amount;
    relatedReturns.forEach(r => { delete r.total_amount; });
  }
  res.json({ ...doc, lines, logs, summary, correction: correctionBlock(doc), related_returns: relatedReturns });
});

// 保存入库单据明细行（草稿态可操作）
// 整体替换：前端传完整明细行数组，后端先删旧行再插新行
router.put('/api/inbound-docs/:docNo/lines', requirePerm('inbound', 'edit'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '已过账/作废的单据不能修改明细', code: 'DOC_NOT_DRAFT' });

  // 更正草稿：明细行存「更正后目标数量」，单价/采购归属只读，由服务端推导
  if (isCorrectionDraft(doc)) {
    const rawLines = (Array.isArray(req.body.lines) ? req.body.lines : []).filter(l => l.code);
    const targets = rawLines.filter(l => Number(l.qty) > 0);
    try {
      if (targets.length > 0) validateCorrectionKeys(targets);
      // 更正采购入库：新增行必须落在继承来源（原单采购单/合同）的采购行范围内，继承行豁免；
      // 超收与普通采购入库同一套软拦截（over_receipt_confirm 显式放行 + 审计）
      const overReceipt = validatePurchaseInboundScope(doc, targets, {
        requireSource: false,
        allowOver: req.body.over_receipt_confirm === true,
      });
      const isReturn = isPurchaseReturnDoc(doc);
      const returnTier = isReturn ? normalizeReturnTier(doc.return_tier) : '';
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM inbound WHERE doc_no=?").run(docNo);
        const stmt = db.prepare(`INSERT INTO inbound (date, grn_no, doc_no, code, qty, price, supplier, handler, remarks,
            po_no, contract_no, txn_type, status, order_line_id, origin_line_id)
          VALUES (@date, @grn_no, @doc_no, @code, @qty, @price, @supplier, @handler, @remarks,
            @po_no, @contract_no, @txn_type, 'draft', @order_line_id, @origin_line_id)`);
        targets.forEach(l => {
          const derived = deriveCorrectionLine(doc, l);
          if (isReturn && returnTier !== 'none' && derived.origin_line_id <= 0) {
            throw routeFail('RETURN_ORIGIN_REQUIRED', `物料 ${l.code} 缺少原入库行关联，无法更正退货单`);
          }
          stmt.run({
            date: l.date || doc.date, grn_no: docNo, doc_no: docNo, code: l.code,
            qty: sign.normalizeQty(doc.txn_type, Number(l.qty)), price: derived.price,
            supplier: doc.supplier, handler: doc.handler, remarks: l.remarks || '',
            po_no: derived.po_no, contract_no: derived.contract_no, txn_type: doc.txn_type,
            order_line_id: derived.order_line_id, origin_line_id: derived.origin_line_id
          });
        });
        const updates = {};
        if (req.body.remarks !== undefined) updates.remarks = req.body.remarks;
        if (Object.keys(updates).length > 0) {
          const sets = Object.keys(updates).map(k => `${k}=@${k}`).join(', ');
          db.prepare(`UPDATE inbound_docs SET ${sets} WHERE doc_no=@doc_no`).run({ ...updates, doc_no: docNo });
        }
        logInboundDoc(docNo, 'edit', req.user?.name || req.user?.username,
          targets.length === 0
            ? { key: 'audit_detail_ib_clear' }
            : { key: 'audit_detail_ib_save_targets', params: { n: targets.length } });
        if (overReceipt.length) {
          logInboundDoc(docNo, 'over-receipt', req.user?.name || req.user?.username,
            { key: 'audit_detail_ib_save_over', params: { list: overReceiptLineParams(overReceipt) } });
        }
      });
      tx();
      return res.json({ success: true, target_count: targets.length, over_receipt: overReceipt });
    } catch (e) {
      return res.status(e.status || 400).json({
        error: e.message, code: e.code || 'CORRECTION_LINES_SAVE_FAILED', details: e.details || undefined,
      });
    }
  }

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

    // 采购入库：来源归属 + 超收（草稿也校验；无来源的存量草稿允许继续保存）
    const effPoNoCheck = req.body.po_no !== undefined ? req.body.po_no : doc.po_no;
    const effContractNoCheck = req.body.contract_no !== undefined ? req.body.contract_no : doc.contract_no;
    const overReceipt = validatePurchaseInboundScope(
      { ...doc, po_no: effPoNoCheck, contract_no: effContractNoCheck },
      lines,
      { requireSource: false, allowOver: req.body.over_receipt_confirm === true }
    );

    // 无价格权限：删除旧行前先留存原单价池，保存时按行身份取回，避免前端回写 0
    const pricePool = req.canViewPrice ? null : hiddenPricePool(docNo);

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
        const effDoc = { ...doc, return_tier: normalizeReturnTier(doc.return_tier) };
        const resolved = resolveReturnLine(
          effDoc,
          l, sources, { po_no: effPoNo, contract_no: effContractNo }
        );
        const price = req.canViewPrice ? resolved.price : hiddenLinePrice(effDoc, l, resolved, pricePool);
        stmt.run({
          date: l.date || doc.date, grn_no: docNo, doc_no: docNo,
          code: l.code, qty, price,
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
      logInboundDoc(docNo, 'edit', req.user?.name || req.user?.username,
        { key: 'audit_detail_ib_save', params: { n: validLines.length } });
    });
    tx();
    if (overReceipt.length) {
      logInboundDoc(docNo, 'over-receipt', req.user?.name || req.user?.username,
        { key: 'audit_detail_ib_save_over', params: { list: overReceiptLineParams(overReceipt) } });
    }
    res.json({ success: true, over_receipt: overReceipt });
  } catch (e) {
    const body = { error: e.message, code: e.code || 'INBOUND_LINES_SAVE_FAILED' };
    if (e.details) body.details = e.details;
    res.status(e.status || 400).json(body);
  }
});

// 确认入库（过账）—— 草稿 → posted，明细行 status → posted，库存流水生效
router.post('/api/inbound-docs/:docNo/confirm', requirePerm('inbound', 'edit'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '只有草稿单据可以确认', code: 'DOC_NOT_DRAFT' });
  if (isCorrectionDraft(doc)) {
    return res.status(400).json({ error: '更正草稿必须走「确认更正」接口', code: 'USE_CORRECTION_CONFIRM' });
  }

  // 采购入库/采购退货必须有供应商；零星入库允许空供应商
  if (['采购入库', '采购退货'].includes(doc.txn_type) && !String(doc.supplier || '').trim()) {
    return res.status(400).json({ error: '采购入库/采购退货必须填写供应商', code: 'SUPPLIER_REQUIRED' });
  }

  let overReceipt = [];
  let lineCount = 0;
  const operator = req.user?.name || req.user?.username || '';

  try {
    // 采购退货：确认时再次校验档位/权限/原因（只读单头，放在事务外）
    validateReturnTierHeader(doc, req.user);
    // BEGIN IMMEDIATE：状态守卫、超收/可退量校验、库存校验与写流水在同一临界区
    const tx = db.transaction(() => {
      // 事务内重读明细，避免读到过期的草稿行
      const lines = db.prepare("SELECT * FROM inbound WHERE doc_no=?").all(docNo);
      if (lines.length === 0) throw businessError('NO_LINES', '单据没有明细行，无法确认');
      // 采购入库：来源归属 + 超收（确认强制要求来源；超收需前端二次确认后显式放行）
      overReceipt = validatePurchaseInboundScope(doc, lines, {
        requireSource: true,
        allowOver: req.body.over_receipt_confirm === true,
      });
      if (isPurchaseReturnDoc(doc) && normalizeReturnTier(doc.return_tier) !== 'none') {
        const sources = validatePurchaseReturnLines(doc, lines);
        // 关联档单价必须等于原入库行单价，防止绕过前端改写成本
        lines.forEach(l => {
          const src = sources.get(String(l.origin_line_id));
          if (!src) return; // validatePurchaseReturnLines 已抛出
          if (Math.abs(sign.storedAbs(l.price) - src.price) > 1e-6) {
            throw routeFail('RETURN_PRICE_MISMATCH', `物料 ${l.code} 的退货单价必须继承原入库行单价 ${src.price}`);
          }
        });
      }
      // 采购退货库存校验：负库存硬拦，不提供强制放行
      validateInboundReturnStock(lines);
      // 校验全部通过后再翻转单据状态：状态守卫保证跨实例重复确认只有第一个能改到行
      // （必须先校验后改状态，否则退货单会把自己算进“已过账退货量”而误判超退）
      const posted = db.prepare(`UPDATE inbound_docs SET status='posted', confirmed_by=?, confirmed_at=datetime('now')
        WHERE doc_no=? AND status='draft'`).run(operator, docNo);
      if (posted.changes === 0) {
        throw businessError('DOC_STATE_CHANGED', '单据已被其他请求处理（可能已确认或作废），请刷新后重试', undefined, 409);
      }
      // 明细行过账
      db.prepare("UPDATE inbound SET status='posted' WHERE doc_no=?").run(docNo);
      // 统一成本服务：生成入库/退货流水并刷新结存（幂等，按核算顺序重算该物料）
      costing.postInboundDoc(doc, lines);
      logInboundDoc(docNo, 'confirm', operator,
        { key: 'audit_detail_ib_confirm', params: { n: lines.length } });
      lineCount = lines.length;
    });
    tx.immediate();
    if (overReceipt.length) {
      logInboundDoc(docNo, 'over-receipt', operator,
        { key: 'audit_detail_ib_confirm_over', params: { list: overReceiptLineParams(overReceipt) } });
    }
    res.json({ success: true, line_count: lineCount, over_receipt: overReceipt });
  } catch (e) {
    if (e.stockError) return res.status(400).json(stockBody(e));
    if (isBusy(e)) return res.status(409).json(busyBody());
    res.status(e.status || 400).json(bizBody(e, 'INBOUND_CONFIRM_FAILED'));
  }
});

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

// ==================== 入库更正接口（2026-11 第七批：作废重开） ====================

// 更正可用性 + 预填（详情页按钮据此显示）
router.get('/api/inbound-docs/:docNo/correction-info', requirePerm('inbound', 'view'), (req, res) => {
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(req.params.docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });
  const lines = correctionLines(doc, doc.status === 'draft');
  if (!req.canViewPrice) lines.forEach(l => { delete l.price; });
  res.json({
    doc,
    original_date: doc.date,
    txn_type: doc.txn_type,
    lines,
    correction: correctionBlock(doc),
  });
});

// 创建更正草稿（同一原单只允许一张未确认草稿）
router.post('/api/inbound-docs/:docNo/correction', requirePerm('inbound', 'edit'), (req, res) => {
  const orig = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(req.params.docNo);
  if (!orig) return res.status(404).json({ error: '入库单据不存在' });

  const elig = correctionEligibility(orig);
  if (!elig.eligible) return res.status(400).json({ error: elig.reason, code: elig.code });

  const existing = db.prepare(`SELECT doc_no FROM inbound_docs
    WHERE corrects_doc_no=? AND status='draft' ORDER BY created_at DESC LIMIT 1`).get(orig.doc_no);
  if (existing) {
    return res.status(409).json({
      error: `该单已有未确认更正草稿 ${existing.doc_no}，请先确认或删除`,
      code: 'CORRECTION_DRAFT_EXISTS',
      doc_no: existing.doc_no
    });
  }

  const body = req.body || {};
  // 新单继承原单的开单日期与类型
  const date = orig.date;
  const txnType = orig.txn_type;
  const docNo = body.doc_no || docno.genRevisionDocNo(orig.doc_no);
  if (db.prepare("SELECT doc_no FROM inbound_docs WHERE doc_no=?").get(docNo)) {
    return res.status(400).json({ error: '单据号已存在: ' + docNo, code: 'DOC_NO_EXISTS' });
  }

  const prefill = correctionLines(orig);
  const operator = req.user?.name || req.user?.username || '';
  const isReturn = isPurchaseReturnDoc(orig);

  try {
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO inbound_docs (doc_no, date, txn_type, supplier, handler, po_no, contract_no, status,
          remarks, created_by, corrects_doc_no, return_tier, origin_doc_no, return_ref_no, return_reason)
        VALUES (@doc_no, @date, @txn_type, @supplier, @handler, @po_no, @contract_no, 'draft',
          @remarks, @created_by, @corrects_doc_no, @return_tier, @origin_doc_no, @return_ref_no, @return_reason)`)
        .run({
          doc_no: docNo, date, txn_type: txnType,
          supplier: orig.supplier || '', handler: orig.handler || '',
          po_no: orig.po_no || '', contract_no: orig.contract_no || '',
          remarks: body.remarks !== undefined ? body.remarks : '',
          created_by: operator, corrects_doc_no: orig.doc_no,
          return_tier: isReturn ? normalizeReturnTier(orig.return_tier) : '',
          origin_doc_no: isReturn ? (orig.origin_doc_no || '') : '',
          return_ref_no: isReturn ? (orig.return_ref_no || '') : '',
          return_reason: isReturn ? (orig.return_reason || '') : ''
        });
      const stmt = db.prepare(`INSERT INTO inbound (date, grn_no, doc_no, code, qty, price, supplier, handler, remarks,
          po_no, contract_no, txn_type, status, order_line_id, origin_line_id)
        VALUES (@date, @grn_no, @doc_no, @code, @qty, @price, @supplier, @handler, @remarks,
          @po_no, @contract_no, @txn_type, 'draft', @order_line_id, @origin_line_id)`);
      prefill.forEach(l => {
        stmt.run({
          date, grn_no: docNo, doc_no: docNo, code: l.code,
          qty: sign.normalizeQty(txnType, l.qty), price: sign.normalizePrice(l.price),
          supplier: orig.supplier || '', handler: orig.handler || '', remarks: l.remarks || '',
          po_no: l.po_no || '', contract_no: l.contract_no || '', txn_type: txnType,
          order_line_id: Number(l.order_line_id) || 0,
          origin_line_id: Number(l.origin_line_id) || 0
        });
      });
      logInboundDoc(docNo, 'create', operator, { key: 'audit_detail_ib_corr_draft', params: { doc: orig.doc_no } });
      logInboundDoc(orig.doc_no, 'correction-draft', operator, { key: 'audit_detail_ib_corr_created', params: { doc: docNo } });
    });
    tx();
    res.json({ success: true, doc_no: docNo, txn_type: txnType });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code || 'CORRECTION_CREATE_FAILED' });
  }
});

// 确认更正：单事务完成「原单作废 + 下游退货改指向 + 新单过账」
// 明细可全部删光：没有明细时只作废原单、不生成新单（整单不要了）。
// 任何冲突（已退量超过新数量 / 作废使库存转负）一律拒绝，不支持强制放行。
router.post('/api/inbound-docs/:docNo/confirm-correction', requirePerm('inbound', 'edit'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '入库单据不存在' });
  if (!isCorrectionDraft(doc)) {
    return res.status(400).json({ error: '该单据不是更正草稿', code: 'NOT_CORRECTION_DRAFT' });
  }
  if (doc.status !== 'draft') {
    return res.status(400).json({ error: '只有更正草稿可以确认', code: 'DOC_NOT_DRAFT' });
  }

  const orig = db.prepare("SELECT * FROM inbound_docs WHERE doc_no=?").get(doc.corrects_doc_no);
  if (!orig) return res.status(404).json({ error: '被更正的原单不存在' });
  const elig = correctionEligibility(orig);
  if (!elig.eligible) return res.status(400).json({ error: elig.reason, code: elig.code });

  const draftLines = db.prepare("SELECT * FROM inbound WHERE doc_no=? ORDER BY id").all(docNo);
  // 无改动不生成更正：草稿与原单的行数/每行数量/单头备注完全一致时拒绝（绕过前端同样拦住）
  const postedOrigLines = db.prepare("SELECT * FROM inbound WHERE doc_no=? AND status='posted' ORDER BY id").all(orig.doc_no);
  if (correctionUnchanged(doc, draftLines, orig, postedOrigLines)) {
    return res.status(400).json({ error: '没有改动，无需更正', code: 'CORRECTION_UNCHANGED' });
  }
  if (draftLines.length > 0) {
    try {
      validateCorrectionKeys(draftLines);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message, code: e.code || 'DUPLICATE_CORRECTION_LINE' });
    }
  }

  // 更正采购入库：新增行必须落在继承来源（原单采购单/合同）的采购行范围内，继承行豁免；
  // 超收与普通采购入库同一套软拦截，基准排除原单自身过账量（原单即将作废）
  let overReceipt = [];
  if (doc.txn_type === '采购入库' && draftLines.length > 0) {
    try {
      overReceipt = validatePurchaseInboundScope(doc, draftLines, {
        requireSource: false,
        allowOver: req.body.over_receipt_confirm === true,
      });
    } catch (e) {
      return res.status(e.status || 400).json({
        error: e.message, code: e.code || 'LINE_NOT_IN_SOURCE', details: e.details
      });
    }
  }

  // 更正采购退货：新数量必须落在原入库行的剩余可退额度内（把本单自身排除在外）
  if (isPurchaseReturnDoc(orig) && draftLines.length > 0) {
    try {
      validatePurchaseReturnLines(orig, draftLines, orig.doc_no);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message, code: e.code || 'RETURN_QTY_EXCEEDED', details: e.details });
    }
  }

  const origLines = postedOrigLines.filter(l => sign.absQty(l.qty) > 0);
  const newByKey = new Map(draftLines.map(l => [correctionLineKey(l), l]));
  const downstreamReturns = db.prepare(`SELECT doc_no, status FROM inbound_docs
    WHERE txn_type='采购退货' AND origin_doc_no=?`).all(orig.doc_no);

  // 整单作废时不允许存在任何下游退货单：作废单不能被下游选作原单
  if (draftLines.length === 0 && downstreamReturns.length > 0) {
    return res.status(400).json({
      error: `该单挂着退货单 ${downstreamReturns.map(d => d.doc_no).join('、')}，不能整单作废；` +
        '请保留对应明细行，或先删除/更正这些退货单。',
      code: 'DOWNSTREAM_DOCS_EXIST',
      details: { return_docs: downstreamReturns.map(d => d.doc_no) }
    });
  }

  // 冲突 1：已确认退货量 > 新单对应行数量 → 拒绝，提示具体退货单
  const returnStatement = db.prepare(`SELECT DISTINCT d.doc_no FROM inbound r
    JOIN inbound_docs d ON d.doc_no = r.doc_no
    WHERE r.origin_line_id = ? AND r.txn_type = '采购退货' AND d.status = 'posted'`);
  const conflicts = [];
  origLines.forEach(ol => {
    const returned = getPurchaseReturnedQtyByLine(ol.id);
    const target = newByKey.get(correctionLineKey(ol));
    const newQty = target ? sign.absQty(target.qty) : 0;
    if (returned > newQty + 0.0001) {
      conflicts.push({
        code: ol.code,
        original_qty: sign.absQty(ol.qty),
        returned_qty: Number(returned.toFixed(6)),
        new_qty: Number(newQty.toFixed(6)),
        return_docs: returnStatement.all(ol.id).map(r => r.doc_no)
      });
    }
  });
  if (conflicts.length > 0) {
    const msg = conflicts.map(c =>
      `物料 ${c.code}：已确认退货 ${c.returned_qty}，更正后新数量 ${c.new_qty}` +
      (c.return_docs.length ? `（退货单：${c.return_docs.join('、')}）` : '')
    ).join('；');
    return res.status(400).json({
      error: `${msg}。请先更正上述退货单数量后再重新确认。`,
      code: 'RETURN_EXCEEDS_CORRECTED_QTY',
      details: conflicts
    });
  }

  // 冲突 2：作废后库存转负 → 拒绝（含被出库领用消耗的情形）
  const newQtyByCode = new Map();
  draftLines.forEach(l => newQtyByCode.set(l.code, (newQtyByCode.get(l.code) || 0) + (Number(l.qty) || 0)));
  const origQtyByCode = new Map();
  origLines.forEach(l => origQtyByCode.set(l.code, (origQtyByCode.get(l.code) || 0) + (Number(l.qty) || 0)));
  const codes = new Set([...newQtyByCode.keys(), ...origQtyByCode.keys()]);
  const stockErrors = [];
  const snapshot = {};
  codes.forEach(code => {
    const available = getAvailableStock(code);
    const delta = (newQtyByCode.get(code) || 0) - (origQtyByCode.get(code) || 0);
    snapshot[code] = {
      available_before: Number(available.toFixed(6)),
      new_qty: Number((newQtyByCode.get(code) || 0).toFixed(6)),
      original_qty: Number((origQtyByCode.get(code) || 0).toFixed(6)),
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
        '原单数量可能已被出库领用，请先处理相关出库后再重新确认。',
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
      // 事务内复核：跨实例并发退货/更正时，以写锁内最新数据为准
      if (reopen) {
        if (doc.txn_type === '采购入库') {
          overReceipt = validatePurchaseInboundScope(doc, draftLines, {
            requireSource: false,
            allowOver: req.body.over_receipt_confirm === true,
          });
        }
        if (isPurchaseReturnDoc(orig)) {
          validatePurchaseReturnLines(orig, draftLines, orig.doc_no);
        }
        origLines.forEach(ol => {
          const target = newByKey.get(correctionLineKey(ol));
          const newQty = target ? sign.absQty(target.qty) : 0;
          if (getPurchaseReturnedQtyByLine(ol.id) > newQty + 0.0001) {
            throw businessError('RETURN_EXCEEDS_CORRECTED_QTY',
              `物料 ${ol.code}：已确认退货量已超过更正后的新数量 ${newQty}，请先更正相关退货单`);
          }
        });
      }
      // 1) 原单及明细作废（系统设置，用户不能手动作废）
      const voided = db.prepare(`UPDATE inbound_docs SET status='voided', voided_at=datetime('now'), voided_by=?,
          corrected_by_doc_no=? WHERE doc_no=? AND status='posted'`)
        .run(operator, reopen ? docNo : '', orig.doc_no);
      if (voided.changes === 0) {
        throw businessError('DOC_STATE_CHANGED', '原单状态已变化，请刷新后重试', undefined, 409);
      }
      db.prepare("UPDATE inbound SET status='voided' WHERE doc_no=?").run(orig.doc_no);

      // 原单流水置无效；重开时先不重算，等新单在原核算位置落位后一次性重算后续流水
      const ledgerVoid = costing.voidDocLedger('inbound', orig.doc_no, { recompute: !reopen });

      // 2) 下游采购退货改指向新单；行按行身份映射
      let retargeted = 0;
      if (reopen) {
        retargeted = db.prepare(`UPDATE inbound_docs SET origin_doc_no=?
          WHERE txn_type='采购退货' AND origin_doc_no=?`).run(docNo, orig.doc_no).changes;
        if (origLineIds.length > 0) {
          const returnLines = db.prepare(`SELECT id, origin_line_id FROM inbound
            WHERE txn_type='采购退货' AND origin_line_id IN (${inPlaceholders(origLineIds)})`).all(...origLineIds);
          const origById = new Map(origLines.map(l => [l.id, l]));
          const updLine = db.prepare("UPDATE inbound SET origin_line_id=? WHERE id=?");
          returnLines.forEach(r => {
            const ol = origById.get(Number(r.origin_line_id));
            const target = ol ? newByKey.get(correctionLineKey(ol)) : null;
            updLine.run(target ? target.id : 0, r.id);
          });
        }
      }

      // 3) 新单在原单的核算位置生效并触发后续重算；整单作废时删除空白草稿
      if (reopen) {
        db.prepare("UPDATE inbound SET status='posted' WHERE doc_no=?").run(docNo);
        costing.postInboundDoc(doc, draftLines, {
          ...(ledgerVoid.anchor || {}),
          correctionOf: orig.doc_no,
        });
        const postedNew = db.prepare(`UPDATE inbound_docs SET status='posted', confirmed_by=?, confirmed_at=datetime('now')
          WHERE doc_no=? AND status='draft'`).run(operator, docNo);
        if (postedNew.changes === 0) throw businessError('DOC_STATE_CHANGED', '更正草稿状态已变化，请刷新后重试', undefined, 409);
      } else {
        db.prepare("DELETE FROM inbound WHERE doc_no=?").run(docNo);
        db.prepare("DELETE FROM inbound_docs WHERE doc_no=?").run(docNo);
        db.prepare("DELETE FROM inbound_doc_logs WHERE doc_no=?").run(docNo);
      }

      // 4) 留痕：审计 + 单据操作日志
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
        role: req.user?.role || '', module: 'inbound', action: 'void', target: orig.doc_no,
        method: req.method, path: req.originalUrl, ip: req.ip, status: 200,
        detail: JSON.stringify(auditDetail)
      });
      if (reopen) {
        logInboundDoc(docNo, 'confirm-correction', operator,
          { key: 'audit_detail_ib_void_reopen', params: { doc: orig.doc_no, n: retargeted } });
        if (overReceipt.length) {
          logInboundDoc(docNo, 'over-receipt', operator,
            { key: 'audit_detail_ib_confirm_over', params: { list: overReceiptLineParams(overReceipt) } });
        }
        logInboundDoc(orig.doc_no, 'void', operator,
          { key: 'audit_detail_ib_void_corrected', params: { time: time.nowUtc(), doc: docNo } });
      } else {
        logInboundDoc(orig.doc_no, 'void', operator,
          { key: 'audit_detail_ib_void_only', params: { time: time.nowUtc() } });
      }
      result = {
        success: true,
        mode: reopen ? 'reopen' : 'void-only',
        doc_no: reopen ? docNo : '',
        voided_doc_no: orig.doc_no,
        retargeted_returns: retargeted,
        over_receipt: overReceipt
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
