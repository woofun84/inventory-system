/**
 * 库存汇总 & 物料台账
 *
 * 台账数据一律直接读 stock_ledger（成本核算的唯一流水），
 * 结存数量/金额/均价取该行流水上的 balance_*，与 stock_balance 同源，
 * 不再用单据表现算，避免「台账一套、余额一套」。
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const stockSvc = require('../services/stock');
const { getStockSummary } = stockSvc;

const router = express.Router();

// --- 库存汇总 ---
// 查询中心「库存查询」板块的数据源，权限归到查询中心的 query:view（旧 stockSummary 键已下线）
router.get('/api/stock-summary', requirePerm('query', 'view'), (req, res) => {
  const { keyword, category, status } = req.query;
  let summary = getStockSummary({ includePrice: req.canViewPrice });
  if (keyword) {
    const kw = keyword.toLowerCase();
    summary = summary.filter(m =>
      m.code.toLowerCase().includes(kw) ||
      m.name.toLowerCase().includes(kw) ||
      (m.spec || '').toLowerCase().includes(kw) ||
      (m.brand || '').toLowerCase().includes(kw)
    );
  }
  if (category) summary = summary.filter(m => m.category === category);
  if (status) summary = summary.filter(m => m.stock_status === status);
  res.json(summary);
});

// 台账类型：与 stock_ledger.source_type 对应
const LEDGER_TYPES = { opening: '期初', inbound: '入库', outbound: '出库', adjust: '调整' };

function placeholders(n) {
  return new Array(n).fill('?').join(',');
}

// 展示用附加信息（对方 / 经手人 / 备注）按 source_line_id 回查业务表，仅用于显示
function loadExtras(rows) {
  const byType = { inbound: [], outbound: [], adjust: [] };
  rows.forEach(r => {
    if (byType[r.source_type] && r.source_line_id) byType[r.source_type].push(r.source_line_id);
  });
  const extras = new Map();

  if (byType.inbound.length) {
    db.prepare(`SELECT id, supplier, handler, remarks FROM inbound WHERE id IN (${placeholders(byType.inbound.length)})`)
      .all(...byType.inbound)
      .forEach(r => extras.set('inbound:' + r.id, {
        party: r.supplier || '', handler: r.handler || '', remarks: r.remarks || '',
      }));
  }
  if (byType.outbound.length) {
    db.prepare(`SELECT id, destination, receiver, handler, remarks FROM outbound WHERE id IN (${placeholders(byType.outbound.length)})`)
      .all(...byType.outbound)
      .forEach(r => extras.set('outbound:' + r.id, {
        party: [r.destination, r.receiver].filter(Boolean).join(' / '),
        handler: r.handler || '', remarks: r.remarks || '',
      }));
  }
  if (byType.adjust.length) {
    db.prepare(`SELECT id, reason, handler, remarks FROM stock_adjustments WHERE id IN (${placeholders(byType.adjust.length)})`)
      .all(...byType.adjust)
      .forEach(r => extras.set('adjust:' + r.id, {
        party: '', handler: r.handler || '',
        remarks: [r.reason, r.remarks].filter(Boolean).join(' / '),
      }));
  }
  return extras;
}

// 台账排序白名单：只允许按 stock_ledger 本身的列排序，客户端传的键不直接拼进 SQL。
// 对方 / 经手人 / 备注不在此列：它们由 loadExtras 跨 inbound、outbound、stock_adjustments
// 回查后拼装（出库的「对方」还是 destination / receiver 两列拼接），现有表结构下没有
// 与展示值完全一致的列可排，故这三列在前端不做排序（而不是只对当前页排序造成误导）。
const LEDGER_SORT = {
  date: 'business_date',
  doc_no: 'source_doc_id',
  business_type: 'business_type',
  price: 'unit_cost',
  amount: 'COALESCE(amount_in,0)+COALESCE(amount_out,0)',
  balance: 'balance_qty',
  balance_amount: 'balance_amount',
  balance_avg: 'balance_avg_cost',
  cost_basis: 'cost_basis',
};

// --- 物料台账（直接读库存流水） ---
// 分页与筛选全部下推到 SQL：page / pageSize / bizType / direction / startDate / endDate /
// includeVoided / sortKey / sortDir。不传 pageSize 时保持原「返回全部」行为。
// includeVoided=1 时把作废流水也带出来（默认隐藏，见下方说明）
// 该接口只服务查询中心物料详情卡的流水页签，权限归到 query:view（旧 ledger 键已下线）
router.get('/api/ledger/:code', requirePerm('query', 'view'), (req, res) => {
  const code = req.params.code;
  const { startDate, endDate } = req.query;
  const includeVoided = String(req.query.includeVoided || '') === '1';
  const bizType = String(req.query.bizType || '').trim();
  const direction = String(req.query.direction || '').trim();
  let sortKey = String(req.query.sortKey || '').trim();
  const sortDir = String(req.query.sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const rawSize = parseInt(req.query.pageSize, 10);
  const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.min(rawSize, 500) : 0;
  // 无价格权限：金额相关排序键一律回落默认顺序，避免通过排序旁路推断金额顺序
  if (!req.canViewPrice && ['price', 'amount', 'balance_amount', 'balance_avg'].includes(sortKey)) sortKey = '';

  const m = db.prepare('SELECT * FROM materials WHERE code=?').get(code);
  if (!m) return res.status(404).json({ error: '物料不存在' });

  // 作废/更正流水：默认隐藏。作废流水的 balance_* 是作废前的历史快照，不再参与累计，
  // 混在有效流水里展示会让人误以为结存是连续的，因此只在「显示作废」开关下带出并标注。
  // 筛选口径与前端旧实现逐条对齐：期初行展示日期为空，故带日期条件时把期初排除。
  const where = ['code=?'];
  const params = [code];
  if (!includeVoided) where.push("status='active'");
  if (startDate || endDate) where.push("source_type<>'opening'");
  if (startDate) { where.push('business_date>=?'); params.push(startDate); }
  if (endDate) { where.push('business_date<=?'); params.push(endDate); }
  if (bizType) { where.push('business_type=?'); params.push(bizType); }
  if (direction === 'in') where.push("source_type<>'adjust' AND COALESCE(qty_in,0)<>0");
  else if (direction === 'out') where.push("source_type<>'adjust' AND COALESCE(qty_out,0)<>0");
  else if (direction === 'adj') where.push("source_type='adjust'");
  const whereSql = where.join(' AND ');

  // 默认时间倒序；显式排序只取白名单表达式，同值行按过账顺序稳定排列，保证翻页不重不漏
  // 单号按「主体 + -Rn 修订号」排（与前端 compareDocNoText 一致，避免 -R10 排在 -R2 前）
  const docSuffix = "source_doc_id GLOB '*-R[0-9]*' AND substr(source_doc_id, instr(source_doc_id,'-R')+2) NOT GLOB '*[^0-9]*'";
  const docBase = `CASE WHEN ${docSuffix} THEN substr(source_doc_id,1,instr(source_doc_id,'-R')-1) ELSE COALESCE(source_doc_id,'') END`;
  const docRev = `CASE WHEN ${docSuffix} THEN CAST(substr(source_doc_id,instr(source_doc_id,'-R')+2) AS INTEGER) ELSE 0 END`;

  let orderSql = 'business_date DESC, posting_sequence DESC, id DESC';
  let orderParams = [];
  if (sortKey === 'doc_no') {
    orderSql = `${docBase} ${sortDir}, ${docRev} ${sortDir}, posting_sequence ASC, id ASC`;
  } else if (sortKey === 'business_type' || sortKey === 'cost_basis') {
    // 中文枚举列：先取当前筛选下的去重值，用与前端一致的 zh-CN 排序生成 CASE 排名，
    // 再按排名排；SQLite 默认按字节序，直接排会与旧前端 localeCompare 的组顺序不同。
    const col = LEDGER_SORT[sortKey];
    const collator = new Intl.Collator('zh-CN');
    const vals = db.prepare(`SELECT DISTINCT ${col} AS v FROM stock_ledger WHERE ${whereSql}`).all(...params)
      .map(x => (x.v == null ? '' : String(x.v)))
      .sort((a, b) => collator.compare(a.toLowerCase(), b.toLowerCase()));
    const cases = vals.map((v, i) => `WHEN ? THEN ${i}`).join(' ');
    orderSql = vals.length
      ? `CASE ${col} ${cases} ELSE ${vals.length} END ${sortDir}, posting_sequence ASC, id ASC`
      : 'posting_sequence ASC, id ASC';
    orderParams = vals;
  } else if (LEDGER_SORT[sortKey]) {
    orderSql = `${LEDGER_SORT[sortKey]} ${sortDir}, posting_sequence ASC, id ASC`;
  }

  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM stock_ledger WHERE ${whereSql}`).get(...params).n);

  let sql = `SELECT id, source_type, source_doc_id, source_line_id, return_source_line_id, business_type,
      business_date, posting_time, posting_sequence, qty_in, qty_out, amount_in, amount_out, unit_cost,
      balance_qty, balance_amount, balance_avg_cost, cost_basis, status
    FROM stock_ledger WHERE ${whereSql} ORDER BY ${orderSql}`;
  const listParams = params.concat(orderParams);
  if (pageSize > 0) {
    sql += ' LIMIT ? OFFSET ?';
    listParams.push(pageSize, (page - 1) * pageSize);
  }

  const ledgers = db.prepare(sql).all(...listParams);
  const extras = loadExtras(ledgers);
  const vp = req.canViewPrice;

  const rows = ledgers.map(r => {
    const isOpening = r.source_type === 'opening';
    const isAdjust = r.source_type === 'adjust';
    const adjQty = isAdjust ? (r.qty_in || 0) - (r.qty_out || 0) : 0;
    const ex = extras.get(`${r.source_type}:${r.source_line_id}`) || {};
    const row = {
      seq: r.posting_sequence,
      date: isOpening ? '' : (r.business_date || ''),
      posting_time: r.posting_time || '',
      doc_no: r.source_doc_id || '',
      type: LEDGER_TYPES[r.source_type] || r.source_type,
      business_type: r.business_type || '',
      return_line_id: isOpening ? 0 : (r.return_source_line_id || 0),
      // 调整行单独标记，前端据此用 adj_qty 展示带符号调整量（数量列不再留空）
      direction: isAdjust ? 'adj' : (r.qty_in ? 'in' : (r.qty_out ? 'out' : '')),
      in_qty: isAdjust ? '' : (r.qty_in || ''),
      out_qty: isAdjust ? '' : (r.qty_out || ''),
      adj_qty: isAdjust ? adjQty : '',
      adj_type: isAdjust ? (r.business_type || '') : '',
      // 本笔实际计价单价与金额（盘点调整按调整时点移动平均单价计价，金额 = 数量 × 当时均价）
      price: r.unit_cost || 0,
      amount: (r.amount_in || 0) || (r.amount_out || 0),
      // 该笔过账后的结存，等于当时 stock_balance 的值
      balance: r.balance_qty,
      balance_amount: r.balance_amount,
      balance_avg: r.balance_avg_cost,
      cost_basis: r.cost_basis || '',
      status: r.status,
      voided: r.status === 'voided',
      party: isOpening ? '' : (ex.party || ''),
      handler: isOpening ? '' : (ex.handler || ''),
      remarks: isOpening ? '' : (ex.remarks || ''),
    };
    // 无价格权限：本笔计价 / 结存金额与均价直接不下发（不是置 0）
    if (!vp) {
      delete row.price;
      delete row.amount;
      delete row.balance_amount;
      delete row.balance_avg;
    }
    return row;
  });

  const bal = db.prepare('SELECT stock_qty, stock_amount, avg_cost FROM stock_balance WHERE code=?').get(code);
  // 结存取最后一条「有效」流水：作废流水的 balance_* 是历史快照，不能当期末。
  // 列表已分页，这里单独按过账顺序回查（只受日期与作废开关影响，不受业务类型/方向/排序影响）。
  const closeWhere = ['code=?', "status='active'"];
  const closeParams = [code];
  if (startDate || endDate) closeWhere.push("source_type<>'opening'");
  if (startDate) { closeWhere.push('business_date>=?'); closeParams.push(startDate); }
  if (endDate) { closeWhere.push('business_date<=?'); closeParams.push(endDate); }
  const lastActive = db.prepare(`SELECT balance_qty, balance_amount, balance_avg_cost FROM stock_ledger
    WHERE ${closeWhere.join(' AND ')} ORDER BY posting_sequence DESC, id DESC LIMIT 1`).get(...closeParams) || null;
  const closingQty = lastActive ? lastActive.balance_qty : (bal ? bal.stock_qty : 0);
  const closingAmount = lastActive ? lastActive.balance_amount : (bal ? bal.stock_amount : 0);
  const closingAvg = lastActive ? lastActive.balance_avg_cost : (bal ? bal.avg_cost : 0);

  // 累计入/出/调整：与库存汇总共用 getFlowTotalsMap（有效流水、期初不计入累计）
  const flow = stockSvc.getFlowTotalsMap({ code, startDate, endDate }).get(code)
    || { total_in: 0, total_out: 0, total_adj: 0 };

  // 基本信息页的「本月入库 / 出库数量」：卡片只取 5 条摘要后前端无法再全量累加，
  // 用同一份 getFlowTotalsMap 按月区间算好下发（仅数量，不含价格）。
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthFlow = stockSvc.getFlowTotalsMap({ code, startDate: `${ym}-01`, endDate: `${ym}-${String(lastDay).padStart(2, '0')}` }).get(code)
    || { total_in: 0, total_out: 0 };

  const material = { ...m };
  if (!vp) delete material.opening_price;

  const body = {
    material,
    opening_qty: m.opening_qty,
    total_in: flow.total_in,
    total_out: flow.total_out,
    total_adj: flow.total_adj,
    closing_qty: closingQty,
    month_in: monthFlow.total_in,
    month_out: monthFlow.total_out,
  };
  if (vp) {
    body.closing_amount = closingAmount;
    body.closing_avg = closingAvg;
  }
  body.include_voided = includeVoided;
  body.total = total;
  body.page = pageSize > 0 ? page : 1;
  body.page_size = pageSize;
  body.rows = rows;
  res.json(body);
});

// --- 成本差异明细（默认只看未结转） ---
// 每条都能追到：来源单据号 + 明细行、物料、数量、原单价、当时均价、差额、原因、发生日期
router.get('/api/cost-variance', requirePerm('dashboard', 'view'), (req, res) => {
  const status = String(req.query.status || 'open') === 'settled' ? 'settled' : 'open';
  const rows = db.prepare(`SELECT v.*, m.name AS material_name, m.spec AS material_spec, m.unit AS material_unit
    FROM cost_variances v LEFT JOIN materials m ON m.code = v.code
    WHERE v.status = ? ORDER BY v.business_date DESC, v.id DESC LIMIT 500`).all(status);
  // 别名与金额列同名，scaled-db 会把「分」换算成「元」
  const agg = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
    FROM cost_variances WHERE status=?`).get(status);
  // 无价格权限：原单价/当时均价/差异金额与合计金额整包不下发（数量、笔数、原因、日期保留）
  if (!req.canViewPrice) {
    rows.forEach(r => { delete r.unit_cost; delete r.avg_cost; delete r.amount; });
    res.json({ status, count: Number(agg.count), rows });
    return;
  }
  res.json({ status, count: Number(agg.count), total: Number(agg.amount), rows });
});

module.exports = router;
