/**
 * 库存盘点
 */
const express = require('express');
const db = require('../db');
const costing = require('../services/costing');
const { requirePerm } = require('../middleware/auth');
const { hasGrant } = require('../permissions');
const { kwClause } = require('../utils/search');
const { clientIp } = require('../utils/client-ip');
const {
  genStocktakeNo,
  getAvailableStock,
} = require('../services/stock');
const time = require('../services/time');
const audit = require('../services/audit');
const { packDetail } = require('../services/logdetail');
const { isBusy, busyBody, businessError, withEn } = require('../services/errors');

const router = express.Router();

// ==================== 库存盘点 ====================
// 设计要点（来自已确认方案）：
//   1. 盘点不直接改库存：确认后自动生成库存调整流水，由流水改库存。
//      系统已取消独立的「库存调整」模块，调整流水只由盘点确认产生（只读可查）。
//   2. 账面 book_qty 在未确认时为「创建盘点单时的账面快照」；确认时按最新库存刷新，
//      保证「确认时重新校验库存、防止盘点期间其他单据改变库存」。
//   3. count_qty 为 NULL 表示「未盘」（不生成调整）；0 表示「实盘为零」。
//   4. diff_qty = count_qty - book_qty（未盘为 NULL；确认时随 book_qty 一并刷新）。
//   5. 按物料维度盘点与调整（不区分位置）。
//   6. 已确认的盘点单不允许直接改/删，也不允许「反确认」；草稿可直接删除。
//      已确认后发现错误 → 新建盘点单纠正（不能直接改历史记录）。
//   7. 一次盘点确认在一个事务内一次性完成全部差异处理。
//   8. 每条调整流水记录来源盘点单、物料、调整数量、操作人与时间；
//      调整流水不再有独立单号，统一用来源 stocktake_no 追溯。

// 盘点候选物料：建单时按「全盘 / 按类别 / 按物料盘点」生成明细行
// 规则（关键约束）：
//   1. 账面数量必须是快照：建单时即固化 book_qty，后续不再动态读当前库存
//   2. 同一物料在一张盘点单中只能出现一次（DB 侧 UNIQUE(stocktake_no, code) 兜底）
//   3. 全盘/按类别只收录「有库存记录」的物料（含库存为 0 但有历史记录的），
//      不从物料档案全量拉取，避免把从未有过流水的物料也带进来
//   4. 指定物料可收录无库存记录的物料（账面按 0 处理，前端标记为「新增」）
// 「有库存记录」= 期初不为 0，或 stock_ledger 中存在该物料的任意流水（不限状态）。

// 候选物料查询：账面快照 book_qty 直接取 stock_balance（与库存汇总/台账同源），
// 不再用「期初 + Σ入库 - Σ出库 + Σ调整」另算一套。
const CANDIDATE_SELECT = `
  SELECT m.code, m.name, m.spec, m.category, m.unit, m.brand,
    COALESCE((SELECT b.stock_qty FROM stock_balance b WHERE b.code = m.code), 0) AS book_qty,
    (CASE
       WHEN COALESCE(m.opening_qty, 0) <> 0
         OR EXISTS(SELECT 1 FROM stock_ledger l WHERE l.code = m.code)
       THEN 1 ELSE 0 END
    ) AS has_record
  FROM materials m
`;

// 查询候选物料（只读，不写库）
//   scope: 'all' 全盘 / 'category' 按类别 / 'specified' 指定物料
function listCandidates(opts = {}) {
  const scope = opts.scope || 'all';
  const categories = (opts.categories || []).filter(Boolean);
  const codes = (opts.codes || []).filter(Boolean);
  const keyword = (opts.keyword || '').trim();
  const limit = Number(opts.limit) || 0;

  const where = ["(m.status IS NULL OR m.status = '' OR m.status <> '停用')"];
  const params = [];

  if (scope === 'category') {
    if (categories.length === 0) return [];
    where.push(`m.category IN (${categories.map(() => '?').join(',')})`);
    params.push(...categories);
  }
  if (codes.length > 0) {
    where.push(`m.code IN (${codes.map(() => '?').join(',')})`);
    params.push(...codes);
  }
  if (keyword) {
    const k = kwClause(['m.code', 'm.name', 'm.spec', 'm.brand'], keyword, { escape: true });
    if (k.sql) { where.push(k.sql); params.push(...k.params); }
  }

  // 子查询包裹后再过滤 has_record（SQLite 的 WHERE 不能直接引用同层列别名）
  let sql = `SELECT * FROM (${CANDIDATE_SELECT} WHERE ${where.join(' AND ')}) t`;
  // 全盘 / 按类别：仅收录有库存记录的物料；指定物料不限制（可盘新增物料）
  if (scope === 'all' || scope === 'category') sql += ' WHERE t.has_record = 1';
  sql += ' ORDER BY t.code';
  if (limit > 0) sql += ` LIMIT ${limit}`;

  return db.prepare(sql).all(...params).map(r => ({
    code: r.code, name: r.name, spec: r.spec, category: r.category,
    unit: r.unit, brand: r.brand,
    book_qty: Math.round(r.book_qty * 1000000) / 1000000,
    has_record: !!r.has_record,
    is_new: !r.has_record,
  }));
}

// 记录盘点单操作日志（对齐 inbound_doc_logs / outbound_doc_logs）
function logStocktake(no, action, operator, detail) {
  const d = packDetail(detail);
  db.prepare('INSERT INTO stocktake_logs (stocktake_no, action, operator, detail, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(no, action, operator || '', d.text, d.json);
}

// 当前操作者名称（对齐出入库：优先姓名，其次登录名）
function operatorOf(req) {
  return req.user?.name || req.user?.username || '';
}

// ==================== 覆盖式更正：版本留痕 ====================
// 每次生效的更正写一条版本记录（谁、何时、旧实盘/差异 → 新实盘/差异）。
// revision 为同一盘点行内的连续序号，从 1（确认落账）开始递增。
// 草稿态更正的 adjustment_id 记 0，表示尚未物化调整、不影响库存。
function nextRevision(no, code) {
  const r = db.prepare(`SELECT COALESCE(MAX(revision),0) AS m FROM stock_adjustment_versions
    WHERE stocktake_no=? AND code=?`).get(no, code);
  return Number(r.m) + 1;
}

function logAdjVersion(row) {
  db.prepare(`INSERT INTO stock_adjustment_versions
    (adjustment_id, stocktake_no, code, revision, qty_before, qty_after,
     diff_before, diff_after, reason, operator)
    VALUES (@adjustment_id, @stocktake_no, @code, @revision, @qty_before, @qty_after,
     @diff_before, @diff_after, @reason, @operator)`).run({
    adjustment_id: Number(row.adjustment_id) || 0,
    stocktake_no: row.stocktake_no,
    code: row.code,
    revision: row.revision,
    qty_before: row.qty_before === undefined ? null : row.qty_before,
    qty_after: row.qty_after === undefined ? null : row.qty_after,
    diff_before: row.diff_before === undefined ? null : row.diff_before,
    diff_after: row.diff_after === undefined ? null : row.diff_after,
    reason: row.reason || '',
    operator: row.operator || '',
  });
}

const roundQty = n => Math.round(Number(n) * 1000000) / 1000000;

// 盘点单列表
router.get('/api/stocktakes', requirePerm('stocktake', 'view'), (req, res) => {
  const { status, startDate, endDate, keyword } = req.query;
  let sql = `SELECT s.*,
      (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_no = s.stocktake_no) AS line_count,
      (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_no = s.stocktake_no AND l.count_qty IS NOT NULL) AS counted_count,
      (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_no = s.stocktake_no AND l.diff_qty IS NOT NULL AND l.diff_qty <> 0) AS diff_count
    FROM stocktakes s WHERE 1=1`;
  const params = [];
  if (status) { sql += " AND s.status=?"; params.push(status); }
  if (startDate) { sql += " AND s.date>=?"; params.push(startDate); }
  if (endDate) { sql += " AND s.date<=?"; params.push(endDate); }
  if (keyword) {
    const k = kwClause(['s.stocktake_no', 's.handler', 's.remarks', 's.category_filter'], keyword);
    if (k.sql) { sql += ' AND ' + k.sql; params.push(...k.params); }
  }
  sql += " ORDER BY s.date DESC, s.id DESC";
  res.json(db.prepare(sql).all(...params));
});

// 生成下一个盘点单号（供前端预览）
router.get('/api/stocktakes/next-no', requirePerm('stocktake', 'view'), (req, res) => {
  const date = req.query.date || time.todayLocal();
  res.json({ stocktake_no: genStocktakeNo(date) });
});

// 盘点候选物料查询（供「指定物料」搜索与三种方式预览）
//   query: scope=all|category|specified, category=a,b, keyword=xxx, limit=n
//   scope=category 时才按 category 过滤；scope=specified 时可带 keyword 模糊搜索
router.get('/api/stocktakes/candidates', requirePerm('stocktake', 'view'), (req, res) => {
  const scope = req.query.scope || 'specified';
  const categories = String(req.query.category || '').split(',').map(s => s.trim()).filter(Boolean);
  const keyword = req.query.keyword || '';
  const limit = Number(req.query.limit) || 0;
  res.json(listCandidates({ scope, categories, keyword, limit }));
});

// 新建盘点单（草稿）：按所选范围一次性生成盘点明细
// body: { date?, handler?, remarks?, scope: 'all'|'category'|'specified', categories?: [], codes?: [] }
//   - 范围在创建时固化到 load_scope；明细在同一事务内写入，book_qty 为创建时刻的账面快照
//   - 候选为空直接拒绝，不落空单（避免「先建单、后失败」的半成品）
router.post('/api/stocktakes', requirePerm('stocktake', 'manage'), (req, res) => {
  const body = req.body || {};
  const date = body.date || time.todayLocal();
  const handler = body.handler || operatorOf(req);
  const remarks = body.remarks || '';
  const scope = ['all', 'category', 'specified'].includes(body.scope) ? body.scope : 'all';
  const categories = Array.isArray(body.categories) ? body.categories.filter(Boolean) : [];
  const rawCodes = Array.isArray(body.codes) ? body.codes.map(c => String(c || '').trim()).filter(Boolean) : [];
  const codes = [...new Set(rawCodes)];

  if (scope === 'category' && categories.length === 0) {
    return res.status(400).json({ error: '请选择至少一个物料类别' });
  }
  if (scope === 'specified' && codes.length === 0) {
    return res.status(400).json({ error: '请选择至少一个物料' });
  }
  if (scope === 'specified' && rawCodes.length !== codes.length) {
    return res.status(400).json({ error: '同一物料不能重复选择', code: 'DUPLICATE_MATERIAL' });
  }

  let candidates = listCandidates({ scope, categories, codes });
  if (scope === 'specified') {
    // 按弹窗内行顺序生成明细；同时校验所选物料是否都有效
    if (candidates.length !== codes.length) {
      return res.status(400).json({ error: '部分所选物料不存在或已停用，请重新选择' });
    }
    const byCode = new Map(candidates.map(r => [r.code, r]));
    candidates = codes.map(c => byCode.get(c)).filter(Boolean);
  }
  if (candidates.length === 0) {
    if (scope === 'category') return res.status(400).json({ error: '该类别暂无符合条件的库存物料' });
    if (scope === 'specified') return res.status(400).json({ error: '所选物料不存在或已停用' });
    return res.status(400).json({ error: '当前没有可盘点的库存物料，请先在物料档案登记并产生出入库流水' });
  }

  const categoryFilter = scope === 'category' ? categories.join(',') : '';
  const no = genStocktakeNo(date);

  const insLine = db.prepare(`INSERT INTO stocktake_lines
    (stocktake_no, code, book_qty, count_qty, diff_qty, status, remarks)
    VALUES (@stocktake_no, @code, @book_qty, NULL, NULL, 'pending', '')`);
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO stocktakes
      (stocktake_no, date, status, category_filter, load_scope, handler, remarks, created_by)
      VALUES (@stocktake_no, @date, 'draft', @category_filter, @load_scope, @handler, @remarks, @created_by)`)
      .run({
        stocktake_no: no, date, category_filter: categoryFilter, load_scope: scope,
        handler, remarks, created_by: req.user?.username || '',
      });
    candidates.forEach(r => insLine.run({ stocktake_no: no, code: r.code, book_qty: r.book_qty }));
  });
  tx();

  logStocktake(no, 'create', operatorOf(req),
    { key: 'audit_detail_st_create', params: { n: candidates.length } });
  res.json({
    success: true, stocktake_no: no, status: 'draft',
    loaded_count: candidates.length, scope, load_scope: scope, category_filter: categoryFilter,
  });
});

// 删除盘点单（仅草稿可删；已确认的单据不可删，需新建盘点单纠正）
router.delete('/api/stocktakes/:no', requirePerm('stocktake', 'delete'), (req, res) => {
  const st = db.prepare('SELECT * FROM stocktakes WHERE stocktake_no=?').get(req.params.no);
  if (!st) return res.status(404).json({ error: '盘点单不存在' });
  if (st.status === 'confirmed') return res.status(400).json({ error: '已确认的盘点单不能删除，如需纠正请新建盘点单' });
  if (st.status !== 'draft') return res.status(400).json({ error: '只有草稿状态的盘点单可以删除' });

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM stocktake_lines WHERE stocktake_no=?').run(st.stocktake_no);
    db.prepare('DELETE FROM stocktake_logs WHERE stocktake_no=?').run(st.stocktake_no);
    db.prepare('DELETE FROM stock_adjustment_versions WHERE stocktake_no=?').run(st.stocktake_no);
    db.prepare('DELETE FROM stocktakes WHERE stocktake_no=?').run(st.stocktake_no);
  });
  tx();
  res.json({ success: true });
});

// 盘点单详情（含盘点行）
router.get('/api/stocktakes/:no', requirePerm('stocktake', 'view'), (req, res) => {
  const st = db.prepare('SELECT * FROM stocktakes WHERE stocktake_no=?').get(req.params.no);
  if (!st) return res.status(404).json({ error: '盘点单不存在' });

  const lines = db.prepare(`
    SELECT l.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit,
           m.category as material_category, m.brand as material_brand
    FROM stocktake_lines l LEFT JOIN materials m ON l.code = m.code
    WHERE l.stocktake_no=? ORDER BY l.id
  `).all(st.stocktake_no);

  const counted = lines.filter(l => l.count_qty !== null && l.count_qty !== undefined);
  const diffs = counted.filter(l => l.diff_qty !== 0);
  const gain = diffs.filter(l => l.diff_qty > 0).reduce((s, l) => s + l.diff_qty, 0);
  const loss = diffs.filter(l => l.diff_qty < 0).reduce((s, l) => s + l.diff_qty, 0);

  // 关联生成的调整流水（确认后反查；只读展示，含物料信息便于追溯）
  const adjustments = db.prepare(`
    SELECT a.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit,
           (SELECT sl.cost_basis FROM stock_ledger sl
             WHERE sl.source_type='adjust' AND sl.source_line_id=a.id AND sl.status='active'
             ORDER BY sl.posting_sequence DESC LIMIT 1) AS cost_basis
    FROM stock_adjustments a LEFT JOIN materials m ON a.code = m.code
    WHERE a.stocktake_no=? ORDER BY a.id
  `).all(st.stocktake_no);

  // 操作日志（对齐入库/出库单据）
  const logs = db.prepare('SELECT * FROM stocktake_logs WHERE stocktake_no=? ORDER BY id ASC')
    .all(st.stocktake_no);

  // 更正版本记录（覆盖式更正留痕；草稿态更正的 adjustment_id 为 0）
  const versions = db.prepare(`SELECT * FROM stock_adjustment_versions
    WHERE stocktake_no=? ORDER BY id ASC`).all(st.stocktake_no);

  // 盘点明细本身只有数量（book_qty/count_qty/diff_qty），无单价/金额列；
  // 唯一成本相关信息是调整流水的成本口径标记 cost_basis（如 CURRENT_AVG），
  // 无价格权限时一并隐藏，避免暴露计价口径。
  if (!req.canViewPrice) adjustments.forEach(a => { delete a.cost_basis; });

  res.json({
    ...st,
    lines,
    adjustments,
    versions,
    logs,
    summary: {
      line_count: lines.length,
      counted_count: counted.length,
      pending_count: lines.length - counted.length,
      matched_count: counted.filter(l => l.diff_qty === 0).length,
      diff_count: diffs.length,
      gain_qty: Math.round(gain * 1000000) / 1000000,
      loss_qty: Math.round(loss * 1000000) / 1000000
    }
  });
});

// 草稿态：追加物料行（增行）
// body: { codes: ['CB-0001', ...] }（单条也可用 { code: 'CB-0001' }）
//   - 仅 draft 可增行
//   - 账面数量取「加入时刻」的实时库存快照（与建单时同一口径，加入后不再动态读库）
//   - 同一物料在一张盘点单中只能出现一次（已存在则跳过，不报错）
//   - 无库存记录的物料也可加入，账面按 0 处理
router.post('/api/stocktakes/:no/lines', requirePerm('stocktake', 'manage'), (req, res) => {
  const st = db.prepare('SELECT * FROM stocktakes WHERE stocktake_no=?').get(req.params.no);
  if (!st) return res.status(404).json({ error: '盘点单不存在' });
  if (st.status !== 'draft') return res.status(400).json({ error: '只有草稿状态的盘点单可以增删物料' });

  const body = req.body || {};
  const raw = Array.isArray(body.codes) ? body.codes : (body.code ? [body.code] : []);
  const codes = [...new Set(raw.filter(Boolean))];
  if (codes.length === 0) return res.status(400).json({ error: '请选择要添加的物料' });

  const existing = new Set(db.prepare('SELECT code FROM stocktake_lines WHERE stocktake_no=?')
    .all(st.stocktake_no).map(r => r.code));

  const added = [];
  const skipped = [];
  codes.forEach(code => {
    if (existing.has(code)) { skipped.push(code); return; }
    const m = db.prepare("SELECT * FROM materials WHERE code=? AND (status IS NULL OR status='' OR status <> '停用')").get(code);
    if (!m) { skipped.push(code); return; }
    added.push(m);
  });

  if (added.length === 0) {
    return res.status(400).json({
      error: skipped.length === codes.length ? '所选物料已在盘点单中或不存在' : '所选物料不存在或已停用'
    });
  }

  const ins = db.prepare(`INSERT INTO stocktake_lines
    (stocktake_no, code, book_qty, count_qty, diff_qty, status, remarks)
    VALUES (?, ?, ?, NULL, NULL, 'pending', '')`);
  const tx = db.transaction(() => {
    added.forEach(m => ins.run(st.stocktake_no, m.code, getAvailableStock(m.code)));
  });
  tx();

  logStocktake(st.stocktake_no, 'add', operatorOf(req),
    { key: 'audit_detail_st_add', params: { list: added.map(m => m.code) } });
  res.json({ success: true, added_count: added.length, added: added.map(m => m.code), skipped });
});

// 草稿态：移除物料行（减行）
router.delete('/api/stocktakes/:no/lines/:id', requirePerm('stocktake', 'manage'), (req, res) => {
  const st = db.prepare('SELECT * FROM stocktakes WHERE stocktake_no=?').get(req.params.no);
  if (!st) return res.status(404).json({ error: '盘点单不存在' });
  if (st.status !== 'draft') return res.status(400).json({ error: '只有草稿状态的盘点单可以增删物料' });

  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM stocktake_lines WHERE id=? AND stocktake_no=?').get(id, st.stocktake_no);
  if (!row) return res.status(404).json({ error: '盘点行不存在' });

  db.prepare('DELETE FROM stocktake_lines WHERE id=?').run(id);
  db.prepare('DELETE FROM stock_adjustment_versions WHERE stocktake_no=? AND code=? AND adjustment_id=0')
    .run(st.stocktake_no, row.code);
  logStocktake(st.stocktake_no, 'remove', operatorOf(req), { key: 'audit_detail_st_remove', params: { code: row.code } });
  res.json({ success: true, code: row.code });
});

// 保存实盘数量（可多次保存草稿）
// body: { lines: [{ id, count_qty, remarks }] }
//   count_qty 为 null / undefined / '' → 未盘（清空该行实盘与差异）
router.put('/api/stocktakes/:no/lines', requirePerm('stocktake', 'manage'), (req, res) => {
  const st = db.prepare('SELECT * FROM stocktakes WHERE stocktake_no=?').get(req.params.no);
  if (!st) return res.status(404).json({ error: '盘点单不存在' });
  if (st.status !== 'draft') return res.status(400).json({ error: '只有草稿状态的盘点单可以修改实盘' });

  const body = req.body || {};
  const lines = Array.isArray(body.lines) ? body.lines : [];

  let updated = 0;
  const tx = db.transaction(() => {
    const sel = db.prepare('SELECT id, book_qty, remarks FROM stocktake_lines WHERE id=? AND stocktake_no=?');
    // 注意：better-sqlite3 不接受 undefined 绑定值，remarks 未传时必须保持原值，
    // 因此按是否传 remarks 分别用两条 UPDATE 语句。
    const updWithRemarks = db.prepare('UPDATE stocktake_lines SET count_qty=?, diff_qty=?, status=?, remarks=? WHERE id=?');
    const updNoRemarks = db.prepare('UPDATE stocktake_lines SET count_qty=?, diff_qty=?, status=? WHERE id=?');
    lines.forEach(l => {
      const row = sel.get(l.id, st.stocktake_no);
      if (!row) return;
      const raw = l.count_qty;
      const isEmpty = (raw === null || raw === undefined || raw === '');
      const hasRemarks = l.remarks !== undefined;
      const remarks = hasRemarks ? String(l.remarks) : row.remarks;
      if (isEmpty) {
        // 未盘：清空实盘与差异，状态回 pending
        if (hasRemarks) updWithRemarks.run(null, null, 'pending', remarks, row.id);
        else updNoRemarks.run(null, null, 'pending', row.id);
      } else {
        const cnt = Number(raw);
        if (!Number.isFinite(cnt)) throw new Error('实盘数量必须是数字');
        if (cnt < 0) throw new Error('实盘数量不能为负数');
        const diff = Math.round((cnt - row.book_qty) * 1000000) / 1000000;
        // 已录入即视为「已盘」：相符记 matched，有差异记 counted（不再误标为 pending/未盘）
        const lineStatus = diff === 0 ? 'matched' : 'counted';
        if (hasRemarks) updWithRemarks.run(cnt, diff, lineStatus, remarks, row.id);
        else updNoRemarks.run(cnt, diff, lineStatus, row.id);
      }
      updated++;
    });
  });

  try {
    tx();
    if (updated > 0) logStocktake(st.stocktake_no, 'save', operatorOf(req),
      { key: 'audit_detail_st_save', params: { n: updated } });
    res.json({ success: true, updated });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 差异更正（覆盖式）：对单行差异原地覆盖，不新建盘点单、不追加反向流水
// body: { count_qty?, reason?, accept_no_basis? }
//   - 基准固定为该行账面 book_qty，新差异 = 新实盘 - book_qty（不是与当前库存相减）
//   - draft：只改行数据（count_qty / diff_qty / status），不生成调整、不影响库存
//   - confirmed：覆盖该行唯一的有效调整与流水，原地改数量并重算结存；
//                差异归零时把调整与流水置作废；重复提交相同实盘返回 unchanged，不再记一笔
//   - 每次生效的更正写一条版本记录；并发用 BEGIN IMMEDIATE + 事务内状态守卫
router.post('/api/stocktakes/:no/lines/:id/correct', requirePerm('stocktake', 'correct'), (req, res) => {
  const st = db.prepare('SELECT * FROM stocktakes WHERE stocktake_no=?').get(req.params.no);
  if (!st) return res.status(404).json({ error: '盘点单不存在' });
  if (st.status !== 'draft' && st.status !== 'confirmed') {
    return res.status(400).json({ error: '只有草稿或已确认的盘点单可以更正差异' });
  }

  const id = Number(req.params.id);
  const body = req.body || {};
  const hasTarget = body.count_qty !== undefined && body.count_qty !== null && body.count_qty !== '';
  if (!hasTarget) {
    return res.status(400).json({ error: '请填写更正后的实盘数量', code: 'COUNT_REQUIRED' });
  }
  const target = Number(body.count_qty);
  if (!Number.isFinite(target) || target < 0) {
    return res.status(400).json({ error: '实盘数量必须是非负数字' });
  }

  const acceptNoBasis = body.accept_no_basis === true;
  if (acceptNoBasis && !hasGrant(req.grants, 'stocktake', 'no_basis')) {
    return res.status(403).json({ error: '需 stocktake:no_basis 授权方可按 0 成本入账', code: 'NO_BASIS_FORBIDDEN' });
  }

  const operator = operatorOf(req);
  const createdBy = req.user?.username || '';
  let payload = null;

  try {
    const tx = db.transaction(() => {
      // 事务内重读：跨实例并发更正同一行时，后到者按最新状态重新判断
      const head = db.prepare('SELECT status FROM stocktakes WHERE stocktake_no=?').get(st.stocktake_no);
      if (!head) throw businessError('ST_NOT_FOUND', '盘点单不存在', undefined, 404);
      const row = db.prepare(`SELECT l.* FROM stocktake_lines l
        WHERE l.id=? AND l.stocktake_no=?`).get(id, st.stocktake_no);
      if (!row) throw businessError('LINE_NOT_FOUND', '盘点行不存在', undefined, 404);
      if (row.count_qty === null || row.count_qty === undefined) {
        throw businessError('NO_COUNT', '该行尚未录入实盘，无法更正差异');
      }

      const oldCount = Number(row.count_qty);
      const oldDiff = (row.diff_qty === null || row.diff_qty === undefined) ? null : Number(row.diff_qty);
      const book = Number(row.book_qty) || 0;
      const newDiff = roundQty(target - book);

      // 幂等：重复提交相同实盘 → 不写库、不新增流水、不新增版本
      if (roundQty(target) === roundQty(oldCount)) {
        payload = {
          unchanged: true, draft: head.status === 'draft', code: row.code,
          count_qty: oldCount, adjusted_qty: oldDiff === null ? 0 : oldDiff,
          adjustment_id: Number(row.adjustment_id) || 0,
        };
        return;
      }

      const reason = String(body.reason || '').trim() || '盘点差异更正';
      let adjustmentId = Number(row.adjustment_id) || 0;

      if (head.status === 'draft') {
        // 草稿：只改行数据，不生成调整、不写流水、不影响库存
        db.prepare('UPDATE stocktake_lines SET count_qty=?, diff_qty=?, status=? WHERE id=?')
          .run(target, newDiff, newDiff === 0 ? 'matched' : 'counted', row.id);
      } else {
        // 已确认：账面上始终只保留一条有效调整 + 一条有效流水
        // 兼容历史行：没有 adjustment_id 时按 (单号, 物料) 反查最近一条有效调整
        if (!adjustmentId) {
          const legacy = db.prepare(`SELECT id FROM stock_adjustments
            WHERE stocktake_no=? AND code=? AND status='active' ORDER BY id DESC LIMIT 1`)
            .get(st.stocktake_no, row.code);
          if (legacy) adjustmentId = Number(legacy.id);
        }

        if (newDiff === 0) {
          // 差异归零：作废该行唯一的调整与流水，行回到「相符」
          if (adjustmentId) {
            costing.voidAdjustment(adjustmentId, { updated_by: operator, triggerDoc: st.stocktake_no });
          }
          adjustmentId = 0;
          db.prepare(`UPDATE stocktake_lines SET count_qty=?, diff_qty=0, status='matched', adjustment_id=0
            WHERE id=?`).run(target, row.id);
        } else {
          const adjType = newDiff > 0 ? '盘盈' : '盘亏';
          const adj = adjustmentId
            ? db.prepare('SELECT id, status FROM stock_adjustments WHERE id=?').get(adjustmentId)
            : null;
          if (adjustmentId && adj && adj.status === 'active') {
            // 原地覆盖数量，保持核算位置不变，从该位置重算结存与移动加权成本
            costing.updateAdjustment({
              id: adjustmentId, qty: newDiff, adj_type: adjType, reason,
              remarks: `盘点单 ${st.stocktake_no} 差异更正（行 ${row.id}）`,
              updated_by: operator,
            }, { acceptNoBasis, triggerDoc: st.stocktake_no });
          } else {
            // 无有效调整（历史数据或此前已归零）→ 重新物化一条
            const posted = costing.postAdjustment({
              date: st.date, code: row.code, qty: newDiff, adj_type: adjType, reason,
              remarks: `盘点单 ${st.stocktake_no} 差异更正（行 ${row.id}）`,
              handler: st.handler || operator, stocktake_no: st.stocktake_no, created_by: createdBy,
            }, { acceptNoBasis, triggerDoc: st.stocktake_no });
            adjustmentId = posted.adjustmentId;
          }
          db.prepare(`UPDATE stocktake_lines SET count_qty=?, diff_qty=?, status='adjusted', adjustment_id=?
            WHERE id=?`).run(target, newDiff, adjustmentId, row.id);
        }
      }

      logAdjVersion({
        adjustment_id: head.status === 'draft' ? 0 : adjustmentId,
        stocktake_no: st.stocktake_no,
        code: row.code,
        revision: nextRevision(st.stocktake_no, row.code),
        qty_before: oldCount, qty_after: target,
        diff_before: oldDiff, diff_after: newDiff,
        reason, operator,
      });

      payload = {
        unchanged: false, draft: head.status === 'draft', code: row.code,
        count_qty: target, adjusted_qty: newDiff, adjustment_id: adjustmentId,
        diff_before: oldDiff, diff_after: newDiff,
      };
    });
    tx.immediate();

    // 重复提交相同实盘不记流水、不写版本，也不必再记一条日志
    if (!payload.unchanged) {
      logStocktake(st.stocktake_no, 'correct', operator,
        { key: 'audit_detail_st_correct', params: { code: payload.code, qty: payload.adjusted_qty } });
    }
    res.json({ success: true, ...payload });
  } catch (e) {
    if (e.code === 'NO_COST_BASIS') {
      return res.status(400).json(withEn({ error: e.message, code: 'NO_COST_BASIS', details: e.details }));
    }
    if (e.code === 'INSUFFICIENT_STOCK' || e.code === 'NEGATIVE_STOCK') {
      return res.status(400).json(withEn({
        error: `${e.message}。覆盖式更正会使该时点结存为负，请改用冲销方式更正`,
        code: 'NEGATIVE_STOCK',
      }));
    }
    if (isBusy(e)) return res.status(409).json(busyBody());
    res.status(e.status || 400).json(withEn({ error: e.message, code: e.code || 'STOCKTAKE_CORRECT_FAILED' }));
  }
});

// 确认盘点 → 自动生成库存调整流水并更新库存
// 规则：
//   - 仅 draft 可确认；已确认不能重复确认
//   - 仅对「已盘」的行处理；差异在确认时按「最新库存」重算：
//       diff = count_qty - 确认时账面（getAvailableStock）
//     即「以实盘为准」，保证确认后账面 == 实盘（规则 3）。
//   - 盘点期间账面被其他单据改动过（建单快照 ≠ 确认时账面）时，直接调整会把
//     期间变动一并抹平。此时先用 code='STOCK_CHANGED' 拦住并列出受影响物料，
//     用户确认无误后再带 force=true 重试。
//   - 差异 > 0 → 盘盈（正数）；差异 < 0 → 盘亏（负数）；差异为 0 → matched（不生成流水）
//   - 一个事务内一次性完成全部差异处理与单据状态更新，避免部分更新（规则 4）
//   - 每条流水记录来源盘点单、物料、数量、操作人与时间（规则 8）；无独立调整单号
router.post('/api/stocktakes/:no/confirm', requirePerm('stocktake', 'post'), (req, res) => {
  const st = db.prepare('SELECT * FROM stocktakes WHERE stocktake_no=?').get(req.params.no);
  if (!st) return res.status(404).json({ error: '盘点单不存在' });
  if (st.status === 'confirmed') return res.status(400).json({ error: '该盘点单已确认，不能重复确认' });
  if (st.status !== 'draft') return res.status(400).json({ error: '只有草稿状态的盘点单可以确认' });

  const lines = db.prepare(`
    SELECT l.*, m.name AS material_name
    FROM stocktake_lines l LEFT JOIN materials m ON l.code = m.code
    WHERE l.stocktake_no=? ORDER BY l.id`).all(st.stocktake_no);
  const counted = lines.filter(l => l.count_qty !== null && l.count_qty !== undefined);
  if (counted.length === 0) return res.status(400).json({ error: '尚未录入任何实盘数据，无法确认' });

  const body = req.body || {};

  // 盘盈在结存为 0 且该物料从未有过正库存时没有成本依据，须管理员显式确认
  const acceptNoBasis = body.accept_no_basis === true;
  if (acceptNoBasis && !hasGrant(req.grants, 'stocktake', 'no_basis')) {
    return res.status(403).json({ error: '需 stocktake:no_basis 授权方可按 0 成本入账', code: 'NO_BASIS_FORBIDDEN' });
  }

  // 盘点期间库存变动检测（建单快照 vs 确认时账面）
  const changed = counted
    .map(l => ({ l, confirmBook: getAvailableStock(l.code) }))
    .filter(x => Math.round((x.l.book_qty - x.confirmBook) * 1000000) / 1000000 !== 0);
  if (changed.length > 0 && body.force !== true) {
    return res.status(400).json({
      error: `盘点期间有 ${changed.length} 项物料的账面库存发生变动`,
      code: 'STOCK_CHANGED',
      changed_count: changed.length,
      details: {
        changed_count: changed.length,
        items: changed.map(x => ({
          code: x.l.code,
          name: x.l.material_name || '',
          snapshot_book: x.l.book_qty,
          current_book: x.confirmBook,
        })),
      },
    });
  }

  const confirmedAt = time.nowUtc();
  const createdBy = req.user?.username || '';

  let adjustedCount = 0;
  let matchedCount = counted.length;
  let pendingCount = lines.length - counted.length;
  try {
    // 行记录按确认时口径刷新 book_qty/diff_qty，并回填该行对应调整 id（覆盖式更正的锚点）
    const updLine = db.prepare('UPDATE stocktake_lines SET book_qty=?, diff_qty=?, status=?, adjustment_id=? WHERE id=?');
    const updHead = db.prepare("UPDATE stocktakes SET status='confirmed', confirmed_at=? WHERE stocktake_no=? AND status='draft'");

    const tx = db.transaction(() => {
      // 状态守卫 + 事务内重读实盘行：跨实例并发确认只有第一个请求能改到状态
      const head = updHead.run(confirmedAt, st.stocktake_no);
      if (head.changes === 0) {
        throw businessError('STOCKTAKE_STATE_CHANGED', '该盘点单已被其他请求确认，请刷新后重试', undefined, 409);
      }
      const txLines = db.prepare('SELECT * FROM stocktake_lines WHERE stocktake_no=? ORDER BY id').all(st.stocktake_no);
      const txCounted = txLines.filter(l => l.count_qty !== null && l.count_qty !== undefined);
      if (txCounted.length === 0) throw businessError('NO_COUNT', '尚未录入任何实盘数据，无法确认');
      adjustedCount = 0;
      txCounted.forEach(l => {
        const snapshotBook = l.book_qty;                 // 建单时刻的账面快照
        const confirmBook = getAvailableStock(l.code);   // 确认时刻的最新账面（重新校验）
        const diff = Math.round((l.count_qty - confirmBook) * 1000000) / 1000000;
        const status = diff === 0 ? 'matched' : 'adjusted';
        let adjustmentId = 0;

        if (diff !== 0) {
          let remarks = `盘点单 ${st.stocktake_no}`;
          // 账面在盘点期间被改动过 → 在流水中留存两次口径，便于追溯
          if (Math.round((snapshotBook - confirmBook) * 1000000) / 1000000 !== 0) {
            remarks += `（建单账面 ${snapshotBook}，确认时账面 ${confirmBook}）`;
          }
          // 统一成本服务：写调整单行 + 按调整时点均价生成流水
          const posted = costing.postAdjustment({
            date: st.date, code: l.code, qty: diff,
            adj_type: diff > 0 ? '盘盈' : '盘亏', reason: '盘点差异', remarks,
            handler: st.handler || createdBy, stocktake_no: st.stocktake_no, created_by: createdBy
          }, { acceptNoBasis, triggerDoc: st.stocktake_no });
          adjustmentId = posted.adjustmentId;
          // 版本记录第 1 条：确认落账（旧实盘 / 旧差异为空）
          logAdjVersion({
            adjustment_id: adjustmentId, stocktake_no: st.stocktake_no, code: l.code,
            revision: nextRevision(st.stocktake_no, l.code),
            qty_before: null, qty_after: l.count_qty,
            diff_before: null, diff_after: diff,
            reason: '盘点确认', operator: operatorOf(req),
          });
          adjustedCount++;
        }

        updLine.run(confirmBook, diff, status, adjustmentId, l.id);
      });
      matchedCount = txCounted.length - adjustedCount;
      pendingCount = txLines.length - txCounted.length;
    });
    tx.immediate();

    logStocktake(st.stocktake_no, 'confirm', operatorOf(req),
      { key: 'audit_detail_st_confirm', params: { n: adjustedCount } });

    if (acceptNoBasis) {
      audit.record({
        user_id: req.user?.id ?? null, username: req.user?.username || '', name: req.user?.name || '',
        role: req.user?.role || '', module: 'stocktake', action: 'accept_no_basis', target: st.stocktake_no,
        method: req.method, path: req.originalUrl, ip: clientIp(req), status: 200,
        detail: { key: 'audit_detail_accept_no_basis', params: { doc: st.stocktake_no, n: adjustedCount } },
      });
    }

    res.json({
      success: true, stocktake_no: st.stocktake_no,
      adjusted_count: adjustedCount,
      matched_count: matchedCount,
      pending_count: pendingCount
    });
  } catch (e) {
    if (e.code === 'NO_COST_BASIS') {
      return res.status(400).json(withEn({ error: e.message, code: 'NO_COST_BASIS', details: e.details }));
    }
    if (isBusy(e)) return res.status(409).json(busyBody());
    res.status(e.status || 400).json(withEn({ error: e.message, code: e.code || 'STOCKTAKE_CONFIRM_FAILED' }));
  }
});

module.exports = router;
