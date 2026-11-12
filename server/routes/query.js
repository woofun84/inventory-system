/**
 * 查询中心聚合接口（只读）
 *
 *   GET /api/query/docs             单据查询：入库/出库/盘点统一视图（服务端分页 + 排序）
 *   GET /api/query/receivers        领用人聚合（按 outbound_docs.receiver）
 *   GET /api/query/receivers/:name  某领用人的领用单据清单
 *   GET /api/analysis/stagnant      呆滞分析（阈值天数可配）
 *   GET /api/analysis/abc           ABC 分类（按区间出库成本累计占比）
 *   GET /api/analysis/turnover      库存周转率（区间净出库成本 / 每日结存金额均值）
 *
 * 说明：
 *  - 金额一律取生成列（inbound.amount / outbound.cost_amount），不在这里用 JS 乘算，
 *    避免 qty*price 超出 2^53 后丢精度；scaled-db 会按列名把「分」还原成「元」。
 *  - 盘点单状态 confirmed 在本接口统一对外呈现为 posted，与「draft / posted / voided」对齐，
 *    不改动盘点模块自身状态机。
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');

const router = express.Router();

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 15;

function paging(q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  let size = parseInt(q.pageSize, 10);
  if (!Number.isFinite(size) || size < 0) size = DEFAULT_PAGE_SIZE;
  if (size === 0) size = MAX_PAGE_SIZE; // 「全部」在服务端仍保留上限
  size = Math.min(size, MAX_PAGE_SIZE);
  return { page, size, offset: (page - 1) * size };
}

const text = v => String(v == null ? '' : v).trim();
const like = v => `%${text(v)}%`;
const has = v => text(v) !== '';

// 出库对方的展示口径与台账一致：去向 / 领用人
const outParty = a => `TRIM(COALESCE(${a}.destination,'') || CASE WHEN TRIM(COALESCE(${a}.receiver,''))='' THEN '' ELSE ' / ' || ${a}.receiver END)`;

// ==================== 单据查询 ====================
// 三个来源统一成同一列集合；盘点单状态 confirmed 在此映射为 posted
const DOCS_UNION = `
  SELECT od.doc_no AS doc_no, od.date AS date, od.txn_type AS doc_type, 'inbound' AS source,
         COALESCE(od.supplier,'') AS party, od.status AS status, COALESCE(od.handler,'') AS handler,
         COALESCE(od.origin_doc_no,'') AS origin_doc_no,
         (SELECT COUNT(*) FROM inbound l WHERE l.doc_no = od.doc_no) AS line_count,
         (SELECT COALESCE(SUM(l.amount),0) FROM inbound l WHERE l.doc_no = od.doc_no) AS amount
  FROM inbound_docs od
  UNION ALL
  SELECT od.doc_no, od.date, od.txn_type, 'outbound',
         ${outParty('od')}, od.status, COALESCE(od.handler,''),
         COALESCE(od.origin_doc_no,''),
         (SELECT COUNT(*) FROM outbound l WHERE l.doc_no = od.doc_no),
         (SELECT COALESCE(SUM(l.cost_amount),0) FROM outbound l WHERE l.doc_no = od.doc_no)
  FROM outbound_docs od
  UNION ALL
  SELECT s.stocktake_no, s.date, '盘点单', 'stocktake', '', CASE s.status WHEN 'confirmed' THEN 'posted' ELSE s.status END,
         COALESCE(s.handler,''), '',
         (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_no = s.stocktake_no),
         NULL
  FROM stocktakes s`;

const DOCS_SORT = {
  date: 'date',
  doc_no: 'doc_no',
  doc_type: 'doc_type',
  party: 'party',
  status: 'status',
  handler: 'handler',
  amount: 'amount',
};

function docsWhere(q) {
  const w = [];
  const p = [];
  if (has(q.docType)) { w.push('doc_type = ?'); p.push(text(q.docType)); }
  const status = text(q.status);
  if (status) {
    if (status === 'posted') w.push("status IN ('posted','confirmed')");
    else { w.push('status = ?'); p.push(status); }
  }
  if (has(q.startDate)) { w.push('date >= ?'); p.push(text(q.startDate)); }
  if (has(q.endDate)) { w.push('date <= ?'); p.push(text(q.endDate)); }
  if (has(q.docNo)) { w.push('doc_no LIKE ?'); p.push(like(q.docNo)); }
  if (has(q.party)) { w.push('party LIKE ?'); p.push(like(q.party)); }
  if (has(q.code)) {
    const k = like(q.code);
    w.push(`(
      (source='inbound' AND EXISTS (SELECT 1 FROM inbound l LEFT JOIN materials m ON m.code=l.code
        WHERE l.doc_no = x.doc_no AND (l.code LIKE ? OR m.name LIKE ? OR m.spec LIKE ?)))
      OR (source='outbound' AND EXISTS (SELECT 1 FROM outbound l LEFT JOIN materials m ON m.code=l.code
        WHERE l.doc_no = x.doc_no AND (l.code LIKE ? OR m.name LIKE ? OR m.spec LIKE ?)))
      OR (source='stocktake' AND EXISTS (SELECT 1 FROM stocktake_lines l LEFT JOIN materials m ON m.code=l.code
        WHERE l.stocktake_no = x.doc_no AND (l.code LIKE ? OR m.name LIKE ? OR m.spec LIKE ?)))
    )`);
    p.push(k, k, k, k, k, k, k, k, k);
  }
  return { sql: w.length ? ' WHERE ' + w.join(' AND ') : '', params: p };
}

router.get('/api/query/docs', requirePerm('query', 'view'), (req, res) => {
  const vp = req.canViewPrice;
  const { page, size, offset } = paging(req.query);
  const where = docsWhere(req.query);
  const sortKey = text(req.query.sortKey);
  const dir = text(req.query.sortDir) === 'asc' ? 'ASC' : 'DESC';
  const order = sortKey && DOCS_SORT[sortKey]
    ? `${DOCS_SORT[sortKey]} ${dir}, doc_no DESC`
    : 'date DESC, doc_no DESC';

  const base = `FROM (${DOCS_UNION}) x${where.sql}`;
  const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...where.params).c;
  const sum = db.prepare(`SELECT COALESCE(SUM(amount),0) AS amount, COUNT(DISTINCT doc_no) AS docs ${base}`).get(...where.params);
  const rows = db.prepare(`SELECT * ${base} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...where.params, size, offset);

  res.json({
    total: Number(total || 0),
    page,
    page_size: size,
    totals: vp
      ? { amount: sum.amount || 0, docs: Number(sum.docs || 0) }
      : { docs: Number(sum.docs || 0) },
    rows: rows.map(r => {
      const row = {
        doc_no: r.doc_no,
        doc_type: r.doc_type || '',
        date: r.date || '',
        party: r.party || '',
        status: r.status || '',
        handler: r.handler || '',
        source: r.source,
        origin_doc_no: r.origin_doc_no || '',
        line_count: Number(r.line_count || 0),
      };
      if (vp) row.amount = r.amount == null ? null : r.amount;
      return row;
    }),
  });
});

// ==================== 全局搜索 ====================
// 跨三个板块的轻量聚合：只返回「落到哪个板块 + 用什么键开卡」所需的最小字段。
// 单据复用上面的 DOCS_UNION 口径；物料 / 领用人只做关键字命中 + LIMIT，
// 不复制各板块的分页、金额聚合逻辑（金额栏仅在 canViewPrice 时下发）。
const SEARCH_LIMIT_DEFAULT = 5;
const SEARCH_LIMIT_MAX = 10;

// 用户输入按字面量匹配：转义 LIKE 通配符，避免 % / _ 被当成通配
function likeEsc(v) {
  return '%' + text(v).replace(/[\\%_]/g, c => '\\' + c) + '%';
}

router.get('/api/query/search', requirePerm('query', 'view'), (req, res) => {
  const kw = text(req.query.q);
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = SEARCH_LIMIT_DEFAULT;
  limit = Math.min(limit, SEARCH_LIMIT_MAX);
  const empty = { materials: { total: 0, rows: [] }, docs: { total: 0, rows: [] }, receivers: { total: 0, rows: [] } };
  if (!kw) return res.json({ keyword: '', limit, groups: empty });

  const k = likeEsc(kw);
  const vp = req.canViewPrice;

  // 物料：编码 / 名称 / 规格；停用物料与库存汇总口径一致，不进入结果
  // 注意：数量列保持原名 stock_qty 输出，别直接别名成 on_hand——scaled-db 按结果列名还原定点数
  const matWhere = `(m.code LIKE ? ESCAPE '\\' OR m.name LIKE ? ESCAPE '\\' OR m.spec LIKE ? ESCAPE '\\')
    AND (m.status IS NULL OR m.status = '' OR m.status <> '停用')`;
  const matTotal = db.prepare(`SELECT COUNT(*) AS c FROM materials m WHERE ${matWhere}`).get(k, k, k).c;
  const matRows = db.prepare(`SELECT m.code, m.name, m.spec, m.unit, COALESCE(b.stock_qty,0) AS stock_qty
    FROM materials m LEFT JOIN stock_balance b ON b.code = m.code
    WHERE ${matWhere} ORDER BY m.code LIMIT ?`).all(k, k, k, limit);

  // 单据：单号 / 对方（入库对方即供应商，出库对方含去向与领用人）
  const docWhere = `(doc_no LIKE ? ESCAPE '\\' OR party LIKE ? ESCAPE '\\')`;
  const docBase = `FROM (${DOCS_UNION}) x WHERE ${docWhere}`;
  const docTotal = db.prepare(`SELECT COUNT(*) AS c ${docBase}`).get(k, k).c;
  const docRows = db.prepare(`SELECT * ${docBase} ORDER BY date DESC, doc_no DESC LIMIT ?`).all(k, k, limit);

  // 领用人：与领用人列表同源（正常出库 + 已过账 + 有领用人），只取姓名与单数
  const rcvWhere = `od.txn_type='正常出库' AND od.status='posted' AND TRIM(COALESCE(od.receiver,''))<>''
    AND od.receiver LIKE ? ESCAPE '\\'`;
  const rcvTotal = db.prepare(`SELECT COUNT(*) AS c FROM (
    SELECT od.receiver FROM outbound_docs od WHERE ${rcvWhere} GROUP BY od.receiver)`).get(k).c;
  const rcvRows = db.prepare(`SELECT od.receiver AS receiver, COUNT(DISTINCT od.doc_no) AS doc_count,
      MAX(od.date) AS last_date
    FROM outbound_docs od WHERE ${rcvWhere}
    GROUP BY od.receiver ORDER BY doc_count DESC, last_date DESC, od.receiver LIMIT ?`).all(k, limit);

  res.json({
    keyword: kw,
    limit,
    groups: {
      materials: {
        total: Number(matTotal || 0),
        rows: matRows.map(r => ({
          code: r.code,
          name: r.name || '',
          spec: r.spec || '',
          unit: r.unit || '',
          on_hand: r.stock_qty || 0,
        })),
      },
      docs: {
        total: Number(docTotal || 0),
        rows: docRows.map(r => {
          const row = {
            doc_no: r.doc_no,
            doc_type: r.doc_type || '',
            date: r.date || '',
            party: r.party || '',
            status: r.status || '',
            source: r.source,
          };
          if (vp) row.amount = r.amount == null ? null : r.amount;
          return row;
        }),
      },
      receivers: {
        total: Number(rcvTotal || 0),
        rows: rcvRows.map(r => ({
          receiver: r.receiver,
          doc_count: Number(r.doc_count || 0),
          last_date: r.last_date || '',
        })),
      },
    },
  });
});

// ==================== 领用人查询 ====================
// 口径：净领用 = 正常出库数量 − 已关联领料退库数量（退库按原出库行的领用人归集）
router.get('/api/query/receivers', requirePerm('query', 'view'), (req, res) => {
  const vp = req.canViewPrice;
  const w = ["od.txn_type='正常出库'", "od.status='posted'", "TRIM(COALESCE(od.receiver,''))<>''"];
  const p = [];
  if (has(req.query.startDate)) { w.push('od.date >= ?'); p.push(text(req.query.startDate)); }
  if (has(req.query.endDate)) { w.push('od.date <= ?'); p.push(text(req.query.endDate)); }
  if (has(req.query.keyword)) { w.push('od.receiver LIKE ?'); p.push(like(req.query.keyword)); }

  const rows = db.prepare(`SELECT od.receiver AS receiver,
      COUNT(DISTINCT od.doc_no) AS doc_count,
      COUNT(DISTINCT o.code) AS material_kinds,
      COALESCE(SUM(o.qty),0) AS total_qty,
      COALESCE(SUM(o.cost_amount),0) AS total_amount,
      MAX(od.date) AS last_date
    FROM outbound_docs od JOIN outbound o ON o.doc_no = od.doc_no
    WHERE ${w.join(' AND ')}
    GROUP BY od.receiver
    ORDER BY last_date DESC, receiver`).all(...p);

  // 已退数量：领料退库行指向的原出库行 → 原出库单的领用人
  // 口径：只统计已过账的领料退库行，且原出库行/原出库单也必须已过账，
  //       与上方列表、详情卡汇总保持同一组数
  const returned = new Map();
  db.prepare(`SELECT od.receiver AS receiver, COALESCE(SUM(r.qty),0) AS total_qty
    FROM outbound r
    JOIN outbound origin ON origin.id = r.origin_line_id
    JOIN outbound_docs od ON od.doc_no = origin.doc_no
    WHERE r.txn_type='领料退库' AND r.status='posted' AND origin.status='posted' AND ${w.join(' AND ')}
    GROUP BY od.receiver`).all(...p).forEach(r => returned.set(r.receiver, Math.abs(Number(r.total_qty || 0))));

  res.json({
    rows: rows.map(r => {
      const back = returned.get(r.receiver) || 0;
      const row = {
        receiver: r.receiver,
        doc_count: Number(r.doc_count || 0),
        material_kinds: Number(r.material_kinds || 0),
        out_qty: r.total_qty || 0,
        returned_qty: back,
        net_qty: Math.round(((r.total_qty || 0) - back) * 1000000) / 1000000,
      };
      if (vp) row.amount = r.total_amount || 0;
      row.last_date = r.last_date || '';
      return row;
    }),
  });
});

router.get('/api/query/receivers/:name', requirePerm('query', 'view'), (req, res) => {
  const vp = req.canViewPrice;
  const name = req.params.name;
  // 只统计已过账单据：草稿/作废都不进入清单，与列表口径一致
  const docs = db.prepare(`SELECT od.doc_no AS doc_no, od.date AS date, od.destination AS destination,
      od.handler AS handler, od.status AS status,
      COUNT(o.id) AS line_count, COALESCE(SUM(o.qty),0) AS total_qty,
      COALESCE(SUM(o.cost_amount),0) AS total_amount
    FROM outbound_docs od LEFT JOIN outbound o ON o.doc_no = od.doc_no
    WHERE od.txn_type='正常出库' AND od.receiver=? AND od.status='posted'
    GROUP BY od.doc_no
    ORDER BY od.date DESC, od.doc_no DESC`).all(name);

  // 每单「已退」= 关联到该单原出库行、且已过账的领料退库数量
  const back = new Map();
  db.prepare(`SELECT origin.doc_no AS base_doc, COALESCE(SUM(r.qty),0) AS total_qty
    FROM outbound r JOIN outbound origin ON origin.id = r.origin_line_id
    WHERE r.txn_type='领料退库' AND r.status='posted' AND origin.status='posted'
      AND origin.doc_no IN (SELECT doc_no FROM outbound_docs WHERE txn_type='正常出库' AND receiver=? AND status='posted')
    GROUP BY origin.doc_no`).all(name).forEach(r => back.set(r.base_doc, Math.abs(Number(r.total_qty || 0))));

  const rows = docs.map(d => {
    const row = {
      doc_no: d.doc_no,
      date: d.date || '',
      destination: d.destination || '',
      handler: d.handler || '',
      status: d.status || '',
      line_count: Number(d.line_count || 0),
      qty: d.total_qty || 0,
    };
    if (vp) row.amount = d.total_amount || 0;
    row.returned_qty = back.get(d.doc_no) || 0;
    return row;
  });
  const summary = rows.reduce((s, d) => {
    const next = {
      doc_count: s.doc_count + 1,
      qty: s.qty + d.qty,
      returned_qty: s.returned_qty + d.returned_qty,
    };
    if (vp) next.amount = s.amount + d.amount;
    return next;
  }, vp ? { doc_count: 0, qty: 0, amount: 0, returned_qty: 0 } : { doc_count: 0, qty: 0, returned_qty: 0 });
  summary.net_qty = Math.round((summary.qty - summary.returned_qty) * 1000000) / 1000000;

  // 物料构成：按物料聚合该领用人的正常出库数量与金额（仅已过账单据，与 summary 口径一致）
  const materials = db.prepare(`SELECT o.code AS code, COALESCE(m.name,'') AS name, COALESCE(m.spec,'') AS spec,
      COALESCE(m.unit,'') AS unit,
      COALESCE(SUM(o.qty),0) AS qty, COALESCE(SUM(o.cost_amount),0) AS amount
    FROM outbound o JOIN outbound_docs od ON od.doc_no = o.doc_no
    LEFT JOIN materials m ON m.code = o.code
    WHERE od.txn_type='正常出库' AND od.receiver=? AND od.status='posted'
    GROUP BY o.code
    ORDER BY amount DESC, qty DESC, o.code`).all(name).map(r => {
    const row = {
      code: r.code,
      name: r.name || '',
      spec: r.spec || '',
      unit: r.unit || '',
      qty: Number(r.qty || 0),
    };
    if (vp) row.amount = Number(r.amount || 0);
    return row;
  });

  res.json({ receiver: name, summary, rows, materials });
});

// ==================== 库存分析（只读） ====================
// 数据源统一为 stock_ledger（成本核算权威流水）+ stock_balance（最新余额快照），不新建表。
// 数量 1e6 / 金额 1e2 / 单价 1e8 的定点换算由 scaled-db 按列名自动完成。

const pad2 = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => fmtDate(new Date());
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const r8 = v => Math.round((Number(v) || 0) * 1e8) / 1e8;

function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function daysBetween(a, b) {
  const x = parseDay(a), y = parseDay(b);
  return (x == null || y == null) ? null : Math.round((y - x) / 86400000);
}
// 区间口径：按自然月对齐（本月 = 当月 1 日至今；近 N 月 = 含本月在内往前 N-1 个月的 1 日至今）
function rangeOf(q) {
  const key = ['month', '3m', '6m', '12m'].includes(text(q.range)) ? text(q.range) : '3m';
  const n = { month: 1, '3m': 3, '6m': 6, '12m': 12 }[key];
  const now = new Date();
  const startDate = fmtDate(new Date(now.getFullYear(), now.getMonth() - (n - 1), 1));
  const endDate = fmtDate(now);
  return { key, startDate, endDate, days: Math.max(1, daysBetween(startDate, endDate) + 1) };
}

/**
 * 呆滞分析
 * 判定：当前结存 > 0，且「最后一次正常出库」距今天数 > 阈值（无出库记录时退化为最后一次流水日期）。
 * 说明：判定「区间内无出库」与「距最后一次出库 > 阈值」等价，直接按后者实现，避免两个条件重复。
 * 参数：days（30/60/90/180 或自定义，默认 90）
 */
router.get('/api/analysis/stagnant', requirePerm('query', 'view'), (req, res) => {
  const vp = req.canViewPrice;
  let limitDays = parseInt(req.query.days, 10);
  if (!Number.isFinite(limitDays) || limitDays < 1) limitDays = 90;
  limitDays = Math.min(limitDays, 3650);

  const today = todayStr();
  const totalStockAmount = vp
    ? (db.prepare('SELECT COALESCE(SUM(stock_amount),0) AS amount FROM stock_balance').get().amount || 0)
    : 0;

  const raw = db.prepare(`
    SELECT m.code, m.name, m.spec, m.unit, m.category,
           b.stock_qty AS stock_qty, b.stock_amount AS stock_amount, b.avg_cost AS avg_cost,
           lo.last_out_date AS last_out_date, lf.last_flow_date AS last_flow_date
    FROM materials m
    JOIN stock_balance b ON b.code = m.code
    LEFT JOIN (SELECT code, MAX(business_date) AS last_out_date
               FROM stock_ledger
               WHERE status='active' AND source_type='outbound' AND business_type='正常出库' AND qty_out > 0
               GROUP BY code) lo ON lo.code = m.code
    LEFT JOIN (SELECT code, MAX(business_date) AS last_flow_date
               FROM stock_ledger WHERE status='active' GROUP BY code) lf ON lf.code = m.code
    WHERE b.stock_qty > 0 AND COALESCE(m.status,'') <> '停用'
  `).all();

  const rows = [];
  for (const r of raw) {
    const lastOut = r.last_out_date || '';
    const lastFlow = r.last_flow_date || '';
    // 从未出库：用最后一次流水日期兜底；连流水都没有则视为长期呆滞（days_idle = null）
    const base = lastOut || lastFlow;
    const idle = base ? daysBetween(base, today) : null;
    if (idle != null && idle <= limitDays) continue;
    rows.push({
      code: r.code,
      name: r.name || '',
      spec: r.spec || '',
      unit: r.unit || '',
      category: r.category || '',
      on_hand: r.stock_qty || 0,
      stock_value: r2(r.stock_amount),
      avg_cost: r8(r.avg_cost),
      last_out_date: lastOut,
      last_flow_date: lastFlow,
      days_idle: idle,
      never_out: !lastOut,
    });
  }
  // 默认最久未出库在前；无任何流水（days_idle = null）视为最呆滞
  rows.sort((a, b) => {
    const da = a.days_idle == null ? Number.MAX_SAFE_INTEGER : a.days_idle;
    const db2 = b.days_idle == null ? Number.MAX_SAFE_INTEGER : b.days_idle;
    return db2 - da || b.stock_value - a.stock_value || a.code.localeCompare(b.code);
  });

  const stockValue = rows.reduce((s, r) => s + r.stock_value, 0);
  // 无价格权限：金额 / 均价 / 占比整组不下发（数量、天数保留）
  const outRows = vp ? rows : rows.map(r => {
    const o = { ...r };
    delete o.stock_value;
    delete o.avg_cost;
    return o;
  });
  res.json({
    days: limitDays,
    as_of: today,
    rows: outRows,
    summary: vp
      ? {
        count: rows.length,
        stock_value: r2(stockValue),
        share: totalStockAmount > 0 ? r2(stockValue / totalStockAmount * 10000) / 100 : 0,
        total_stock_value: r2(totalStockAmount),
      }
      : { count: rows.length },
  });
});

/** 区间净出库成本（按物料）：正常出库成本 − 已过账领料退库恢复成本 */
function netOutCostMap(startDate, endDate) {
  const map = new Map();
  db.prepare(`
    SELECT code,
      COALESCE(SUM(CASE WHEN business_type='正常出库' THEN amount_out ELSE 0 END),0) AS amount_out,
      COALESCE(SUM(CASE WHEN business_type='领料退库' THEN amount_in ELSE 0 END),0) AS amount_in
    FROM stock_ledger
    WHERE status='active' AND source_type='outbound' AND business_date >= ? AND business_date <= ?
    GROUP BY code
  `).all(startDate, endDate).forEach(r => {
    map.set(r.code, Math.max(0, (Number(r.amount_out) || 0) - (Number(r.amount_in) || 0)));
  });
  return map;
}

/**
 * ABC 分类
 * 口径：区间「净出库成本」= 正常出库成本 − 领料退库恢复成本（成本口径，非售价）。
 * 分类：按净出库成本降序累计，加入本行前的累计占比 < 70% 为 A、< 90% 为 B，其余为 C；
 *      区间内净出库为 0 但有库存的归「无出库」。跨过 70%/90% 的那一行仍留在原类，
 *      否则单一物料占 100% 时会出现 A 类为空的反常结果。
 * 参数：range（month/3m/6m/12m，默认 3m）
 */
router.get('/api/analysis/abc', requirePerm('query', 'view'), (req, res) => {
  const vp = req.canViewPrice;
  const range = rangeOf(req.query);
  const mats = db.prepare(`
    SELECT m.code, m.name, m.spec, m.unit, m.category,
           COALESCE(b.stock_qty,0) AS stock_qty, COALESCE(b.stock_amount,0) AS stock_amount
    FROM materials m LEFT JOIN stock_balance b ON b.code = m.code
    WHERE COALESCE(m.status,'') <> '停用'
  `).all();
  const netMap = netOutCostMap(range.startDate, range.endDate);

  const rows = mats.map(m => ({
    code: m.code,
    name: m.name || '',
    spec: m.spec || '',
    unit: m.unit || '',
    category: m.category || '',
    out_amount: r2(netMap.get(m.code) || 0),
    share: 0,
    cum_share: 0,
    abc: '',
    on_hand: m.stock_qty || 0,
    stock_value: r2(m.stock_amount),
  }));

  const positive = rows.filter(r => r.out_amount > 0).sort((a, b) => b.out_amount - a.out_amount || a.code.localeCompare(b.code));
  const total = positive.reduce((s, r) => s + r.out_amount, 0);
  let cum = 0;
  for (const r of positive) {
    const before = cum;
    cum += r.out_amount;
    r.share = total > 0 ? r.out_amount / total : 0;
    r.cum_share = total > 0 ? cum / total : 0;
    r.abc = before / total < 0.7 ? 'A' : (before / total < 0.9 ? 'B' : 'C');
  }
  for (const r of rows) {
    if (r.out_amount > 0) continue;
    r.abc = r.on_hand > 0 ? 'N' : '';
    r.out_amount = 0;
  }

  const order = { A: 0, B: 1, C: 2, N: 3, '': 4 };
  const keep = rows.filter(r => r.abc !== '');
  keep.sort((a, b) => order[a.abc] - order[b.abc] || b.out_amount - a.out_amount || b.stock_value - a.stock_value || a.code.localeCompare(b.code));

  const summary = { A: { count: 0, out_amount: 0, share: 0, stock_value: 0 },
    B: { count: 0, out_amount: 0, share: 0, stock_value: 0 },
    C: { count: 0, out_amount: 0, share: 0, stock_value: 0 },
    N: { count: 0, out_amount: 0, share: 0, stock_value: 0 } };
  keep.forEach(r => {
    const s = summary[r.abc];
    s.count += 1;
    s.out_amount += r.out_amount;
    s.stock_value += r.stock_value;
  });
  Object.keys(summary).forEach(k => {
    summary[k].out_amount = r2(summary[k].out_amount);
    summary[k].stock_value = r2(summary[k].stock_value);
    summary[k].share = total > 0 && k !== 'N' ? r2(summary[k].out_amount / total * 10000) / 100 : 0;
  });

  // 无价格权限：出库金额 / 占比 / 累计占比 / 库存金额整组不下发，仅保留分类与数量口径
  const outRows = vp ? keep : keep.map(r => {
    const o = { ...r };
    delete o.out_amount;
    delete o.share;
    delete o.cum_share;
    delete o.stock_value;
    return o;
  });
  const outSummary = vp
    ? summary
    : { A: { count: summary.A.count }, B: { count: summary.B.count }, C: { count: summary.C.count }, N: { count: summary.N.count } };

  const body = {
    range: range.key,
    start_date: range.startDate,
    end_date: range.endDate,
  };
  if (vp) body.total_amount = r2(total);
  body.rows = outRows;
  body.summary = outSummary;
  res.json(body);
});

/**
 * 库存周转率
 * 口径：周转率 = 区间净出库成本 ÷ 区间平均库存金额；
 *      平均库存金额 = 区间内「每日结存金额」的算术平均（逐日回放有效流水，含期初），比期初期末两点法更能反映真实占用。
 * 参数：range（month/3m/6m/12m，默认 3m）
 */
router.get('/api/analysis/turnover', requirePerm('query', 'view'), (req, res) => {
  const vp = req.canViewPrice;
  const range = rangeOf(req.query);
  const netMap = netOutCostMap(range.startDate, range.endDate);

  const mats = db.prepare(`
    SELECT m.code, m.name, m.spec, m.unit, m.category,
           COALESCE(b.stock_qty,0) AS stock_qty, COALESCE(b.stock_amount,0) AS stock_amount
    FROM materials m LEFT JOIN stock_balance b ON b.code = m.code
    WHERE COALESCE(m.status,'') <> '停用'
  `).all();

  // 逐日结存金额：按业务日期回放有效流水的金额增减（不依赖存储快照，回溯改单后仍然自洽）
  const deltaMap = new Map();
  db.prepare(`
    SELECT code, business_date, COALESCE(amount_in,0) AS amount_in, COALESCE(amount_out,0) AS amount_out
    FROM stock_ledger
    WHERE status='active' AND business_date <= ?
    ORDER BY code, business_date, posting_sequence, id
  `).all(range.endDate).forEach(r => {
    if (!deltaMap.has(r.code)) deltaMap.set(r.code, []);
    deltaMap.get(r.code).push([r.business_date, (Number(r.amount_in) || 0) - (Number(r.amount_out) || 0)]);
  });

  const avgMap = new Map();
  for (const [code, list] of deltaMap) {
    let cur = 0, idx = 0, sum = 0;
    let d = parseDay(range.startDate);
    const end = parseDay(range.endDate);
    while (d != null && d <= end) {
      const day = new Date(d).toISOString().slice(0, 10);
      while (idx < list.length && list[idx][0] <= day) { cur += list[idx][1]; idx += 1; }
      sum += cur;
      d += 86400000;
    }
    avgMap.set(code, sum / range.days);
  }

  const catMap = new Map();
  let outCost = 0, avgStock = 0;
  const matsOut = mats.map(m => {
    const out = netMap.get(m.code) || 0;
    const avg = avgMap.get(m.code) || 0;
    outCost += out;
    avgStock += avg;
    const key = m.category || '';
    const c = catMap.get(key) || { category: key, out_cost: 0, avg_stock: 0 };
    c.out_cost += out;
    c.avg_stock += avg;
    catMap.set(key, c);
    const turns = avg > 0 ? out / avg : null;
    return {
      code: m.code, name: m.name || '', spec: m.spec || '', unit: m.unit || '', category: m.category || '',
      on_hand: m.stock_qty || 0, stock_value: r2(m.stock_amount),
      out_cost: r2(out), avg_stock: r2(avg),
      turns: turns == null ? null : Math.round(turns * 10000) / 10000,
      turn_days: turns != null && turns > 0 ? Math.round(range.days / turns * 10) / 10 : null,
    };
  });

  const rate = avgStock > 0 ? outCost / avgStock : null;
  const turnDays = rate != null && rate > 0 ? Math.round(range.days / rate * 10) / 10 : null;

  const categories = [...catMap.values()]
    .filter(c => c.avg_stock > 0 || c.out_cost > 0)
    .map(c => {
      const t = c.avg_stock > 0 ? c.out_cost / c.avg_stock : null;
      const row = {
        category: c.category || '',
      };
      if (vp) {
        row.out_cost = r2(c.out_cost);
        row.avg_stock = r2(c.avg_stock);
      }
      row.turns = t == null ? null : Math.round(t * 10000) / 10000;
      row.turn_days = t != null && t > 0 ? Math.round(range.days / t * 10) / 10 : null;
      return row;
    })
    .sort((a, b) => (b.out_cost || 0) - (a.out_cost || 0) || a.category.localeCompare(b.category));

  const slowest = matsOut
    .filter(m => m.avg_stock > 0)
    .sort((a, b) => (a.turns == null ? 0 : a.turns) - (b.turns == null ? 0 : b.turns) || b.avg_stock - a.avg_stock)
    .slice(0, 10)
    .map(m => {
      const row = {
        code: m.code, name: m.name, spec: m.spec, unit: m.unit, category: m.category,
        on_hand: m.on_hand,
      };
      if (vp) {
        row.stock_value = m.stock_value;
        row.out_cost = m.out_cost;
        row.avg_stock = m.avg_stock;
      }
      row.turns = m.turns;
      row.turn_days = m.turn_days;
      return row;
    });

  const body = {
    range: range.key,
    start_date: range.startDate,
    end_date: range.endDate,
    days: range.days,
  };
  if (vp) {
    body.out_cost = r2(outCost);
    body.avg_stock = r2(avgStock);
  }
  body.turns = rate == null ? null : Math.round(rate * 10000) / 10000;
  body.turn_days = turnDays;
  body.no_avg = !(avgStock > 0);
  body.categories = categories;
  body.slowest = slowest;
  res.json(body);
});

module.exports = router;
