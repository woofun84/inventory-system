/**
 * 库存计算、编号生成、订单辅助等业务函数
 */
const db = require('../db');
const docno = require('./docno');
const sign = require('./sign');

// ==================== 辅助函数 ====================

// ==================== 库存计算统一口径 ====================
// 统一公式：当前库存 = 期初 + Σ入库 - Σ出库 + Σ调整
//   调整数量：正数 = 增加库存（盘盈），负数 = 减少库存（盘亏）
// 位置维度已废弃，不再按位置分账。堆放说明只写备注。

// 物料调整累计（正=增加，负=减少）
function getAdjustTotal(code) {
  return db.prepare('SELECT COALESCE(SUM(qty),0) as v FROM stock_adjustments WHERE code=?').get(code).v;
}

// 计算指定物料的可用库存（总量口径，不分位置）
// excludeOutboundId: 编辑出库时排除自身
// excludeInboundId:  编辑入库（尤其采购退货）时排除自身
// excludeAdjId:      编辑调整时排除本条调整记录自身的调整量
function getAvailableStock(code, excludeOutboundId, excludeInboundId, excludeAdjId) {
  const m = db.prepare('SELECT opening_qty FROM materials WHERE code=?').get(code);
  if (!m) return 0;

  // 入库只统计已过账的行（草稿 draft 不计入库存）
  let inQty = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM inbound WHERE code=? AND status='posted'").get(code).v;
  // 出库只统计已过账的行（草稿 draft 不计入库存）
  let outQty = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM outbound WHERE code=? AND status='posted'").get(code).v;
  // 调整流水：盘盈增加、盘亏减少，计入可用库存
  // （否则盘亏后仍按旧口径放行出库，会击穿账面库存）
  let adjQty = getAdjustTotal(code);

  // 编辑出库：排除本条出库记录自身的扣减
  if (excludeOutboundId) {
    const old = db.prepare('SELECT code, qty FROM outbound WHERE id=?').get(excludeOutboundId);
    if (old && old.code === code) outQty -= (old.qty || 0);
  }

  // 编辑入库：排除本条入库记录自身的贡献（采购退货为负，排除后相当于加回）
  if (excludeInboundId) {
    const old = db.prepare('SELECT code, qty, status FROM inbound WHERE id=?').get(excludeInboundId);
    // 只排除已过账的行（草稿态本来就不计入库存）
    if (old && old.code === code && old.status === 'posted') inQty -= (old.qty || 0);
  }

  // 编辑调整：排除本条调整记录自身的调整量
  // 注意：排除时必须校验 code —— 编辑换物料时，本条记录的旧调整属于原物料，
  // 不能从新物料的调整总量里减掉，否则新物料可用量被错误高估。
  if (excludeAdjId) {
    const old = db.prepare('SELECT code, qty FROM stock_adjustments WHERE id=?').get(excludeAdjId);
    if (old && old.code === code) adjQty -= (old.qty || 0);
  }

  return (m.opening_qty || 0) + inQty - outQty + adjQty;
}

// 校验一批出库请求是否超出可用库存
// 同一批次内同一物料的多行需累计扣减
// 超量时抛出带 stockError 标记的错误，由调用方转成 400 响应
//
// 说明（存量负库存豁免）：若某物料在本次操作前可用量已为负，
// 说明是历史遗留错账。此时不再拦截该物料的出库，
// 以免管理员无法修正历史记录、也无法继续盘亏出库。
// 该豁免只对已经为负的物料生效，不会放过「把正常库存出成负数」的情况。
function validateOutboundStock(items, excludeOutboundId) {
  // 累计本批次每个物料的出库量
  const demand = new Map();
  items.forEach(r => {
    if (!r.code || !r.qty) return;
    // 退库出库（qty 为负）是入库性质，不占用库存
    const qty = Number(r.qty);
    if (qty <= 0) return;
    demand.set(r.code, (demand.get(r.code) || 0) + qty);
  });

  const errors = [];
  demand.forEach((needQty, code) => {
    // 「本次操作前的真实可用量」：不含任何排除，用于判断存量负库存豁免
    const curAvailable = getAvailableStock(code);
    // 编辑场景：排除本条记录自身的扣减后，可用额度才是这条记录能占用的上限
    const available = excludeOutboundId ? getAvailableStock(code, excludeOutboundId) : curAvailable;
    // 历史已是负库存 → 豁免，不再拦截
    // 注意：豁免判断必须用 curAvailable（真实可用量，含本条记录自身），
    // 不能用 available（排除自身后）—— 否则编辑一条本就把库存打成负数的记录时，
    // available 可能恰好 >= 0，导致负库存物料反而无法被修正。
    if (curAvailable < 0) return;
    if (needQty > available) {
      errors.push({
        code,
        requested: needQty,
        available: Math.round(available * 10000) / 10000,
        shortfall: Math.round((needQty - available) * 10000) / 10000
      });
    }
  });

  if (errors.length > 0) {
    const e = new Error('库存不足');
    e.stockError = true;
    e.details = errors;
    throw e;
  }
}

// 校验一批「采购退货」是否超出可用库存
// 采购退货 qty 为负，效果等同于出库，需占用库存
// 同一批次内同物料多行累计；历史负库存豁免；编辑时排除自身
function validateInboundReturnStock(items, excludeInboundId) {
  const demand = new Map();
  items.forEach(r => {
    if (!r.code || !r.qty) return;
    const qty = Number(r.qty);
    // 只校验退货（负数量）；正常入库增加库存，不校验
    if (qty >= 0) return;
    const need = Math.abs(qty);
    demand.set(r.code, (demand.get(r.code) || 0) + need);
  });

  const errors = [];
  demand.forEach((needQty, code) => {
    const curAvailable = getAvailableStock(code); // 真实可用（含本条）
    const available = excludeInboundId
      ? getAvailableStock(code, null, excludeInboundId)
      : curAvailable;
    // 历史已是负库存 → 豁免
    if (curAvailable < 0) return;
    if (needQty > available) {
      errors.push({
        code,
        requested: needQty,
        available: Math.round(available * 10000) / 10000,
        shortfall: Math.round((needQty - available) * 10000) / 10000
      });
    }
  });

  if (errors.length > 0) {
    const e = new Error('库存不足（采购退货）');
    e.stockError = true;
    e.details = errors;
    throw e;
  }
}

// ==================== 领用退库：关联原出库单（2C） ====================
// 可退量口径 = 原出库行数量 - 已退数量
// 「已退」只统计「已过账」的退库行：草稿不占用可退额度，作废/删除自然不受影响，
// 也避免两张草稿互相锁死同一原行的可退量。
const RETURN_TXN_TYPE = '退库出库';

function bizError(code, message) {
  const e = new Error(message);
  e.code = code;
  e.status = 400;
  return e;
}

// 原出库行累计已退数量（可排除当前正在编辑的退库单自身）
function getReturnedQtyByLine(originLineId, excludeDocNo) {
  let sql = `SELECT COALESCE(SUM(ABS(o.qty)),0) AS v FROM outbound o
    JOIN outbound_docs d ON d.doc_no = o.doc_no
    WHERE o.origin_line_id = ? AND o.txn_type = ?
      AND d.status = 'posted'`;
  const args = [Number(originLineId) || 0, RETURN_TXN_TYPE];
  if (excludeDocNo) { sql += ' AND o.doc_no <> ?'; args.push(excludeDocNo); }
  return Number(db.prepare(sql).get(...args).v || 0);
}

// 校验原出库单可作为退库来源
function loadReturnableOrigin(originDocNo) {
  const doc = db.prepare('SELECT * FROM outbound_docs WHERE doc_no=?').get(originDocNo);
  if (!doc) throw bizError('ORIGIN_DOC_NOT_FOUND', `原出库单不存在: ${originDocNo}`);
  if (doc.txn_type !== '正常出库') throw bizError('ORIGIN_DOC_INVALID', '只有正常出库单可以作为退库来源');
  if (doc.status !== 'posted' && doc.status !== 'partially_reversed') {
    throw bizError('ORIGIN_DOC_NOT_POSTED', '原出库单尚未过账或已全部冲销，不能退库');
  }
  return doc;
}

// 原出库单的可退明细（只取已过账的正数出库行）
function getReturnableLines(originDocNo, excludeDocNo) {
  loadReturnableOrigin(originDocNo);
  const lines = db.prepare(`SELECT o.id, o.code, o.qty, o.cost_price, o.remarks,
      m.name AS material_name, m.spec AS material_spec, m.unit AS material_unit, m.brand AS material_brand
    FROM outbound o LEFT JOIN materials m ON m.code = o.code
    WHERE o.doc_no = ? AND o.status = 'posted' AND o.qty > 0
    ORDER BY o.id ASC`).all(originDocNo);

  return lines.map(l => {
    const origQty = sign.absQty(l.qty);
    const returnedQty = getReturnedQtyByLine(l.id, excludeDocNo);
    return {
      id: l.id,
      code: l.code,
      qty: origQty,
      cost_price: sign.storedAbs(l.cost_price),
      returned_qty: returnedQty,
      remaining: Math.max(0, origQty - returnedQty),
      material_name: l.material_name,
      material_spec: l.material_spec,
      material_unit: l.material_unit,
      material_brand: l.material_brand,
      remarks: l.remarks,
    };
  });
}

// 校验退库明细：必须关联原行，且 累计已退 + 本次退 <= 原出库量
// lines: [{ origin_line_id, code, qty }]，qty 为正数
function validateReturnAgainstOrigin(lines, originDocNo, excludeDocNo) {
  loadReturnableOrigin(originDocNo);
  const seen = new Map();

  lines.forEach(l => {
    const lineId = Number(l.origin_line_id) || 0;
    if (!lineId) {
      throw bizError('ORIGIN_LINE_REQUIRED', `物料 ${l.code || '-'} 未关联原出库明细，不能退库`);
    }
    const orig = db.prepare('SELECT id, doc_no, code, qty FROM outbound WHERE id=?').get(lineId);
    if (!orig || orig.doc_no !== originDocNo) {
      throw bizError('ORIGIN_LINE_INVALID', `明细行 ${lineId} 不属于原出库单 ${originDocNo}`);
    }
    if (Number(orig.qty) <= 0) {
      throw bizError('ORIGIN_LINE_INVALID', `明细行 ${lineId} 不是正常出库行，不能退库`);
    }

    const qty = sign.absQty(l.qty);
    const used = getReturnedQtyByLine(lineId, excludeDocNo);
    const inBatch = (seen.get(lineId) || 0) + qty;
    seen.set(lineId, inBatch);

    const origQty = sign.absQty(orig.qty);
    if (used + inBatch > origQty + 1e-4) {
      throw bizError('RETURN_QTY_EXCEEDED',
        `物料 ${orig.code}：本次退库 ${used + inBatch} 超过可退量 ${origQty}（最多还可退 ${Math.max(0, origQty - used)}）`);
    }
  });
}

// 计算库存汇总
// 口径：当前库存 = 期初 + Σ入库 - Σ出库 + Σ调整
function getStockSummary() {
  const materials = db.prepare(`
    SELECT m.code, m.name, m.spec, m.category, m.unit,
           m.opening_qty, m.opening_price, m.min_stock, m.brand, m.status
    FROM materials m
    WHERE m.status != '停用' OR m.status IS NULL OR m.status = ''
    ORDER BY m.code
  `).all();

  // 调整累计：一次 GROUP BY 取回全部物料，避免逐物料查询
  const adjMap = new Map();
  db.prepare('SELECT code, COALESCE(SUM(qty),0) as v FROM stock_adjustments GROUP BY code').all()
    .forEach(r => adjMap.set(r.code, r.v));

  return materials.map(m => {
    // 入库只统计已过账的行（草稿 draft 不计入库存）
    const totalIn = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM inbound WHERE code=? AND status='posted'").get(m.code).v;
    const totalOut = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM outbound WHERE code=? AND status='posted'").get(m.code).v;
    const totalAdj = adjMap.get(m.code) || 0;
    const onHand = m.opening_qty + totalIn - totalOut + totalAdj;

    // 加权平均单价
    // 说明：调整流水不参与成本核算（本期范围外），故 avg_price 计算式保持不变，
    //       仅 on_hand 纳入调整项。这样与「调整不计入入出库统计」的口径自洽。
    const inTotalCost = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM inbound WHERE code=? AND status='posted'").get(m.code).v;
    const openingCost = m.opening_qty * m.opening_price;
    const totalQty = m.opening_qty + totalIn;
    const avgPrice = totalQty > 0 ? (openingCost + inTotalCost) / totalQty : 0;

    // 库存状态
    let stockStatus;
    if (m.status === '停用') stockStatus = '停用';
    else if (onHand <= 0) stockStatus = '缺货';
    else if (onHand <= m.min_stock) stockStatus = '补货';
    else stockStatus = '正常';

    return {
      ...m,
      total_in: totalIn,
      total_out: totalOut,
      total_adj: totalAdj,
      on_hand: onHand,
      avg_price: Math.round(avgPrice * 10000) / 10000,
      stock_value: Math.round(onHand * avgPrice * 100) / 100,
      stock_status: stockStatus
    };
  });
}

// 计算出库成本单价（加权平均）
function computeCostPrice(code, qty, date) {
  const m = db.prepare('SELECT opening_qty, opening_price FROM materials WHERE code=?').get(code);
  if (!m) return 0;

  const inboundBefore = db.prepare(`
    SELECT qty, price FROM inbound
    WHERE code=? AND date < ? AND status='posted'
    ORDER BY date ASC
  `).all(code, date);

  const outboundBefore = db.prepare(`
    SELECT qty FROM outbound
    WHERE code=? AND date < ? AND status='posted'
    ORDER BY date ASC
  `).all(code, date);

  let stockQty = m.opening_qty;
  let stockCost = m.opening_qty * m.opening_price;

  // 合并按时间顺序
  const allTxns = [];
  inboundBefore.forEach(r => allTxns.push({ ...r, type: 'in' }));
  outboundBefore.forEach(r => allTxns.push({ ...r, type: 'out' }));
  allTxns.sort((a, b) => 0); // 已分别查询，按入库顺序处理

  // 先处理入库
  inboundBefore.forEach(r => {
    stockCost += r.qty * r.price;
    stockQty += r.qty;
  });
  // 再处理出库
  outboundBefore.forEach(r => {
    const cp = stockQty > 0 ? stockCost / stockQty : 0;
    stockQty -= r.qty;
    stockCost -= r.qty * cp;
  });

  return stockQty > 0 ? stockCost / stockQty : 0;
}

// 生成单号（批量共享一个单号）
// 入库：采购入库 GRN-，采购退货 RET-
// 出库：正常出库 GIN-，退库出库 GIT-
// 前缀与序号位数统一由 services/docno.js 管理，可在「参数设置」中修改
function genGrnNo(date, txnType) {
  return docno.genDocNo(txnType === '采购退货' ? 'ret' : 'grn', date);
}
function genGinNo(date, txnType) {
  return docno.genDocNo(txnType === '退库出库' ? 'git' : 'gin', date);
}

// ==================== 库存盘点 ====================
// 盘点单号：ST-YYYYMMDD-序号（用「已有单号的最大序号 +1」推进，不用 COUNT，
// 删掉中间号后也不会与既有单号重复）
// 注：调整流水不再有独立单号，统一用来源盘点单号 stocktake_no 追溯。
function genStocktakeNo(date) {
  return docno.genDocNo('st', date);
}

// 自动生成物料编码：按类别前缀 + 序号
function genMaterialCode(category) {
  // 查类别对应的编码前缀
  const cat = db.prepare("SELECT prefix FROM categories WHERE name=?").get(category);
  let prefix = '';
  if (cat && cat.prefix) {
    prefix = cat.prefix;
  } else {
    // 无前缀的类别用类别首字母拼音简化处理，找不到就用 'IT'
    prefix = 'IT';
  }

  // 找已有同前缀编码的最大序号
  const like = prefix + '%';
  const rows = db.prepare("SELECT code FROM materials WHERE code LIKE ?").all(like);
  let maxSeq = 0;
  rows.forEach(r => {
    const numPart = r.code.replace(prefix, '');
    const n = parseInt(numPart);
    if (!isNaN(n) && n > maxSeq) maxSeq = n;
  });
  const nextSeq = maxSeq + 1;
  // 编码格式：前缀 + 4位序号（不足补零）
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

// ==================== 采购到货核销口径（2026-11） ====================
// 有效合同号：明细行上的合同号为准，行上为空时回退到采购单头的默认合同。
// 这样「一张采购单的多个明细行分属不同合同」的多对多关系才有真实归属。
const EFF_CONTRACT = `(CASE WHEN TRIM(COALESCE(ol.contract_no,'')) <> '' THEN ol.contract_no ELSE COALESCE(po.contract_no,'') END)`;

// 单条采购明细的已到货数量：
//   优先按 inbound.order_line_id 精确核销；
//   否则回退到「采购单 + 物料 + 合同号」匹配（双方都带合同号时必须一致，否则不串账）。
const RECEIVED_BY_LINE = `
  CASE WHEN EXISTS (SELECT 1 FROM inbound i WHERE i.order_line_id = ol.id AND i.status = 'posted')
    THEN (SELECT COALESCE(SUM(i.qty),0) FROM inbound i WHERE i.order_line_id = ol.id AND i.status = 'posted')
    ELSE (SELECT COALESCE(SUM(i.qty),0) FROM inbound i
            WHERE i.po_no = ol.po_no AND i.code = ol.code AND i.status = 'posted'
              AND (${EFF_CONTRACT} = '' OR TRIM(COALESCE(i.contract_no,'')) = '' OR i.contract_no = ${EFF_CONTRACT}))
  END`;

// 解析一条入库明细应核销到哪个采购明细行（找不到返回 0）
function resolveOrderLineId(poNo, code, contractNo) {
  const po = String(poNo || '').trim();
  const c = String(contractNo || '').trim();
  if (!po || !code) return 0;
  const row = db.prepare(`
    SELECT ol.id FROM order_lines ol
    JOIN purchase_orders po ON ol.po_no = po.po_no
    WHERE ol.po_no = ? AND ol.code = ?
      AND (? = '' OR ${EFF_CONTRACT} = '' OR ${EFF_CONTRACT} = ?)
    ORDER BY ol.id LIMIT 1
  `).get(po, code, c, c);
  return row ? row.id : 0;
}

// 获取订单明细（用于入库时选择订单带出明细）
function getOrderLinesForInbound(poNo) {
  const lines = db.prepare(`
    SELECT ol.*, po.manual_status, ${EFF_CONTRACT} AS contract_no_eff, ${RECEIVED_BY_LINE} AS received_qty,
           m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM order_lines ol
    LEFT JOIN purchase_orders po ON ol.po_no = po.po_no
    LEFT JOIN materials m ON ol.code = m.code
    WHERE ol.po_no=? ORDER BY ol.id
  `).all(poNo);
  return lines.map(l => ({
    ...l,
    received_qty: l.received_qty || 0,
    unreceived_qty: l.order_qty - (l.received_qty || 0)
  })).filter(l => l.unreceived_qty > 0 && l.manual_status !== '已取消' && l.manual_status !== '已关闭');
}

// 按合同号获取订单明细（汇总该合同下所有采购订单的明细，含行级合同归属）
function getOrderLinesByContract(contractNo) {
  const lines = db.prepare(`
    SELECT ol.*, po.po_no, po.supplier, po.manual_status, po.date AS po_date,
           ${EFF_CONTRACT} AS contract_no_eff, ${RECEIVED_BY_LINE} AS received_qty,
           m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM order_lines ol
    LEFT JOIN purchase_orders po ON ol.po_no = po.po_no
    LEFT JOIN materials m ON ol.code = m.code
    WHERE ${EFF_CONTRACT} = ? ORDER BY ol.po_no, ol.id
  `).all(contractNo);
  return lines.map(l => ({
    ...l,
    received_qty: l.received_qty || 0,
    unreceived_qty: l.order_qty - (l.received_qty || 0)
  })).filter(l => l.unreceived_qty > 0 && l.manual_status !== '已取消' && l.manual_status !== '已关闭');
}


module.exports = {
  getAdjustTotal,
  getAvailableStock,
  validateOutboundStock,
  validateInboundReturnStock,
  getReturnedQtyByLine,
  loadReturnableOrigin,
  getReturnableLines,
  validateReturnAgainstOrigin,
  getStockSummary,
  computeCostPrice,
  genGrnNo,
  genGinNo,
  genStocktakeNo,
  genMaterialCode,
  getOrderLinesForInbound,
  getOrderLinesByContract,
  resolveOrderLineId,
  EFF_CONTRACT,
  RECEIVED_BY_LINE,
};
