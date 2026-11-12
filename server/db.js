/**
 * 数据库连接与建表
 *
 * 约定（开发阶段）：不为任何历史数据/旧库/旧备份保留兼容迁移。
 * 结构变更新增的列一律直接写进建表语句；需要时清空库重建即可。
 */
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { DB_PATH, INITIAL_ADMIN_USERNAME, INITIAL_ADMIN_PASSWORD } = require('./config');

// 自动初始化数据库
if (!fs.existsSync(DB_PATH)) {
  console.log('数据库不存在，正在初始化...');
  require('../init-db.js').initDatabase();
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// 多实例共用一个库时，BEGIN IMMEDIATE 的写锁等待上限；超时抛 SQLITE_BUSY 由路由转成 DB_BUSY
db.pragma('busy_timeout = 5000');

// 判断表是否已存在：用于区分「首次建表」和「结构已就绪」，避免每次启动都输出「建表」
const tableExists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

function initSchema() {
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

  // ==================== 物料档案唯一性约束 ====================
  // 唯一键：类别 + 名称 + 规格 + 品牌。比较时 trim 并忽略大小写，空值按空串（COALESCE）。
  // 建索引前先检测重复组：有冲突直接阻断启动并列出记录，不静默跳过、不自动合并。
  const materialIdentityCols = `lower(trim(COALESCE(category,''))), lower(trim(COALESCE(name,''))),
    lower(trim(COALESCE(spec,''))), lower(trim(COALESCE(brand,'')))`;
  const materialDups = db.prepare(`SELECT COUNT(*) cnt, group_concat(code, '、') codes,
      MIN(category) category, MIN(name) name, MIN(spec) spec, MIN(brand) brand
    FROM materials
    GROUP BY ${materialIdentityCols}
    HAVING COUNT(*) > 1`).all();
  if (materialDups.length) {
    const lines = materialDups.map(g => {
      const show = v => String(v || '').trim();
      return `  类别「${show(g.category)}」名称「${show(g.name)}」规格「${show(g.spec)}」品牌「${show(g.brand)}」→ ${g.codes}`;
    }).join('\n');
    throw new Error(`物料档案存在 ${materialDups.length} 组「类别+名称+规格+品牌」重复记录（忽略大小写与首尾空格），无法建立唯一约束：\n${lines}\n请先人工合并或调整这些记录后再启动。`);
  }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_materials_identity'").get()) {
    db.exec(`CREATE UNIQUE INDEX uq_materials_identity ON materials(${materialIdentityCols})`);
    console.log('索引: 物料档案 类别+名称+规格+品牌 唯一');
  }

  // ==================== 入库单据头表 + 修改记录表 ====================
  // 设计要点：
  //  1. inbound_docs 是单据头（一张入库单一行），inbound 明细行通过 doc_no 关联
  //  2. 状态流转：draft（草稿，可编辑）→ posted（已过账，生成库存流水，不可改）→ voided（已作废）
  //  3. 草稿态的 inbound 明细行 status='draft'，不计入库存；
  //     过账后 status='posted'，纳入库存计算
  //  4. 已过账单据不允许直接修改原始记录，应通过「更正（作废重开）」处理
  //  5. inbound_doc_logs 记录单据的操作历史（创建/编辑/确认/作废）
  //  6. 采购退货三档关联：return_tier = inbound（原入库单）/ po（采购单）/ contract（合同）/ none（无原单）
  //  7. 作废重开：voided_* 记录作废信息，corrects_doc_no / corrected_by_doc_no 维护更正链
  const newInboundDocs = !tableExists('inbound_docs');
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
      return_tier TEXT DEFAULT '',
      origin_doc_no TEXT DEFAULT '',
      return_ref_no TEXT DEFAULT '',
      return_reason TEXT DEFAULT '',
      voided_at TEXT DEFAULT '',
      voided_by TEXT DEFAULT '',
      corrects_doc_no TEXT DEFAULT '',
      corrected_by_doc_no TEXT DEFAULT ''
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS inbound_doc_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no TEXT NOT NULL,
      action TEXT NOT NULL,
      operator TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      detail_json TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_ibdoclog_no ON inbound_doc_logs(doc_no)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ib_orderline ON inbound(order_line_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ib_docno ON inbound(doc_no)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ib_originline ON inbound(origin_line_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ibd_corrects ON inbound_docs(corrects_doc_no)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ibd_correctedby ON inbound_docs(corrected_by_doc_no)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ibd_voided ON inbound_docs(status)");
    if (newInboundDocs) console.log('建表: 入库单据头表');
  } catch(e) { console.log('建表 入库单据头表:', e.message); }

  // ==================== 出库单据头表 + 修改记录表 ====================
  // 设计要点（与入库单据保持一致）：
  //  1. outbound_docs 是单据头（一张出库单一行），outbound 明细行通过 doc_no 关联
  //  2. 状态流转：draft（草稿，可编辑）→ posted（已过账，生成库存流水，不可改）→ voided（已作废）
  //  3. 草稿态的 outbound 明细行 status='draft'，不计入库存；过账后 status='posted'，纳入库存计算
  //  4. 已过账单据不允许直接修改，只能通过「作废重开」更正
  //  5. outbound_doc_logs 记录单据的操作历史（创建/编辑/确认/作废）
  //  6. 领料退库：origin_doc_no 指向原出库单，明细行 origin_line_id 指向原出库行；无原单时 return_reason 必填
  const newOutboundDocs = !tableExists('outbound_docs');
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
      origin_doc_no TEXT DEFAULT '',
      return_reason TEXT DEFAULT '',
      voided_at TEXT DEFAULT '',
      voided_by TEXT DEFAULT '',
      corrects_doc_no TEXT DEFAULT '',
      corrected_by_doc_no TEXT DEFAULT ''
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS outbound_doc_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no TEXT NOT NULL,
      action TEXT NOT NULL,
      operator TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      detail_json TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_obdoclog_no ON outbound_doc_logs(doc_no)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ob_docno ON outbound(doc_no)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ob_originline ON outbound(origin_line_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_obd_corrects ON outbound_docs(corrects_doc_no)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_obd_correctedby ON outbound_docs(corrected_by_doc_no)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_obd_voided ON outbound_docs(status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_obd_receiver ON outbound_docs(receiver)");
    if (newOutboundDocs) console.log('建表: 出库单据头表');
  } catch(e) { console.log('建表 出库单据头表:', e.message); }

  // ==================== 库存调整 + 库存盘点 ====================
  // 设计要点：
  //  1. 调整是独立流水，不写入 inbound/outbound，避免污染采购与领用统计
  //  2. 库存口径统一为：期初 + Σ入库 - Σ出库 + Σ调整（调整增加为正、减少为负）
  //  3. 盘点按物料维度（不分位置）
  //  4. 盘点行 book_qty 是载入时刻的账面快照，不随后续入出库变化
  //  5. count_qty 为 NULL 表示「未盘」，0 表示实盘为零
  const newStockAdjust = !tableExists('stock_adjustments');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS stock_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      code TEXT NOT NULL,
      qty INTEGER NOT NULL,
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
      book_qty INTEGER NOT NULL DEFAULT 0,
      count_qty INTEGER,
      diff_qty INTEGER,
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
      detail_json TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_stklog_no ON stocktake_logs(stocktake_no)");
    if (newStockAdjust) console.log('建表: 库存调整/盘点表');
  } catch(e) { console.log('建表 库存调整/盘点表:', e.message); }

  // ==================== 采购合同 ====================
  // 设计要点：
  //  1. 合同独立成表，是「按合同查询 / 汇总」与「到货核销」的实体依据
  //  2. 采购单 ↔ 合同是多对多：真实归属以明细行 order_lines.contract_no 为准，
  //     采购单头的 contract_no 仅作新建明细时带出的默认合同
  //  3. 入库明细行记录 order_line_id，把到货精确核销到具体采购明细；
  //     未关联（0）时回退到「采购单 + 物料 + 合同」匹配
  const newContracts = !tableExists('contracts');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_no TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      supplier TEXT NOT NULL DEFAULT '',
      sign_date TEXT NOT NULL DEFAULT '',
      amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      remarks TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_contract_supplier ON contracts(supplier)");
    if (newContracts) console.log('建表: 采购合同表');
  } catch(e) { console.log('建表 采购合同表:', e.message); }

  // ==================== 库存流水账 + 库存余额（成本核算唯一依据） ====================
  // 设计要点（见《库存成本核算统一规则及开发要求》第 5/5.1 章）：
  //  1. stock_ledger 是历史核算的权威依据，余额表只是最新快照
  //  2. 数量 1e6、单价 1e8、金额 1e2，全部整数定点（出入口换算见 services/scaled-db.js）
  //  3. posting_sequence 为「同物料内」稳定核算顺序号，重算时按序重排
  //  4. status: active 有效 / voided 作废（更正后原单流水）
  //  5. cost_basis: CURRENT_AVG 当前均价 / HISTORICAL_AVG 历史正库存均价 / NO_BASIS 从未有过正库存
  const newStockLedger = !tableExists('stock_ledger');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS stock_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL DEFAULT 0,
      code TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT '',
      source_doc_id TEXT NOT NULL DEFAULT '',
      source_line_id INTEGER NOT NULL DEFAULT 0,
      business_type TEXT NOT NULL DEFAULT '',
      business_date TEXT NOT NULL,
      effective_date TEXT NOT NULL DEFAULT '',
      posting_time TEXT NOT NULL DEFAULT '',
      posting_sequence INTEGER NOT NULL DEFAULT 0,
      qty_in INTEGER NOT NULL DEFAULT 0,
      qty_out INTEGER NOT NULL DEFAULT 0,
      amount_in INTEGER NOT NULL DEFAULT 0,
      amount_out INTEGER NOT NULL DEFAULT 0,
      unit_cost INTEGER NOT NULL DEFAULT 0,
      balance_qty INTEGER NOT NULL DEFAULT 0,
      balance_amount INTEGER NOT NULL DEFAULT 0,
      balance_avg_cost INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      correction_of TEXT NOT NULL DEFAULT '',
      return_source_line_id INTEGER NOT NULL DEFAULT 0,
      cost_basis TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (code) REFERENCES materials(code)
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_ledger_code ON stock_ledger(code, status, posting_sequence)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ledger_doc ON stock_ledger(source_type, source_doc_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ledger_date ON stock_ledger(business_date)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ledger_status_date ON stock_ledger(status, business_date)");

    db.exec(`CREATE TABLE IF NOT EXISTS stock_balance (
      code TEXT PRIMARY KEY,
      material_id INTEGER NOT NULL DEFAULT 0,
      stock_qty INTEGER NOT NULL DEFAULT 0,
      stock_amount INTEGER NOT NULL DEFAULT 0,
      avg_cost INTEGER NOT NULL DEFAULT 0,
      last_posting_sequence INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (code) REFERENCES materials(code)
    )`);

    // 更正重算日志（第 6.4 章）
    db.exec(`CREATE TABLE IF NOT EXISTS inventory_recalc_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      original_doc TEXT NOT NULL DEFAULT '',
      new_doc TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL DEFAULT '',
      start_sequence INTEGER NOT NULL DEFAULT 0,
      end_sequence INTEGER NOT NULL DEFAULT 0,
      qty_before INTEGER NOT NULL DEFAULT 0,
      amount_before INTEGER NOT NULL DEFAULT 0,
      qty_after INTEGER NOT NULL DEFAULT 0,
      amount_after INTEGER NOT NULL DEFAULT 0,
      affected_rows INTEGER NOT NULL DEFAULT 0,
      operator TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ok',
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_recalc_task ON inventory_recalc_logs(task_id)");

    // 成本差异台账（2026-11）：数量归零时账面残留金额的去向记录
    // 平时如实记录、期末一次性结转；结转只改状态，不动库存数量/金额/均价。
    // 每条都绑定触发它的流水行（ledger_id）与来源单据，不允许无来源条目。
    db.exec(`CREATE TABLE IF NOT EXISTS cost_variances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_id INTEGER NOT NULL DEFAULT 0,
      code TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT '',
      source_doc_id TEXT NOT NULL DEFAULT '',
      source_line_id INTEGER NOT NULL DEFAULT 0,
      business_type TEXT NOT NULL DEFAULT '',
      business_date TEXT NOT NULL DEFAULT '',
      qty INTEGER NOT NULL DEFAULT 0,
      unit_cost INTEGER NOT NULL DEFAULT 0,
      avg_cost INTEGER NOT NULL DEFAULT 0,
      amount INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      settle_batch TEXT NOT NULL DEFAULT '',
      settled_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_cv_status ON cost_variances(status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_cv_code ON cost_variances(code)");
    // 同一流水行最多只保留一条「未结转」差异；已结转的是历史快照，可有多条
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_cv_ledger_open ON cost_variances(ledger_id) WHERE status='open'");
    if (newStockLedger) console.log('建表: 库存流水/余额/成本差异表');
  } catch (e) { console.log('建表 库存流水表:', e.message); }

  // 初始管理员账号：用户名/密码取自配置（环境变量可覆盖），未配置时使用默认值 admin / admin123
  const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  if (adminCount === 0) {
    db.prepare(`INSERT INTO users (username, password_hash, name, role, must_change_pwd)
                VALUES (?,?,?,?,1)`).run(INITIAL_ADMIN_USERNAME, bcrypt.hashSync(INITIAL_ADMIN_PASSWORD, 10), '系统管理员', 'admin');
    console.log(`已创建初始管理员账号: ${INITIAL_ADMIN_USERNAME}（首次登录需修改密码；密码默认 admin123，可用环境变量 INITIAL_ADMIN_PASSWORD 覆盖）`);
  }

  // ==================== 系统审计日志 ====================
  // 记录"谁在什么时间做了什么"（登录/新增/修改/删除/确认/作废/更正）
  // created_at 统一存 UTC，前端按浏览器本地时区渲染
  const newAuditLogs = !tableExists('audit_logs');
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
      detail TEXT DEFAULT '',
      detail_json TEXT DEFAULT ''
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(username)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs(module)");
    if (newAuditLogs) console.log('建表: 系统审计日志表');
  } catch (e) { console.log('建表 审计日志表:', e.message); }

  console.log('数据库结构已就绪');
}

initSchema();

// 对外统一导出「带定点换算」的数据库对象：
// 库里存整数定点，路由/业务层继续使用普通数字（元 / 件），换算只发生在出入口。
const { wrapDb } = require('./services/scaled-db');
module.exports = wrapDb(db);
