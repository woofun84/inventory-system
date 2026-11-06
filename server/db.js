/**
 * 数据库连接与迁移
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { DB_PATH, INITIAL_ADMIN_USERNAME, INITIAL_ADMIN_PASSWORD } = require('./config');
const { localOffsetMinutes } = require('./services/time');

// 自动初始化数据库
if (!fs.existsSync(DB_PATH)) {
  console.log('数据库不存在，正在初始化...');
  require('../init-db.js');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function migrateDB() {
  // inbound 加 txn_type 字段（采购入库 / 退库入库）
  try {
    db.exec("ALTER TABLE inbound ADD COLUMN txn_type TEXT DEFAULT ''");
    console.log('迁移: inbound.txn_type 已添加');
  } catch(e) { /* 字段已存在 */ }

  // outbound 加 txn_type 字段（正常出库 / 退货出库）
  try {
    db.exec("ALTER TABLE outbound ADD COLUMN txn_type TEXT DEFAULT ''");
    console.log('迁移: outbound.txn_type 已添加');
  } catch(e) { /* 字段已存在 */ }

  // 给已有的 inbound 记录补默认值
  try {
    db.exec("UPDATE inbound SET txn_type = '采购入库' WHERE txn_type = '' OR txn_type IS NULL");
    db.exec("UPDATE outbound SET txn_type = '正常出库' WHERE txn_type = '' OR txn_type IS NULL");
  } catch(e) {}

  // 迁移：退库入库 → 采购退货（移到 inbound 表，qty/price 转负数）
  //        退货出库 → 退库出库（移到 outbound 表，qty 转负数）
  // 注意：amount/cost_amount 是 GENERATED 列，随 qty*price 自动计算，无需单独更新
  try {
    // inbound 表中已有的"退库入库"改为"采购退货"，qty 和 price 转负数（amount 自动跟着变）
    db.exec("UPDATE inbound SET txn_type = '采购退货', qty = -ABS(qty), price = -ABS(price) WHERE txn_type = '退库入库'");
    // outbound 表中已有的"退货出库"改为"退库出库"，qty 转负数（cost_amount 自动跟着变）
    db.exec("UPDATE outbound SET txn_type = '退库出库', qty = -ABS(qty) WHERE txn_type = '退货出库'");
  } catch(e) { console.log('迁移 txn_type 值更新:', e.message); }

  // 用户表
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT DEFAULT '',
    role TEXT DEFAULT 'operator',
    status TEXT DEFAULT 'active',
    must_change_pwd INTEGER DEFAULT 0,
    last_login TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // 订单明细增加 contract_no 字段（阶段 A）
  try {
    db.exec("ALTER TABLE order_lines ADD COLUMN contract_no TEXT DEFAULT ''");
    console.log('迁移: order_lines.contract_no 已添加');
  } catch(e) { /* 字段已存在 */ }

  // 旧数据回填：order_lines 的 contract_no 从 PO 头 contract_no 回填
  try {
    db.exec(`UPDATE order_lines SET contract_no = (
      SELECT contract_no FROM purchase_orders WHERE purchase_orders.po_no = order_lines.po_no
    ) WHERE contract_no = '' OR contract_no IS NULL`);
  } catch(e) { console.log('迁移 contract_no 回填:', e.message); }

  // ==================== 入库单据头表 + 修改记录表（2026-11-03 新增） ====================
  // 设计要点：
  //  1. inbound_docs 是单据头（一张入库单一行），inbound 明细行通过 doc_no 关联
  //  2. 状态流转：draft（草稿，可编辑）→ posted（已过账，生成库存流水，不可改）→ cancelled（作废）
  //  3. 草稿态的 inbound 明细行 status='draft'，不计入库存；
  //     过账后 status='posted'，纳入库存计算
  //  4. 已过账单据不允许直接修改原始记录，应通过红字冲销/退库处理
  //  5. inbound_doc_logs 记录单据的操作历史（创建/编辑/确认/作废）
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS inbound_docs (
      doc_no TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      txn_type TEXT NOT NULL DEFAULT '采购入库',
      supplier TEXT DEFAULT '',
      handler TEXT DEFAULT '',
      po_no TEXT DEFAULT '',
      contract_no TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      remarks TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      confirmed_by TEXT DEFAULT '',
      confirmed_at TEXT DEFAULT '',
      cancelled_by TEXT DEFAULT '',
      cancelled_at TEXT DEFAULT ''
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS inbound_doc_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no TEXT NOT NULL,
      action TEXT NOT NULL,
      operator TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_ibdoclog_no ON inbound_doc_logs(doc_no)");

    // 给 inbound 表加 doc_no 和 status 字段（向后兼容，老数据不加这两个字段也能工作）
    try { db.exec("ALTER TABLE inbound ADD COLUMN doc_no TEXT DEFAULT ''"); console.log('迁移: inbound.doc_no 已添加'); } catch(e) {}
    try { db.exec("ALTER TABLE inbound ADD COLUMN status TEXT DEFAULT 'posted'"); console.log('迁移: inbound.status 已添加'); } catch(e) {}

    // ==================== 冲销功能字段（2026-11-03 新增） ====================
    // inbound_docs.reversal_of: 非空表示这张单据是冲销单，值为原单号
    // inbound.reversal_of:     非空表示这行是冲销行，值为原明细行 ID
    // inbound.reversed_qty:    原明细行累计已冲销数量（仅原行维护，冲销行不维护）
    try { db.exec("ALTER TABLE inbound_docs ADD COLUMN reversal_of TEXT DEFAULT ''"); console.log('迁移: inbound_docs.reversal_of 已添加'); } catch(e) {}
    try { db.exec("ALTER TABLE inbound ADD COLUMN reversal_of TEXT DEFAULT ''"); console.log('迁移: inbound.reversal_of 已添加'); } catch(e) {}
    try { db.exec("ALTER TABLE inbound ADD COLUMN reversed_qty REAL DEFAULT 0"); console.log('迁移: inbound.reversed_qty 已添加'); } catch(e) {}
    // 索引：按原单号查冲销单、按原行 ID 查冲销行
    db.exec("CREATE INDEX IF NOT EXISTS idx_ibdoc_rev ON inbound_docs(reversal_of)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ib_rev ON inbound(reversal_of)");

    // 老数据迁移：有 grn_no 但无 doc_no 的行，自动创建对应的单据头
    const orphanRows = db.prepare("SELECT DISTINCT grn_no FROM inbound WHERE (doc_no = '' OR doc_no IS NULL) AND grn_no != ''").all();
    if (orphanRows.length > 0) {
      const insertDoc = db.prepare(`INSERT OR IGNORE INTO inbound_docs (doc_no, date, txn_type, supplier, handler, po_no, contract_no, status, remarks, created_by, confirmed_by, confirmed_at)
        VALUES (@doc_no, @date, @txn_type, @supplier, @handler, @po_no, @contract_no, 'posted', @remarks, 'system', 'system', @created_at)`);
      const updateLine = db.prepare("UPDATE inbound SET doc_no = grn_no, status = 'posted' WHERE grn_no = ?");
      orphanRows.forEach(r => {
        const info = db.prepare("SELECT MIN(date) as d, MAX(txn_type) as t, MAX(supplier) as s, MAX(handler) as h, MAX(po_no) as p, MAX(contract_no) as c, MAX(remarks) as r, MAX(created_at) as ca FROM inbound WHERE grn_no = ?").get(r.grn_no);
        insertDoc.run({
          doc_no: r.grn_no, date: info.d || '', txn_type: info.t || '采购入库',
          supplier: info.s || '', handler: info.h || '', po_no: info.p || '',
          contract_no: info.c || '', remarks: info.r || '', created_at: info.ca || ''
        });
        updateLine.run(r.grn_no);
      });
      console.log(`迁移: ${orphanRows.length} 张老入库单据已补建单据头`);
    }

    console.log('迁移: 入库单据头表已就绪');
  } catch(e) { console.log('迁移 入库单据头表:', e.message); }

  // ==================== 出库单据头表 + 修改记录表（2026-11-03 新增） ====================
  // 设计要点（与入库单据保持一致）：
  //  1. outbound_docs 是单据头（一张出库单一行），outbound 明细行通过 doc_no 关联
  //  2. 状态流转：draft（草稿，可编辑）→ posted（已过账，生成库存流水，不可改）→ cancelled（作废）
  //  3. 草稿态的 outbound 明细行 status='draft'，不计入库存；过账后 status='posted'，纳入库存计算
  //  4. 已过账单据不允许直接修改，应通过红字冲销处理
  //  5. outbound_doc_logs 记录单据的操作历史（创建/编辑/确认/作废）
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS outbound_docs (
      doc_no TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      txn_type TEXT NOT NULL DEFAULT '正常出库',
      destination TEXT DEFAULT '',
      receiver TEXT DEFAULT '',
      handler TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      remarks TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      confirmed_by TEXT DEFAULT '',
      confirmed_at TEXT DEFAULT '',
      cancelled_by TEXT DEFAULT '',
      cancelled_at TEXT DEFAULT '',
      reversal_of TEXT DEFAULT ''
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS outbound_doc_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no TEXT NOT NULL,
      action TEXT NOT NULL,
      operator TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_obdoclog_no ON outbound_doc_logs(doc_no)");

    // 给 outbound 表加 doc_no / status / 冲销相关字段
    // 老数据默认 status='posted'（历史出库记录都已生效）
    try { db.exec("ALTER TABLE outbound ADD COLUMN doc_no TEXT DEFAULT ''"); console.log('迁移: outbound.doc_no 已添加'); } catch(e) {}
    try { db.exec("ALTER TABLE outbound ADD COLUMN status TEXT DEFAULT 'posted'"); console.log('迁移: outbound.status 已添加'); } catch(e) {}
    try { db.exec("ALTER TABLE outbound ADD COLUMN reversal_of TEXT DEFAULT ''"); console.log('迁移: outbound.reversal_of 已添加'); } catch(e) {}
    try { db.exec("ALTER TABLE outbound ADD COLUMN reversed_qty REAL DEFAULT 0"); console.log('迁移: outbound.reversed_qty 已添加'); } catch(e) {}

    // 2C：领用退库关联原出库单
    // outbound_docs.origin_doc_no: 退库出库单指向的原出库单号（普通出库单为空）
    // outbound.origin_line_id:     退库明细行指向的原出库明细行 ID（0 表示未关联）
    try { db.exec("ALTER TABLE outbound_docs ADD COLUMN origin_doc_no TEXT DEFAULT ''"); console.log('迁移: outbound_docs.origin_doc_no 已添加'); } catch(e) {}
    try { db.exec("ALTER TABLE outbound ADD COLUMN origin_line_id INTEGER NOT NULL DEFAULT 0"); console.log('迁移: outbound.origin_line_id 已添加'); } catch(e) {}
    db.exec("CREATE INDEX IF NOT EXISTS idx_ob_originline ON outbound(origin_line_id)");
    try { db.exec("UPDATE outbound SET status='posted' WHERE status='' OR status IS NULL"); } catch(e) {}
    db.exec("CREATE INDEX IF NOT EXISTS idx_obdoc_rev ON outbound_docs(reversal_of)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ob_rev ON outbound(reversal_of)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ob_docno ON outbound(doc_no)");

    // 老数据迁移：有 gin_no 但无 doc_no 的行，自动创建对应的单据头
    const orphanOut = db.prepare("SELECT DISTINCT gin_no FROM outbound WHERE (doc_no = '' OR doc_no IS NULL) AND gin_no != ''").all();
    if (orphanOut.length > 0) {
      const insertDoc = db.prepare(`INSERT OR IGNORE INTO outbound_docs (doc_no, date, txn_type, destination, receiver, handler, status, remarks, created_by, confirmed_by, confirmed_at)
        VALUES (@doc_no, @date, @txn_type, @destination, @receiver, @handler, 'posted', @remarks, 'system', 'system', @created_at)`);
      const updateLine = db.prepare("UPDATE outbound SET doc_no = gin_no, status = 'posted' WHERE gin_no = ?");
      orphanOut.forEach(r => {
        const info = db.prepare("SELECT MIN(date) as d, MAX(txn_type) as t, MAX(destination) as de, MAX(receiver) as re, MAX(handler) as h, MAX(remarks) as r, MAX(created_at) as ca FROM outbound WHERE gin_no = ?").get(r.gin_no);
        insertDoc.run({
          doc_no: r.gin_no, date: info.d || '', txn_type: info.t || '正常出库',
          destination: info.de || '', receiver: info.re || '', handler: info.h || '',
          remarks: info.r || '', created_at: info.ca || ''
        });
        updateLine.run(r.gin_no);
      });
      console.log(`迁移: ${orphanOut.length} 张老出库单据已补建单据头`);
    }

    console.log('迁移: 出库单据头表已就绪');
  } catch(e) { console.log('迁移 出库单据头表:', e.message); }

  // ==================== 库存调整 + 库存盘点（2026-11 新增） ====================
  // 设计要点：
  //  1. 调整是独立流水，不写入 inbound/outbound，避免污染采购与领用统计
  //  2. 库存口径统一为：期初 + Σ入库 - Σ出库 + Σ调整（调整增加为正、减少为负）
  //  3. 盘点按物料维度（不分位置）
    //  4. 盘点行 book_qty 是载入时刻的账面快照，不随后续入出库变化
  //  5. count_qty 为 NULL 表示「未盘」，0 表示「实盘为零」
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS stock_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      code TEXT NOT NULL,
      qty REAL NOT NULL,
      adj_type TEXT NOT NULL DEFAULT '其它',
      reason TEXT NOT NULL DEFAULT '',
      remarks TEXT NOT NULL DEFAULT '',
      handler TEXT NOT NULL DEFAULT '',
      stocktake_no TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (code) REFERENCES materials(code)
    )`);
    // 库存口径与台账都按 code 汇总，建索引
    db.exec("CREATE INDEX IF NOT EXISTS idx_adj_code ON stock_adjustments(code)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_adj_date ON stock_adjustments(date)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_adj_stk ON stock_adjustments(stocktake_no)");

    db.exec(`CREATE TABLE IF NOT EXISTS stocktakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stocktake_no TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      category_filter TEXT NOT NULL DEFAULT '',
      load_scope TEXT NOT NULL DEFAULT '',
      handler TEXT NOT NULL DEFAULT '',
      remarks TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      confirmed_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS stocktake_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stocktake_no TEXT NOT NULL,
      code TEXT NOT NULL,
      book_qty REAL NOT NULL DEFAULT 0,
      count_qty REAL,
      diff_qty REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      remarks TEXT NOT NULL DEFAULT '',
      UNIQUE(stocktake_no, code),
      FOREIGN KEY (stocktake_no) REFERENCES stocktakes(stocktake_no),
      FOREIGN KEY (code) REFERENCES materials(code)
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_stkline_no ON stocktake_lines(stocktake_no)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_stkline_code ON stocktake_lines(code)");

    // 盘点单操作日志（对齐 inbound_doc_logs / outbound_doc_logs）：
    // 记录单张盘点单的操作历史（创建 / 载入清单 / 保存实盘 / 确认）
    db.exec(`CREATE TABLE IF NOT EXISTS stocktake_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stocktake_no TEXT NOT NULL,
      action TEXT NOT NULL,
      operator TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_stklog_no ON stocktake_logs(stocktake_no)");

    // 迁移：stocktakes 增加 load_scope（载入范围：all 全盘 / category 按类别 / specified 指定物料）
    try {
      db.exec("ALTER TABLE stocktakes ADD COLUMN load_scope TEXT NOT NULL DEFAULT ''");
      console.log('迁移: stocktakes.load_scope 已添加');
    } catch(e) { /* 字段已存在 */ }

    // 迁移：stock_adjustments 移除冗余的 adj_no
    // 原因：独立的「库存调整」模块已取消，调整流水只可能由盘点确认产生，
    //       adj_no 与 stocktake_no 一一对应，属重复标识，统一用 stocktake_no 追溯。
    try {
      db.exec("ALTER TABLE stock_adjustments DROP COLUMN adj_no");
      console.log('迁移: stock_adjustments.adj_no 已移除');
    } catch(e) { /* 字段已不存在或 SQLite 版本不支持 */ }

    console.log('迁移: 库存调整/盘点表已就绪');
  } catch(e) { console.log('迁移 库存调整/盘点表:', e.message); }

  // ==================== 采购合同（2026-11 新增） ====================
  // 设计要点：
  //  1. 合同独立成表，是「按合同查询 / 汇总」与「到货核销」的实体依据
  //  2. 采购单 ↔ 合同是多对多：真实归属以明细行 order_lines.contract_no 为准，
  //     采购单头的 contract_no 仅作新建明细时带出的默认合同
  //  3. 入库明细行记录 order_line_id，把到货精确核销到具体采购明细；
  //     未关联（0）时回退到「采购单 + 物料 + 合同」匹配
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_no TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      supplier TEXT NOT NULL DEFAULT '',
      sign_date TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      remarks TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_contract_supplier ON contracts(supplier)");

    // 存量合同号回填（仅在合同档案为空时执行一次）：
    // 把历史采购单/明细/入库单上出现过的合同号补成档案，避免「按合同」视图空白
    const cnt = db.prepare("SELECT COUNT(*) c FROM contracts").get().c;
    if (cnt === 0) {
      const rows = db.prepare(`
        SELECT DISTINCT contract_no, supplier FROM (
          SELECT contract_no, supplier FROM purchase_orders WHERE TRIM(COALESCE(contract_no,'')) <> ''
          UNION SELECT contract_no, '' AS supplier FROM order_lines WHERE TRIM(COALESCE(contract_no,'')) <> ''
          UNION SELECT contract_no, supplier FROM inbound WHERE TRIM(COALESCE(contract_no,'')) <> ''
        )`).all();
      const ins = db.prepare("INSERT OR IGNORE INTO contracts (contract_no, supplier) VALUES (?, ?)");
      let n = 0;
      rows.forEach(r => { n += ins.run(String(r.contract_no).trim(), r.supplier || '').changes; });
      if (n) console.log(`迁移: 回填 ${n} 条历史合同号到合同档案`);
    }

    // 入库明细行加 order_line_id：0 表示未关联采购明细
    try {
      db.exec("ALTER TABLE inbound ADD COLUMN order_line_id INTEGER NOT NULL DEFAULT 0");
      console.log('迁移: inbound.order_line_id 已添加');
    } catch(e) { /* 字段已存在 */ }
    db.exec("CREATE INDEX IF NOT EXISTS idx_ib_orderline ON inbound(order_line_id)");
    console.log('迁移: 采购合同表已就绪');
  } catch(e) { console.log('迁移 采购合同表:', e.message); }

  // ==================== 采购退货三档关联（2026-11 第五批） ====================
  // 档位（return_tier）：
  //   inbound  关联原入库单（默认）：头 origin_doc_no 指向原单，行 origin_line_id 指向原入库行
  //   po       关联采购单：头 return_ref_no 存采购单号，行 origin_line_id 仍指向具体入库行
  //   contract 关联合同：头 return_ref_no 存合同号，行 origin_line_id 仍指向具体入库行
  //   none     无原单（例外，仅 admin/manager）：头 return_reason 必填，行 origin_line_id=0
  try {
    try { db.exec("ALTER TABLE inbound_docs ADD COLUMN return_tier TEXT DEFAULT ''"); console.log('迁移: inbound_docs.return_tier 已添加'); } catch(e) {}
    try { db.exec("ALTER TABLE inbound_docs ADD COLUMN origin_doc_no TEXT DEFAULT ''"); console.log('迁移: inbound_docs.origin_doc_no 已添加'); } catch(e) {}
    try { db.exec("ALTER TABLE inbound_docs ADD COLUMN return_ref_no TEXT DEFAULT ''"); console.log('迁移: inbound_docs.return_ref_no 已添加'); } catch(e) {}
    try { db.exec("ALTER TABLE inbound_docs ADD COLUMN return_reason TEXT DEFAULT ''"); console.log('迁移: inbound_docs.return_reason 已添加'); } catch(e) {}
    try { db.exec("ALTER TABLE inbound ADD COLUMN origin_line_id INTEGER NOT NULL DEFAULT 0"); console.log('迁移: inbound.origin_line_id 已添加'); } catch(e) {}
    db.exec("CREATE INDEX IF NOT EXISTS idx_ib_originline ON inbound(origin_line_id)");
    // 存量采购退货单没有入库行级来源，统一归为「无原单」，避免被误认为已纳入新额度口径
    const legacy = db.prepare("UPDATE inbound_docs SET return_tier='none' WHERE txn_type='采购退货' AND (return_tier='' OR return_tier IS NULL)").run();
    if (legacy.changes) console.log(`迁移: ${legacy.changes} 张存量采购退货单归为「无原单」档`);
    console.log('迁移: 采购退货三档字段已就绪');
  } catch(e) { console.log('迁移 采购退货三档:', e.message); }

  // ==================== 采购单状态（2026-11 新增） ====================
  // 对齐入库/出库单据的 draft → posted 流转：
  //   draft 草稿（可编辑，未生效）→ posted 已确认
  // 存量采购单默认 'posted'（历史单据已在实际使用中）
  try {
    try {
      db.exec("ALTER TABLE purchase_orders ADD COLUMN status TEXT NOT NULL DEFAULT 'posted'");
      console.log('迁移: purchase_orders.status 已添加');
    } catch(e) { /* 字段已存在 */ }
  } catch(e) { console.log('迁移 采购单状态:', e.message); }

  // 初始管理员账号：用户名/密码取自配置（环境变量可覆盖），未配置时使用默认值 admin / admin123
  const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  if (adminCount === 0) {
    db.prepare(`INSERT INTO users (username, password_hash, name, role, must_change_pwd)
                VALUES (?,?,?,?,1)`).run(INITIAL_ADMIN_USERNAME, bcrypt.hashSync(INITIAL_ADMIN_PASSWORD, 10), '系统管理员', 'admin');
    console.log(`已创建初始管理员账号: ${INITIAL_ADMIN_USERNAME}（首次登录需修改密码；密码默认 admin123，可用环境变量 INITIAL_ADMIN_PASSWORD 覆盖）`);
  }

  // ==================== 系统审计日志（2026-11 新增） ====================
  // 记录"谁在什么时间做了什么"（登录/新增/修改/删除/确认/作废/冲销）
  // created_at 统一存 UTC，前端按浏览器本地时区渲染
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      username TEXT DEFAULT '',
      name TEXT DEFAULT '',
      role TEXT DEFAULT '',
      module TEXT DEFAULT '',
      action TEXT DEFAULT '',
      target TEXT DEFAULT '',
      method TEXT DEFAULT '',
      path TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      status INTEGER DEFAULT 200,
      detail TEXT DEFAULT ''
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(username)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs(module)");
    console.log('迁移: 系统审计日志表已就绪');
  } catch (e) { console.log('迁移 审计日志表:', e.message); }

  // ==================== 历史时间统一为 UTC（一次性） ====================
  // 早期版本用 datetime('now','localtime') 写入本机时间且不带时区标记，
  // 现统一为 UTC：此处把存量值按本机相对 UTC 的偏移换算，用 params 标记保证只跑一次。
  try {
    const migrated = db.prepare("SELECT value FROM params WHERE key='tz_utc_migrated'").get();
    if (!migrated) {
      const off = localOffsetMinutes();
      if (off !== 0) {
        const mod = off > 0 ? `-${off} minutes` : `+${-off} minutes`;
        const targets = [
          ['materials', 'created_at'], ['materials', 'updated_at'], ['suppliers', 'created_at'],
          ['inbound', 'created_at'], ['outbound', 'created_at'],
          ['purchase_orders', 'created_at'], ['order_lines', 'created_at'],
          ['users', 'created_at'], ['users', 'last_login'],
          ['inbound_docs', 'created_at'], ['inbound_docs', 'confirmed_at'], ['inbound_docs', 'cancelled_at'],
          ['inbound_doc_logs', 'created_at'],
          ['outbound_docs', 'created_at'], ['outbound_docs', 'confirmed_at'], ['outbound_docs', 'cancelled_at'],
          ['outbound_doc_logs', 'created_at'],
          ['stock_adjustments', 'created_at'],
          ['stocktakes', 'created_at'], ['stocktakes', 'confirmed_at'],
          ['stocktake_logs', 'created_at'],
        ];
        const run = db.transaction(() => {
          let n = 0;
          for (const [t, c] of targets) {
            const r = db.prepare(
              `UPDATE ${t} SET ${c} = datetime(${c}, ?)
                WHERE ${c} IS NOT NULL
                  AND ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'`
            ).run(mod);
            n += r.changes;
          }
          return n;
        });
        const n = run();
        if (n) console.log(`迁移: ${n} 个历史时间已由本机时间转换为 UTC`);
      }
      db.prepare("INSERT INTO params(key,value) VALUES ('tz_utc_migrated','1')").run();
    }
  } catch (e) { console.log('迁移 历史时间→UTC:', e.message); }
}

migrateDB();

module.exports = db;
