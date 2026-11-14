/**
 * 库存计算、编号生成、订单辅助等业务函数
 */
const db = require('../db');
const docno = require('./docno');
const sign = require('./sign');

// ==================== 辅助函数 ====================

// ==================== 库存计算统一口径 ====================
// 库存数量一律取 stock_balance（由 stock_ledger 推导），
// 与库存汇总、物料台账、看板同源，不再用「期初 + Σ入库 - Σ出库 + Σ调整」另算一套。

// 计算指定物料的可用库存（总量口径，不分位置）
// excludeOutboundId: 编辑出库时排除自身
// excludeInboundId:  编辑入库（尤其采购退货）时排除自身
// excludeAdjId:      编辑调整时排除本条调整记录自身的调整量
function getAvailableStock(code, excludeOutboundId, excludeInboundId, excludeAdjId) {
  const m = db.prepare('SELECT opening_qty FROM materials WHERE code=?').get(code);
  if (!m) return 0;

  const bal = db.prepare('SELECT stock_qty FROM stock_balance WHERE code=?').get(code);
  let qty = bal ? bal.stock_qty : 0;

  // 编辑出库：排除本条出库记录自身的扣减
  if (excludeOutboundId) {
    const old = db.prepare('SELECT code, qty FROM outbound WHERE id=?').get(excludeOutboundId);
    if (old && old.code === code) qty += (old.qty || 0);
  }

  // 编辑入库：排除本条入库记录自身的贡献（采购退货为负，排除后相当于加回）
  if (excludeInboundId) {
    const old = db.prepare('SELECT code, qty, status FROM inbound WHERE id=?').get(excludeInboundId);
    if (old && old.code === code && old.status === 'posted') qty -= (old.qty || 0);
  }

  // 编辑调整：排除本条调整记录自身的调整量
  // 注意：排除时必须校验 code —— 编辑换物料时，本条记录的旧调整属于原物料，
  // 不能从新物料的调整总量里减掉，否则新物料可用量被错误高估。
  if (excludeAdjId) {
    const old = db.prepare('SELECT code, qty FROM stock_adjustments WHERE id=?').get(excludeAdjId);
    if (old && old.code === code) qty -= (old.qty || 0);
  }

  return qty;
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
    // 领料退库（qty 为负）是入库性质，不占用库存
    const qty = Number(r.qty);
    if (qty <= 0) return;
    demand.set(r.code, (demand.get(r.code) || 0) + qty);
  });

  const errors = [];
  demand.forEach((needQty, code) => {
    // 编辑场景：排除本条记录自身的扣减后，可用额度才是这条记录能占用的上限
    const available = excludeOutboundId ? getAvailableStock(code, excludeOutboundId) : getAvailableStock(code);
    // 负库存硬拦：可用量不足即拒绝，不提供强制放行
    if (needQty > available) {
      errors.push({
        code,
        requested: needQty,
        available: Math.round(available * 1000000) / 1000000,
        shortfall: Math.round((needQty - available) * 1000000) / 1000000
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
    const available = excludeInboundId
      ? getAvailableStock(code, null, excludeInboundId)
      : getAvailableStock(code);
    // 负库存硬拦：可用量不足即拒绝，不提供强制放行
    if (needQty > available) {
      errors.push({
        code,
        requested: needQty,
        available: Math.round(available * 1000000) / 1000000,
        shortfall: Math.round((needQty - available) * 1000000) / 1000000
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

// ==================== 领料退库：关联原出库单（2C） ====================
// 可退量口径 = 原出库行数量 - 已退数量
// 「已退」只统计「已过账」的退库行：草稿不占用可退额度，作废/删除自然不受影响，
// 也避免两张草稿互相锁死同一原行的可退量。
const RETURN_TXN_TYPE = '领料退库';

function bizError(code, message, details) {
  const e = new Error(message);
  e.code = code;
  e.status = 400;
  if (details !== undefined) e.details = details;
  return e;
}

// 原出库行累计已退数量（可排除当前正在编辑的退库单自身）
function getReturnedQtyByLine(originLineId, excludeDocNo) {
  let sql = `SELECT COALESCE(SUM(ABS(o.qty)),0) AS qty FROM outbound o
    JOIN outbound_docs d ON d.doc_no = o.doc_no
    WHERE o.origin_line_id = ? AND o.txn_type = ?
      AND d.status = 'posted'`;
  const args = [Number(originLineId) || 0, RETURN_TXN_TYPE];
  if (excludeDocNo) { sql += ' AND o.doc_no <> ?'; args.push(excludeDocNo); }
  return Number(db.prepare(sql).get(...args).qty || 0);
}

// 校验原出库单可作为退库来源
function loadReturnableOrigin(originDocNo) {
  const doc = db.prepare('SELECT * FROM outbound_docs WHERE doc_no=?').get(originDocNo);
  if (!doc) throw bizError('ORIGIN_DOC_NOT_FOUND', `原出库单不存在: ${originDocNo}`);
  if (doc.txn_type !== '正常出库') throw bizError('ORIGIN_DOC_INVALID', '只有正常出库单可以作为退库来源');
  if (doc.status !== 'posted') {
    throw bizError('ORIGIN_DOC_NOT_POSTED', '原出库单尚未过账或已作废，不能退库');
  }
  return doc;
}

// 原出库单的可退明细（只取已过账的正数出库行）
// originDoc: 调用方已用 loadReturnableOrigin 取到的整行，传了就不重复查库
function getReturnableLines(originDocNo, excludeDocNo, originDoc) {
  if (!originDoc) loadReturnableOrigin(originDocNo);
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

// 累计入/出/调整的统一取数（库存汇总与物料台账共用同一份 SQL）
// 口径：只取有效流水，且「期初结存」不计入累计入库/累计出库。
function getFlowTotalsMap(opts = {}) {
  const where = ["status='active'", "source_type<>'opening'"];
  const params = [];
  if (opts.code) { where.push('code=?'); params.push(opts.code); }
  if (opts.startDate) { where.push('business_date>=?'); params.push(opts.startDate); }
  if (opts.endDate) { where.push('business_date<=?'); params.push(opts.endDate); }
  const map = new Map();
  db.prepare(`SELECT code,
      COALESCE(SUM(qty_in),0) AS qty_in,
      COALESCE(SUM(qty_out),0) AS qty_out,
      COALESCE(SUM(CASE WHEN source_type='adjust' THEN qty_in - qty_out ELSE 0 END),0) AS qty_adj
    FROM stock_ledger WHERE ${where.join(' AND ')} GROUP BY code`).all(...params)
    .forEach(r => map.set(r.code, {
      total_in: r.qty_in,
      total_out: r.qty_out,
      // qty_adj 是聚合别名，不在 scaled-db 的 QTY_COLS 里，需手动还原为件
      total_adj: r.qty_adj / 1e6,
    }));
  return map;
}

// 计算库存汇总
// 口径：数量 / 金额 / 均价一律直接取 stock_balance（由 stock_ledger 推导），
// 与物料台账、看板同源；这里不再用「期初 + Σ入库 - Σ出库 + Σ调整」现算。
// opts.includePrice=false 时不下发价格类字段（金额 / 均价 / 期初单价），
// 数量、累计入出、库存状态等非价格口径保持不变。
const SUMMARY_PRICE_FIELDS = ['opening_price', 'avg_price', 'stock_value'];

function stripSummaryPrice(row) {
  const out = { ...row };
  SUMMARY_PRICE_FIELDS.forEach(k => { delete out[k]; });
  return out;
}

function getStockSummary(opts = {}) {
  const includePrice = opts.includePrice !== false;
  const materials = db.prepare(`
    SELECT m.code, m.name, m.spec, m.category, m.unit,
           m.opening_qty, m.opening_price, m.min_stock, m.brand, m.status
    FROM materials m
    WHERE m.status != '停用' OR m.status IS NULL OR m.status = ''
    ORDER BY m.code
  `).all();

  // 余额快照：库存数量 / 金额 / 均价
  const balMap = new Map();
  db.prepare('SELECT code, stock_qty, stock_amount, avg_cost FROM stock_balance').all()
    .forEach(r => balMap.set(r.code, r));

  // 累计入/出/调整：与物料台账共用 getFlowTotalsMap，期初不计入累计
  const flowMap = getFlowTotalsMap();

  return materials.map(m => {
    const bal = balMap.get(m.code);
    const flow = flowMap.get(m.code);
    // 没有余额行 = 该物料从未有过流水（含期初），库存一律按 0 展示
    const onHand = bal ? bal.stock_qty : 0;
    const stockValue = bal ? bal.stock_amount : 0;
    // 数量为 0 时金额必须是 0、均价显示 0（不返回 NaN / 空）
    const avgPrice = bal && bal.stock_qty !== 0 ? bal.avg_cost : 0;

    // 库存状态：未设置安全库存（0）且无库存的物料不构成补货/缺货预警
    let stockStatus;
    if (m.status === '停用') stockStatus = '停用';
    else if (onHand <= 0) stockStatus = Number(m.min_stock) > 0 ? '缺货' : '正常';
    else if (onHand <= m.min_stock) stockStatus = '补货';
    else stockStatus = '正常';

    const row = {
      ...m,
      total_in: flow ? flow.total_in : 0,
      total_out: flow ? flow.total_out : 0,
      total_adj: flow ? flow.total_adj : 0,
      on_hand: onHand,
      avg_price: Math.round(avgPrice * 100000000) / 100000000,
      stock_value: Math.round(stockValue * 100) / 100,
      stock_status: stockStatus
    };
    return includePrice ? row : stripSummaryPrice(row);
  });
}

// 计算出库成本单价（加权平均）
// 口径：以「出库行创建时间 at」为界，只采纳此前已过账的入库流水。
//   - 同日必须按 created_at 排序，严格先入后出：
//       入库行 date < 出库日，或 date = 出库日且 created_at <= 出库行创建时间；
//   - 采购退货属于入库侧的负数，按同一时间顺序参与均价计算；
//   - 按加权平均法，出库按均价出库不会改变均价，故只需累计截至该时点的
//     入库数量与金额（这也避免了“库存恰好为 0 时均价被算成 0”的问题）。
// at 为空时退化为「当天结束」，仍按 created_at 排序，不会漏掉同日更早的入库。
function computeCostPrice(code, qty, date, at) {
  const m = db.prepare('SELECT opening_qty, opening_price FROM materials WHERE code=?').get(code);
  if (!m) return 0;

  const point = at || `${date} 23:59:59`;

  const inboundBefore = db.prepare(`
    SELECT qty, price FROM inbound
    WHERE code=? AND status='posted'
      AND (date < ? OR (date = ? AND created_at <= ?))
    ORDER BY date ASC, created_at ASC, id ASC
  `).all(code, date, date, point);

  let stockQty = Number(m.opening_qty) || 0;
  let stockCost = (Number(m.opening_qty) || 0) * (Number(m.opening_price) || 0);

  for (const r of inboundBefore) {
    stockQty += Number(r.qty) || 0;
    stockCost += (Number(r.qty) || 0) * (Number(r.price) || 0);
  }

  return stockQty > 0 ? stockCost / stockQty : 0;
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

// 参与采购到货核销的账本类型；负数退货行同样参与，直接按有符号数量求和
// 作废（voided）单据的明细行状态为 voided，不满足 status='posted'，自动不计入
const RECEIVED_TXN_TYPES = "('采购入库','零星入库','采购退货')";

// 单条采购明细的净到货数量 = 已入库 − 已退货（数量本身已带符号）：
//   第 1 路：按 inbound.order_line_id 精确核销的行；
//   第 2 路：未核销到具体明细（order_line_id = 0）的行，回退按「采购单 + 物料 + 合同」匹配
//           （双方都带合同号时必须一致，否则不串账）。
//   两路以 order_line_id 是否为 0 互斥，UNION ALL 后统一求和，不会重复计数。
//   注意不能用 CASE WHEN EXISTS ... ELSE ...：一旦某行有核销入库，回退路的退货行就会被漏掉。
const RECEIVED_BY_LINE = `(
  SELECT COALESCE(SUM(x.qty),0) FROM (
    SELECT i.qty AS qty FROM inbound i
      WHERE i.status = 'posted' AND i.txn_type IN ${RECEIVED_TXN_TYPES}
        AND i.order_line_id = ol.id
    UNION ALL
    SELECT i.qty AS qty FROM inbound i
      WHERE i.status = 'posted' AND i.txn_type IN ${RECEIVED_TXN_TYPES}
        AND i.order_line_id = 0 AND i.po_no = ol.po_no AND i.code = ol.code
        AND (${EFF_CONTRACT} = '' OR TRIM(COALESCE(i.contract_no,'')) = '' OR i.contract_no = ${EFF_CONTRACT})
  ) x
)`;

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

// 采购退货保存时的核销兜底：按「采购单 + 物料（合同为空或一致）」唯一匹配到采购明细行。
// 命中的行多于一条时返回 0——宁可留空也不猜测，避免把退货错记到别的合同/明细上。
function resolveUniqueOrderLineId(poNo, code, contractNo) {
  const po = String(poNo || '').trim();
  const c = String(contractNo || '').trim();
  if (!po || !code) return 0;
  const rows = db.prepare(`
    SELECT ol.id FROM order_lines ol
    JOIN purchase_orders po ON ol.po_no = po.po_no
    WHERE ol.po_no = ? AND ol.code = ?
      AND (? = '' OR ${EFF_CONTRACT} = '' OR ${EFF_CONTRACT} = ?)
    ORDER BY ol.id LIMIT 2
  `).all(po, code, c, c);
  return rows.length === 1 ? rows[0].id : 0;
}

// 更正预填「未到货」时临时排除某张入库单的已过账数量：
// 原单在更正草稿阶段仍然有效，若不排除，原单已过账数量会把可载入余额吃掉。
function subtractDocReceipts(lines, docNo) {
  if (!docNo) return lines;
  const rows = db.prepare(`SELECT code, qty, po_no, contract_no, order_line_id
    FROM inbound WHERE doc_no=? AND status='posted'
      AND txn_type IN ${RECEIVED_TXN_TYPES}`).all(docNo);
  if (rows.length === 0) return lines;
  const norm = v => String(v == null ? '' : v).trim();
  const matches = (r, l) => {
    const rid = Number(r.order_line_id) || 0;
    if (rid > 0) return rid === Number(l.id);
    if (norm(r.po_no) !== norm(l.po_no)) return false;
    if (norm(r.code) !== norm(l.code)) return false;
    const eff = norm(l.contract_no_eff);
    return eff === '' || norm(r.contract_no) === '' || norm(r.contract_no) === eff;
  };
  return lines.map(l => {
    let excluded = 0;
    rows.forEach(r => { if (matches(r, l)) excluded += Number(r.qty) || 0; });
    const received = (Number(l.received_qty) || 0) - excluded;
    return { ...l, received_qty: received, unreceived_qty: Number(l.order_qty) - received };
  });
}

// 获取订单明细（用于入库时选择订单带出明细）
// opts.excludeDocNo：临时把该入库单已过账数量从「已到货」中扣除（更正预填用）
function getOrderLinesForInbound(poNo, opts) {
  const lines = db.prepare(`
    SELECT ol.*, po.manual_status, ${EFF_CONTRACT} AS contract_no_eff, ${RECEIVED_BY_LINE} AS received_qty,
           m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM order_lines ol
    LEFT JOIN purchase_orders po ON ol.po_no = po.po_no
    LEFT JOIN materials m ON ol.code = m.code
    WHERE ol.po_no=? ORDER BY ol.id
  `).all(poNo);
  const mapped = lines.map(l => ({
    ...l,
    received_qty: l.received_qty || 0,
    unreceived_qty: l.order_qty - (l.received_qty || 0)
  }));
  const adjusted = subtractDocReceipts(mapped, opts && opts.excludeDocNo);
  return adjusted.filter(l => l.unreceived_qty > 0 && l.manual_status !== '已取消' && l.manual_status !== '已关闭');
}

// 按合同号获取订单明细（汇总该合同下所有采购订单的明细，含行级合同归属）
function getOrderLinesByContract(contractNo, opts) {
  const lines = db.prepare(`
    SELECT ol.*, po.po_no, po.supplier, po.manual_status, po.date AS po_date,
           ${EFF_CONTRACT} AS contract_no_eff, ${RECEIVED_BY_LINE} AS received_qty,
           m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM order_lines ol
    LEFT JOIN purchase_orders po ON ol.po_no = po.po_no
    LEFT JOIN materials m ON ol.code = m.code
    WHERE ${EFF_CONTRACT} = ? ORDER BY ol.po_no, ol.id
  `).all(contractNo);
  const mapped = lines.map(l => ({
    ...l,
    received_qty: l.received_qty || 0,
    unreceived_qty: l.order_qty - (l.received_qty || 0)
  }));
  const adjusted = subtractDocReceipts(mapped, opts && opts.excludeDocNo);
  return adjusted.filter(l => l.unreceived_qty > 0 && l.manual_status !== '已取消' && l.manual_status !== '已关闭');
}

// 采购入库单头来源的全量明细：不做「未到货 > 0」过滤，
// 供入库页的来源物料范围、未到货展示、超收校验共用同一口径。
// opts.excludeDocNo：更正草稿用，把被更正原单自身的已过账量还回去（原单确认后会被作废）
function getPurchaseScopeLines(scope, opts) {
  const poNo = String((scope && scope.poNo) || '').trim();
  const contractNo = String((scope && scope.contractNo) || '').trim();
  if (!poNo && !contractNo) return [];
  const where = poNo ? 'ol.po_no = ?' : `${EFF_CONTRACT} = ?`;
  const lines = db.prepare(`
    SELECT ol.*, po.po_no, po.supplier AS po_supplier, po.manual_status,
           ${EFF_CONTRACT} AS contract_no_eff, ${RECEIVED_BY_LINE} AS received_qty,
           m.name AS material_name, m.spec AS material_spec, m.unit AS material_unit, m.brand AS material_brand
    FROM order_lines ol
    LEFT JOIN purchase_orders po ON ol.po_no = po.po_no
    LEFT JOIN materials m ON ol.code = m.code
    WHERE ${where}
    ORDER BY ol.po_no, ol.id`).all(poNo || contractNo);
  const mapped = lines.map(l => ({
    ...l,
    received_qty: l.received_qty || 0,
    unreceived_qty: Number(l.order_qty || 0) - (l.received_qty || 0),
  }));
  return subtractDocReceipts(mapped, opts && opts.excludeDocNo);
}

// ==================== 采购退货三档关联（2026-11 第五批） ====================
// 档 1 inbound ：绑原入库单，行 origin_line_id 指向原入库行
// 档 2 po/contract：按采购单/合同跨多张入库单合并退货，行 origin_line_id 仍指向具体入库行
// 档 3 none    ：无原单（仅 admin/manager），单价手填、原因必填
const PURCHASE_RETURN_TYPE = '采购退货';
const MISC_RETURN_TYPE = '零星退货';
const INBOUND_RETURN_TYPES = [PURCHASE_RETURN_TYPE, MISC_RETURN_TYPE];
const RETURN_SOURCE_TYPES = ['采购入库', '零星入库'];
const RETURN_TIER_VALUES = ['inbound', 'po', 'contract', 'none'];
const RETURN_SOURCE_STATUSES = ['posted'];

// 已确认（已影响库存）的单据状态：只有 posted 参与可退额度占用；作废单整体不计入
const CONFIRMED_DOC_STATUS_SQL = "d.status = 'posted'";

// 原入库行被已过账采购退货占用的净数量；草稿不占用额度
function getPurchaseReturnedQtyByLine(lineId, excludeDocNo) {
  let sql = `SELECT COALESCE(SUM(ABS(r.qty)),0) AS qty FROM inbound r
    JOIN inbound_docs d ON d.doc_no = r.doc_no
    WHERE r.txn_type IN (?,?) AND r.origin_line_id = ? AND ${CONFIRMED_DOC_STATUS_SQL}`;
  const args = [PURCHASE_RETURN_TYPE, MISC_RETURN_TYPE, Number(lineId) || 0];
  if (excludeDocNo) { sql += ' AND r.doc_no <> ?'; args.push(excludeDocNo); }
  return Number(db.prepare(sql).get(...args).qty || 0);
}

// 单条原入库行的可退量 = 原入库量 − 已过账退货净占用量
function purchaseReturnAvailable(line) {
  const orig = sign.absQty(line.qty);
  const returned = getPurchaseReturnedQtyByLine(line.id);
  return Math.max(0, orig - returned);
}

// 校验原入库单可作为采购退货来源
function loadPurchaseReturnOrigin(originDocNo) {
  const doc = db.prepare('SELECT * FROM inbound_docs WHERE doc_no=?').get(originDocNo);
  if (!doc) throw bizError('ORIGIN_DOC_NOT_FOUND', `原入库单不存在: ${originDocNo}`);
  if (!RETURN_SOURCE_TYPES.includes(doc.txn_type)) {
    throw bizError('ORIGIN_DOC_INVALID', '只有采购入库/零星入库单可以作为采购退货来源');
  }
  if (!RETURN_SOURCE_STATUSES.includes(doc.status)) {
    throw bizError('ORIGIN_DOC_NOT_POSTED', '原入库单尚未过账或已作废，不能退货');
  }
  return doc;
}

const RETURN_SOURCE_SELECT = `SELECT i.id, i.doc_no, i.date, i.code, i.qty, i.price, i.po_no, i.contract_no,
    i.order_line_id, m.name AS material_name, m.spec AS material_spec,
    m.unit AS material_unit, m.brand AS material_brand
  FROM inbound i
  JOIN inbound_docs d ON d.doc_no = i.doc_no
  LEFT JOIN materials m ON m.code = i.code`;

function mapSourceLine(l, excludeDocNo) {
  return {
    id: l.id,
    doc_no: l.doc_no,
    date: l.date,
    code: l.code,
    qty: sign.absQty(l.qty),
    price: sign.storedAbs(l.price),
    po_no: l.po_no || '',
    contract_no: l.contract_no || '',
    order_line_id: Number(l.order_line_id) || 0,
    material_name: l.material_name,
    material_spec: l.material_spec,
    material_unit: l.material_unit,
    material_brand: l.material_brand,
    available: Math.max(0, sign.absQty(l.qty) - getPurchaseReturnedQtyByLine(l.id, excludeDocNo)),
  };
}

// 档 1：原入库单的可退明细（只取已过账的正数来源行）
function getPurchaseReturnOriginLines(originDocNo, excludeDocNo) {
  loadPurchaseReturnOrigin(originDocNo);
  const lines = db.prepare(`${RETURN_SOURCE_SELECT}
    WHERE i.doc_no = ? AND i.status = 'posted' AND i.qty > 0
      AND i.txn_type IN ('采购入库','零星入库')
    ORDER BY i.id ASC`).all(originDocNo);
  return lines.map(l => mapSourceLine(l, excludeDocNo));
}

// 档 2 范围合法性：采购单必须存在；合同必须存在于档案或明细行中
function loadPurchaseReturnScope(scope, refNo) {
  if (!refNo) throw bizError('RETURN_REF_REQUIRED', '请选择关联的采购单或合同');
  if (scope === 'po') {
    const po = db.prepare('SELECT po_no, supplier FROM purchase_orders WHERE po_no=?').get(refNo);
    if (!po) throw bizError('RETURN_PO_NOT_FOUND', `采购单不存在: ${refNo}`);
    return po;
  }
  const ct = db.prepare('SELECT contract_no, supplier FROM contracts WHERE contract_no=?').get(refNo);
  if (ct) return ct;
  const line = db.prepare(`SELECT ? AS contract_no, COALESCE(po.supplier,'') AS supplier
    FROM order_lines ol LEFT JOIN purchase_orders po ON po.po_no = ol.po_no
    WHERE ${EFF_CONTRACT} = ? LIMIT 1`).get(refNo, refNo);
  if (!line) throw bizError('RETURN_CONTRACT_NOT_FOUND', `合同不存在: ${refNo}`);
  return line;
}

// 档 2：采购单/合同范围的可退明细（跨多张入库单）
//   po       ：入库行 order_line_id 属于该采购单的采购明细，或行上 po_no 直接匹配
//   contract ：入库行 order_line_id 的「有效合同」= 合同号（行级合同优先、否则采购单头默认），
//              或行上 contract_no 直接匹配
function getPurchaseReturnScopeLines(scope, refNo, excludeDocNo) {
  loadPurchaseReturnScope(scope, refNo);
  let sql = `${RETURN_SOURCE_SELECT}
    WHERE i.status = 'posted' AND i.qty > 0
      AND i.txn_type IN ('采购入库','零星入库')
      AND d.status = 'posted'`;
  let args;
  if (scope === 'po') {
    sql += ` AND (i.po_no = ? OR i.order_line_id IN (SELECT id FROM order_lines WHERE po_no = ?))`;
    args = [refNo, refNo];
  } else {
    sql += ` AND (i.contract_no = ? OR i.order_line_id IN (
      SELECT ol.id FROM order_lines ol LEFT JOIN purchase_orders po ON po.po_no = ol.po_no
      WHERE ${EFF_CONTRACT} = ?))`;
    args = [refNo, refNo];
  }
  sql += ' ORDER BY i.id ASC';
  return db.prepare(sql).all(...args).map(l => mapSourceLine(l, excludeDocNo));
}

// 档 2 下拉候选：所有已确认采购单 + 所有合同（含仅出现在明细行上的合同号）
function getPurchaseReturnScopeOptions() {
  const po = db.prepare(`SELECT po_no, date, supplier FROM purchase_orders
    WHERE status='posted' ORDER BY date DESC, po_no`).all();
  const contract = db.prepare(`SELECT contract_no, MAX(supplier) AS supplier FROM (
      SELECT contract_no, supplier FROM contracts
      UNION ALL SELECT ol.contract_no AS contract_no, po.supplier AS supplier
        FROM order_lines ol LEFT JOIN purchase_orders po ON po.po_no = ol.po_no
        WHERE TRIM(COALESCE(ol.contract_no,'')) <> ''
    ) GROUP BY contract_no ORDER BY contract_no`).all();
  return { po, contract };
}

// 档 1 下拉候选：采购退货只列采购入库
function getPurchaseReturnOriginOptions() {
  return db.prepare(`SELECT doc_no, date, txn_type, supplier,
      (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no AND i.qty > 0) AS line_count
    FROM inbound_docs d
    WHERE txn_type = '采购入库'
      AND status = 'posted'
    ORDER BY date DESC, created_at DESC`).all();
}

// 档 1 下拉候选：零星退货只列零星入库，supplier 即原单的来源单位
function getMiscReturnOriginOptions() {
  return db.prepare(`SELECT doc_no, date, txn_type, supplier AS source_unit,
      (SELECT COUNT(*) FROM inbound i WHERE i.doc_no = d.doc_no AND i.qty > 0) AS line_count
    FROM inbound_docs d
    WHERE txn_type = '零星入库'
      AND status = 'posted'
    ORDER BY date DESC, created_at DESC`).all();
}

// 汇总某范围/原单的可退明细：Map<origin_line_id, source line>
function collectPurchaseReturnSources(docLike, excludeDocNo) {
  const tier = String(docLike.return_tier || '');
  if (tier === 'inbound') {
    return new Map(getPurchaseReturnOriginLines(docLike.origin_doc_no, excludeDocNo).map(s => [String(s.id), s]));
  }
  if (tier === 'po' || tier === 'contract') {
    return new Map(getPurchaseReturnScopeLines(tier, docLike.return_ref_no, excludeDocNo).map(s => [String(s.id), s]));
  }
  return new Map();
}

// 校验采购退货明细：关联档必须指向范围内的入库行，且单行累计不超可退量
// 返回 Map<origin_line_id, source line>，供调用方继承原行单价/采购明细核销号
function validatePurchaseReturnLines(docLike, lines, excludeDocNo) {
  const tier = String(docLike.return_tier || '');
  if (!INBOUND_RETURN_TYPES.includes(docLike.txn_type) || tier === 'none' || !tier) return new Map();
  const sources = collectPurchaseReturnSources(docLike, excludeDocNo);
  const seen = new Map();

  (lines || []).forEach(l => {
    const srcId = Number(l.origin_line_id) || 0;
    if (!srcId) {
      throw bizError('RETURN_ORIGIN_LINE_REQUIRED', `物料 ${l.code || '-'} 未关联原入库明细，不能退货`);
    }
    const src = sources.get(String(srcId));
    if (!src) {
      throw bizError('RETURN_ORIGIN_LINE_INVALID', `明细行 ${srcId} 不属于当前退货关联范围`);
    }
    if (l.code && l.code !== src.code) {
      throw bizError('RETURN_MATERIAL_MISMATCH', `明细行 ${srcId} 的物料应为 ${src.code}`);
    }
    const qty = sign.absQty(l.qty);
    const inBatch = (seen.get(String(srcId)) || 0) + qty;
    seen.set(String(srcId), inBatch);
    if (inBatch > src.available + 1e-4) {
      throw bizError('RETURN_QTY_EXCEEDED',
        `物料 ${src.code}：本次退货 ${inBatch} 超过原入库单 ${src.doc_no} 的可退量 ${src.available}` +
        `（最多还可退 ${Math.max(0, src.available - (inBatch - qty))}）`,
        { code: src.code, origin_doc_no: src.doc_no, origin_line_id: src.id, available: src.available, requested: inBatch });
    }
  });
  return sources;
}

module.exports = {
  getAvailableStock,
  validateOutboundStock,
  validateInboundReturnStock,
  getReturnedQtyByLine,
  loadReturnableOrigin,
  getReturnableLines,
  validateReturnAgainstOrigin,
  getStockSummary,
  stripSummaryPrice,
  getFlowTotalsMap,
  computeCostPrice,
  genStocktakeNo,
  genMaterialCode,
  getOrderLinesForInbound,
  getOrderLinesByContract,
  getPurchaseScopeLines,
  resolveOrderLineId,
  resolveUniqueOrderLineId,
  EFF_CONTRACT,
  RECEIVED_BY_LINE,
  // 采购退货三档（第五批）
  PURCHASE_RETURN_TYPE,
  MISC_RETURN_TYPE,
  INBOUND_RETURN_TYPES,
  RETURN_SOURCE_TYPES,
  RETURN_TIER_VALUES,
  getPurchaseReturnedQtyByLine,
  purchaseReturnAvailable,
  loadPurchaseReturnOrigin,
  getPurchaseReturnOriginLines,
  loadPurchaseReturnScope,
  getPurchaseReturnScopeLines,
  getPurchaseReturnScopeOptions,
  getPurchaseReturnOriginOptions,
  getMiscReturnOriginOptions,
  collectPurchaseReturnSources,
  validatePurchaseReturnLines,
};
