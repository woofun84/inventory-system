/**
 * 库存盘点
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const {
  genStocktakeNo,
  getAvailableStock,
} = require('../services/stock');
const time = require('../services/time');

const router = express.Router();

// ==================== 库存盘点 ====================
// 设计要点（来自已确认方案）：
//   1. 盘点不直接改库存：确认后自动生成库存调整流水，由流水改库存。
//      系统已取消独立的「库存调整」模块，调整流水只由盘点确认产生（只读可查）。
//   2. 账面 book_qty 在未确认时为「载入时刻的账面快照」；确认时按最新库存刷新，
//      保证「确认时重新校验库存、防止盘点期间其他单据改变库存」。
//   3. count_qty 为 NULL 表示「未盘」（不生成调整）；0 表示「实盘为零」。
//   4. diff_qty = count_qty - book_qty（未盘为 NULL；确认时随 book_qty 一并刷新）。
//   5. 按物料维度盘点与调整（不区分位置）。
//   6. 已确认的盘点单不允许直接改/删，也不允许「反确认」；草稿可直接删除。
//      已确认后发现错误 → 新建盘点单纠正（不能直接改历史记录）。
//   7. 一次盘点确认在一个事务内一次性完成全部差异处理。
//   8. 每条调整流水记录来源盘点单、物料、调整数量、操作人与时间；
//      调整流水不再有独立单号，统一用来源 stocktake_no 追溯。

// 载入盘点清单：按「物料」列出候选行
// 规则（关键约束）：
//   1. 账面数量必须是快照：载入时即固化 book_qty，后续不再动态读当前库存
//   2. 同一物料在一张盘点单中只能出现一次（DB 侧 UNIQUE(stocktake_no, code) 兜底）
//   3. 全盘/按类别只收录「有库存记录」的物料（含库存为 0 但有历史记录的），
//      不从物料档案全量拉取，避免把从未有过流水的物料也带进来
//   4. 指定物料可收录无库存记录的物料（账面按 0 处理，前端标记为「新增」）
// 「有库存记录」= 期初不为 0，或存在任意入库/出库/调整流水（不限状态）。

// 候选物料查询：附带账面快照 book_qty 与「是否有库存记录」标记
const CANDIDATE_SELECT = `
  SELECT m.code, m.name, m.spec, m.category, m.unit, m.brand,
    (COALESCE(m.opening_qty, 0)
      + COALESCE((SELECT SUM(qty) FROM inbound i WHERE i.code = m.code AND i.status = 'posted'), 0)
      - COALESCE((SELECT SUM(qty) FROM outbound o WHERE o.code = m.code AND o.status = 'posted'), 0)
      + COALESCE((SELECT SUM(qty) FROM stock_adjustments a WHERE a.code = m.code), 0)
    ) AS book_qty,
    (CASE
       WHEN COALESCE(m.opening_qty, 0) <> 0
         OR EXISTS(SELECT 1 FROM inbound i WHERE i.code = m.code AND i.status = 'posted')
         OR EXISTS(SELECT 1 FROM outbound o WHERE o.code = m.code AND o.status = 'posted')
         OR EXISTS(SELECT 1 FROM stock_adjustments a WHERE a.code = m.code)
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
    where.push('(m.code LIKE ? OR m.name LIKE ? OR m.spec LIKE ?)');
    const k = '%' + keyword + '%';
    params.push(k, k, k);
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
    book_qty: Math.round(r.book_qty * 10000) / 10000,
    has_record: !!r.has_record,
    is_new: !r.has_record,
  }));
}

// 记录盘点单操作日志（对齐 inbound_doc_logs / outbound_doc_logs）
function logStocktake(no, action, operator, detail) {
  db.prepare('INSERT INTO stocktake_logs (stocktake_no, action, operator, detail) VALUES (?, ?, ?, ?)')
    .run(no, action, operator || '', detail || '');
}

// 载入方式的中文描述（写入操作日志）
function loadModeLabel(mode, count, categories) {
  if (mode === 'category') return `按类别载入（${(categories || []).join('、')}）`;
  if (mode === 'specified') return '指定物料载入';
  return '全盘载入';
}

// 当前操作者名称（对齐出入库：优先姓名，其次登录名）
function operatorOf(req) {
  return req.user?.name || req.user?.username || '';
}

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
    sql += " AND (s.stocktake_no LIKE ? OR s.handler LIKE ? OR s.remarks LIKE ? OR s.category_filter LIKE ?)";
    const k = '%' + keyword + '%';
    params.push(k, k, k, k);
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

// 新建盘点单（草稿）
router.post('/api/stocktakes', requirePerm('stocktake', 'create'), (req, res) => {
  const body = req.body || {};
  const date = body.date || time.todayLocal();
  const categoryFilter = body.category_filter || '';
  const handler = body.handler || operatorOf(req);
  const remarks = body.remarks || '';

  const no = genStocktakeNo(date);
  const info = db.prepare(`INSERT INTO stocktakes
    (stocktake_no, date, status, category_filter, handler, remarks, created_by)
    VALUES (@stocktake_no, @date, 'draft', @category_filter, @handler, @remarks, @created_by)`)
    .run({
      stocktake_no: no, date, category_filter: categoryFilter,
      handler, remarks, created_by: req.user?.username || ''
    });
  logStocktake(no, 'create', operatorOf(req), '创建盘点单');
  res.json({ success: true, id: Number(info.lastInsertRowid), stocktake_no: no, status: 'draft' });
});

// 删除盘点单（仅草稿可删；已确认的单据不可删，需新建盘点单纠正）
router.delete('/api/stocktakes/:no', requirePerm('stocktake', 'create'), (req, res) => {
  const st = db.prepare('SELECT * FROM stocktakes WHERE stocktake_no=?').get(req.params.no);
  if (!st) return res.status(404).json({ error: '盘点单不存在' });
  if (st.status === 'confirmed') return res.status(400).json({ error: '已确认的盘点单不能删除，如需纠正请新建盘点单' });
  if (st.status !== 'draft') return res.status(400).json({ error: '只有草稿状态的盘点单可以删除' });

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM stocktake_lines WHERE stocktake_no=?').run(st.stocktake_no);
    db.prepare('DELETE FROM stocktake_logs WHERE stocktake_no=?').run(st.stocktake_no);
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
    WHERE l.stocktake_no=? ORDER BY l.code
  `).all(st.stocktake_no);

  const counted = lines.filter(l => l.count_qty !== null && l.count_qty !== undefined);
  const diffs = counted.filter(l => l.diff_qty !== 0);
  const gain = diffs.filter(l => l.diff_qty > 0).reduce((s, l) => s + l.diff_qty, 0);
  const loss = diffs.filter(l => l.diff_qty < 0).reduce((s, l) => s + l.diff_qty, 0);

  // 关联生成的调整流水（确认后反查；只读展示，含物料信息便于追溯）
  const adjustments = db.prepare(`
    SELECT a.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit
    FROM stock_adjustments a LEFT JOIN materials m ON a.code = m.code
    WHERE a.stocktake_no=? ORDER BY a.id
  `).all(st.stocktake_no);

  // 操作日志（对齐入库/出库单据）
  const logs = db.prepare('SELECT * FROM stocktake_logs WHERE stocktake_no=? ORDER BY id ASC')
    .all(st.stocktake_no);

  res.json({
    ...st,
    lines,
    adjustments,
    logs,
    summary: {
      line_count: lines.length,
      counted_count: counted.length,
      pending_count: lines.length - counted.length,
      matched_count: counted.filter(l => l.diff_qty === 0).length,
      diff_count: diffs.length,
      gain_qty: Math.round(gain * 10000) / 10000,
      loss_qty: Math.round(loss * 10000) / 10000
    }
  });
});

// 载入盘点清单（写入账面快照 book_qty）
// body: { scope: 'all'|'category'|'specified', categories: [], codes: [], force }
//   - 仅 draft 状态可载入
//   - 重新载入会先清空旧行（含实盘数据），已有实盘时需 force=true 二次确认
//   - 账面数量在此时固化为快照，后续不再动态读当前库存
router.post('/api/stocktakes/:no/load', requirePerm('stocktake', 'create'), (req, res) => {
  const st = db.prepare('SELECT * FROM stocktakes WHERE stocktake_no=?').get(req.params.no);
  if (!st) return res.status(404).json({ error: '盘点单不存在' });
  if (st.status !== 'draft') return res.status(400).json({ error: '只有草稿状态的盘点单可以载入清单' });

  const body = req.body || {};
  const scope = body.scope || 'all';
  const categories = Array.isArray(body.categories) ? body.categories.filter(Boolean) : [];
  const codes = Array.isArray(body.codes) ? [...new Set(body.codes.filter(Boolean))] : [];

  // 各方式的入参校验
  if (scope === 'category' && categories.length === 0) {
    return res.status(400).json({ error: '请选择至少一个物料类别' });
  }
  if (scope === 'specified' && codes.length === 0) {
    return res.status(400).json({ error: '请选择至少一个物料' });
  }

  // 已有实盘数据时重新载入会丢失，先拦住
  const countedBefore = db.prepare('SELECT COUNT(*) as c FROM stocktake_lines WHERE stocktake_no=? AND count_qty IS NOT NULL')
    .get(st.stocktake_no).c;
  if (countedBefore > 0 && body.force !== true) {
    return res.status(400).json({
      error: `该盘点单已录入 ${countedBefore} 行实盘，重新载入会清空实盘数据`,
      code: 'HAS_COUNT_DATA',
      counted_count: countedBefore,
      details: { counted_count: countedBefore }
    });
  }

  const candidates = listCandidates({ scope, categories, codes });
  if (candidates.length === 0) {
    if (scope === 'category') return res.status(400).json({ error: '该类别暂无符合条件的库存物料' });
    if (scope === 'specified') return res.status(400).json({ error: '所选物料不存在或已停用' });
    return res.status(400).json({ error: '当前没有可盘点的库存物料，请先在物料档案登记并产生出入库流水' });
  }

  // 回写单头，便于列表/详情回溯载入范围：
  //   load_scope     —— 载入方式（all / category / specified）
  //   category_filter —— 仅按类别载入时记录具体类别
  const categoryFilter = scope === 'category' ? categories.join(',') : '';

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM stocktake_lines WHERE stocktake_no=?').run(st.stocktake_no);
    const stmt = db.prepare(`INSERT INTO stocktake_lines
      (stocktake_no, code, book_qty, count_qty, diff_qty, status, remarks)
      VALUES (@stocktake_no, @code, @book_qty, NULL, NULL, 'pending', '')`);
    candidates.forEach(r => stmt.run({
      stocktake_no: st.stocktake_no, code: r.code, book_qty: r.book_qty
    }));
    db.prepare('UPDATE stocktakes SET category_filter=?, load_scope=? WHERE stocktake_no=?')
      .run(categoryFilter, scope, st.stocktake_no);
  });
  tx();

  const label = loadModeLabel(scope, candidates.length, categories);
  logStocktake(st.stocktake_no, 'load', operatorOf(req), `${label}，共 ${candidates.length} 项`);

  res.json({ success: true, loaded_count: candidates.length, scope, load_scope: scope, category_filter: categoryFilter });
});

// 草稿态：追加物料行（增行）
// body: { codes: ['CB-0001', ...] }（单条也可用 { code: 'CB-0001' }）
//   - 仅 draft 可增行
//   - 账面数量取「加入时刻」的实时库存快照（与载入清单同一口径，加入后不再动态读库）
//   - 同一物料在一张盘点单中只能出现一次（已存在则跳过，不报错）
//   - 无库存记录的物料也可加入，账面按 0 处理
router.post('/api/stocktakes/:no/lines', requirePerm('stocktake', 'create'), (req, res) => {
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
    `添加物料 ${added.map(m => m.code).join('、')}`);
  res.json({ success: true, added_count: added.length, added: added.map(m => m.code), skipped });
});

// 草稿态：移除物料行（减行）
router.delete('/api/stocktakes/:no/lines/:id', requirePerm('stocktake', 'create'), (req, res) => {
  const st = db.prepare('SELECT * FROM stocktakes WHERE stocktake_no=?').get(req.params.no);
  if (!st) return res.status(404).json({ error: '盘点单不存在' });
  if (st.status !== 'draft') return res.status(400).json({ error: '只有草稿状态的盘点单可以增删物料' });

  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM stocktake_lines WHERE id=? AND stocktake_no=?').get(id, st.stocktake_no);
  if (!row) return res.status(404).json({ error: '盘点行不存在' });

  db.prepare('DELETE FROM stocktake_lines WHERE id=?').run(id);
  logStocktake(st.stocktake_no, 'remove', operatorOf(req), `移除物料 ${row.code}`);
  res.json({ success: true, code: row.code });
});

// 保存实盘数量（可多次保存草稿）
// body: { lines: [{ id, count_qty, remarks }] }
//   count_qty 为 null / undefined / '' → 未盘（清空该行实盘与差异）
router.put('/api/stocktakes/:no/lines', requirePerm('stocktake', 'create'), (req, res) => {
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
        const diff = Math.round((cnt - row.book_qty) * 10000) / 10000;
        if (hasRemarks) updWithRemarks.run(cnt, diff, diff === 0 ? 'matched' : 'pending', remarks, row.id);
        else updNoRemarks.run(cnt, diff, diff === 0 ? 'matched' : 'pending', row.id);
      }
      updated++;
    });
  });

  try {
    tx();
    if (updated > 0) logStocktake(st.stocktake_no, 'save', operatorOf(req), `保存实盘，${updated} 行`);
    res.json({ success: true, updated });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 确认盘点 → 自动生成库存调整流水并更新库存
// 规则：
//   - 仅 draft 可确认；已确认不能重复确认
//   - 仅对「已盘」的行处理；差异在确认时按「最新库存」重算：
//       diff = count_qty - 确认时账面（getAvailableStock）
//     即「以实盘为准」，保证确认后账面 == 实盘（规则 3）。
//   - 盘点期间账面被其他单据改动过（载入快照 ≠ 确认时账面）时，直接调整会把
//     期间变动一并抹平。此时先用 code='STOCK_CHANGED' 拦住并列出受影响物料，
//     用户确认无误后再带 force=true 重试。
//   - 差异 > 0 → 盘盈（正数）；差异 < 0 → 盘亏（负数）；差异为 0 → matched（不生成流水）
//   - 一个事务内一次性完成全部差异处理与单据状态更新，避免部分更新（规则 4）
//   - 每条流水记录来源盘点单、物料、数量、操作人与时间（规则 8）；无独立调整单号
router.post('/api/stocktakes/:no/confirm', requirePerm('stocktake', 'confirm'), (req, res) => {
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

  // 盘点期间库存变动检测（载入快照 vs 确认时账面）
  const changed = counted
    .map(l => ({ l, confirmBook: getAvailableStock(l.code) }))
    .filter(x => Math.round((x.l.book_qty - x.confirmBook) * 10000) / 10000 !== 0);
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

  try {
    const insAdj = db.prepare(`INSERT INTO stock_adjustments
      (date, code, qty, adj_type, reason, remarks, handler, stocktake_no, created_by)
      VALUES (@date, @code, @qty, @adj_type, @reason, @remarks, @handler, @stocktake_no, @created_by)`);
    // 行记录按确认时口径刷新 book_qty/diff_qty，保证 diff = count - book 自洽
    const updLine = db.prepare('UPDATE stocktake_lines SET book_qty=?, diff_qty=?, status=? WHERE id=?');
    const updHead = db.prepare("UPDATE stocktakes SET status='confirmed', confirmed_at=? WHERE stocktake_no=?");

    let adjustedCount = 0;
    const tx = db.transaction(() => {
      counted.forEach(l => {
        const snapshotBook = l.book_qty;                 // 载入时刻的账面快照
        const confirmBook = getAvailableStock(l.code);   // 确认时刻的最新账面（重新校验）
        const diff = Math.round((l.count_qty - confirmBook) * 10000) / 10000;
        const status = diff === 0 ? 'matched' : 'adjusted';

        updLine.run(confirmBook, diff, status, l.id);

        if (diff !== 0) {
          let remarks = `盘点单 ${st.stocktake_no}`;
          // 账面在盘点期间被改动过 → 在流水中留存两次口径，便于追溯
          if (Math.round((snapshotBook - confirmBook) * 10000) / 10000 !== 0) {
            remarks += `（载入账面 ${snapshotBook}，确认时账面 ${confirmBook}）`;
          }
          insAdj.run({
            date: st.date, code: l.code, qty: diff,
            adj_type: diff > 0 ? '盘盈' : '盘亏', reason: '盘点差异', remarks,
            handler: st.handler || createdBy, stocktake_no: st.stocktake_no, created_by: createdBy
          });
          adjustedCount++;
        }
      });
      updHead.run(confirmedAt, st.stocktake_no);
    });
    tx();

    logStocktake(st.stocktake_no, 'confirm', operatorOf(req),
      `确认盘点，生成盘盈/盘亏调整 ${adjustedCount} 项`);

    res.json({
      success: true, stocktake_no: st.stocktake_no,
      adjusted_count: adjustedCount,
      matched_count: counted.length - adjustedCount,
      pending_count: lines.length - counted.length
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
